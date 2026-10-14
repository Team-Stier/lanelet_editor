import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { pointAtFraction } from './model.js?v=20260928-4';

// Triangulate in XY, retaining each original vertex's Z (including slopes).
function polygonGeometry(points) {
  const ring = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y) ring.pop();
  if (ring.length < 3 || ring.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) return null;
  const faces = THREE.ShapeUtils.triangulateShape(ring.map(p => new THREE.Vector2(p.x, p.y)), []);
  if (!faces.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ring.flatMap(p => [p.x, p.y, p.z]), 3));
  geometry.setIndex(faces.flat());
  geometry.computeBoundingSphere();
  return geometry;
}

function release(group) {
  group.traverse(object => {
    object.geometry?.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material?.map?.dispose();
      material?.dispose();
    }
  });
  group.clear();
}

function appendPolygon(batch, id, geometry) {
  const offset = batch.positions.length / 3;
  for (const value of geometry.getAttribute('position').array) batch.positions.push(value);
  for (const index of geometry.index.array) batch.indices.push(offset + index);
  for (let i = 0; i < geometry.index.count; i += 3) batch.faces.push(String(id));
  geometry.dispose();
}

function lineStyle(tags, kind) {
  const virtual = tags?.type === 'virtual';
  const subtype = tags?.subtype || tags?.['mgeo:lane_shape'] || 'solid';
  const reference = kind === 'centerlines' || kind === 'derivedCenter';
  return {
    dashed: kind === 'nativeCenters' || kind === 'storedCenters' || kind === 'stopLines' ? false : reference || virtual || subtype.includes('dashed'),
    mixed: !reference && !virtual && ['solid_dashed', 'dashed_solid'].includes(subtype),
    color: kind === 'nativeCenters' ? '#ff76d5' : kind === 'storedCenters' ? '#ff8be5' : kind === 'stopLines' ? '#ffad55' : kind === 'centerlines' ? '#fa91a9' : kind === 'derivedCenter' ? '#70b9ff' : virtual ? '#b994ec' : ({ yellow: '#ffd651', red: '#ff7777', blue: '#71adff' }[tags?.color] || '#f2f5fa'),
  };
}

function appendLine(batches, kind, points, tags) {
  if (points.length < 2 || points.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) return;
  const style = lineStyle(tags, kind);
  const strokes = [{ ...style, opacity: 1 }];
  if (style.mixed) strokes.push({ ...style, dashed: false, opacity: 0.35 });
  for (const stroke of strokes) {
    const key = `${kind}:${stroke.color}:${stroke.dashed}:${stroke.opacity}`;
    if (!batches.has(key)) batches.set(key, { ...stroke, kind, positions: [], distances: [] });
    const batch = batches.get(key);
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      batch.positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const next = distance + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      batch.distances.push(distance, next);
      distance = next;
    }
  }
}

function lineBatchObject(batch) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
  if (batch.dashed) geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(batch.distances, 1));
  const Material = batch.dashed ? THREE.LineDashedMaterial : THREE.LineBasicMaterial;
  const material = new Material({ color: batch.color, transparent: batch.opacity < 1, opacity: batch.opacity, depthWrite: batch.opacity === 1, ...(batch.dashed ? { dashSize: 2, gapSize: 2 } : {}) });
  return new THREE.LineSegments(geometry, material);
}

export async function create3D(container, { onSelect = () => {}, onStatus = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor('#111821');
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '읽기 전용 3D 지도. 왼쪽 드래그 회전, 오른쪽 드래그 이동, 휠 확대.');
  container.append(renderer.domElement);
  const legend = document.createElement('div');
  legend.style.cssText = 'position:absolute;left:16px;bottom:18px;max-width:330px;padding:9px 12px;background:#111821df;border:1px solid #53657566;border-radius:8px;color:#cad8e5;font:11px/1.65 system-ui;pointer-events:none';
  legend.innerHTML = '<b>3D 선 기호 · 원본 XYZ / 높이 1배</b><br>━━ 실선　┅┅ 점선　<span style="color:#ffd651">━━ 황색</span><br>복합선: 연한 실선 + 진한 점선 · 좌우 순서 생략<br>이중 실선: 단일 실선 기호 · 실제 도색은 메시 참고<br><span style="color:#fa91a9">분홍: 원본 중심</span> · <span style="color:#70b9ff">파랑: 보간 중심</span><br>ID·방향·격자: 2D 전용 · 배경: Z=0 참고 평면';
  container.append(legend);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.screenSpacePanning = false;
  controls.minDistance = 1;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.listenToKeyEvents(renderer.domElement);
  const groups = Object.fromEntries(['polygons', 'boundaries', 'centerlines', 'nativeCenters', 'storedCenters', 'stopLines', 'derivedCenter', 'original', 'background', 'vertices', 'assets'].map(name => [name, new THREE.Group()]));
  scene.add(...Object.values(groups));
  const highlight = new THREE.Group();
  scene.add(highlight);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projectBounds = new THREE.Box3();
  let layers = { polygons: true, boundaries: true, centerlines: false, derivedCenter: false, original: false, background: true, vertices: false, assets: true, opacity: 0.3, backgroundOpacity: 0.75 };
  let selection = null, polygonMesh = null, polygonFaces = [], projectModel = null, disposed = false, request = null, generation = 0, pointerDown = null, frame = 0;
  const render = () => {
    if (disposed || frame || !container.clientWidth || !container.clientHeight) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed || !container.clientWidth || !container.clientHeight) return;
      renderer.render(scene, camera);
      renderer.domElement.dataset.drawCalls = String(renderer.info.render.calls);
      renderer.domElement.dataset.triangles = String(renderer.info.render.triangles);
      renderer.domElement.dataset.drawObjects = String(Object.values(groups).reduce((sum, group) => sum + group.children.length, highlight.children.length));
    });
  };
  controls.addEventListener('change', render);

  function resize() {
    if (disposed) return;
    const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  function fit(selectionOnly = false) {
    let bounds = projectBounds;
    if (selectionOnly && selection && projectModel) {
      try {
        const { type, id } = selection;
        const points = type === 'node' ? [projectModel.nodes.get(String(id))] : type === 'way' ? projectModel.wayPoints(id) : projectModel.polygon(id);
        const selectedBounds = new THREE.Box3();
        for (const p of points) if (p && [p.x, p.y, p.z].every(Number.isFinite)) selectedBounds.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
        if (!selectedBounds.isEmpty()) bounds = selectedBounds;
      } catch { /* A removed or invalid selection falls back to the whole project. */ }
    }
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(camera.aspect, 1));
    const distance = Math.max(radius / Math.sin(halfFov) * 1.12, 20);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.25, -1, 1.1).normalize().multiplyScalar(distance));
    camera.far = Math.max(10000, distance * 8);
    camera.updateProjectionMatrix();
    controls.update();
    render();
  }

  function setSelection(value) {
    selection = value;
    release(highlight);
    if (value && projectModel) try {
      if (value.type === 'relation' && layers.polygons) {
        for (const id of value.ids || [value.id]) {
        const geometry = polygonGeometry(projectModel.polygon(id));
        if (geometry) highlight.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#ffb657', side: THREE.DoubleSide, transparent: true, opacity: Math.max(layers.opacity, 0.65), depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, forceSinglePass: true })));
      }
      } else if (value.type === 'way') {
        const batches = new Map();
        appendLine(batches, 'boundaries', projectModel.wayPoints(value.id), projectModel.ways.get(String(value.id))?.tags);
        for (const batch of batches.values()) highlight.add(lineBatchObject({ ...batch, color: '#ffb657' }));
      } else if (value.type === 'node') {
        const p = projectModel.nodes.get(String(value.id));
        if (p && [p.x, p.y, p.z].every(Number.isFinite)) {
          const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, p.y, p.z)]);
          highlight.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ffb657', size: 8, sizeAttenuation: false })));
        }
      }
    } catch { /* A removed or invalid selection has no highlight. */ }
    if (value?.type === 'relation' && projectModel && layers.connections) {
      const graph=projectModel.topology();
      const midpoint=id=>{const b=projectModel.laneletBounds(id),l=pointAtFraction(b.leftPoints,.5),r=pointAtFraction(b.rightPoints,.5);return new THREE.Vector3((l.x+r.x)/2,(l.y+r.y)/2,(l.z+r.z)/2);};
      for(const id of value.ids || [value.id]) for(const edge of projectModel.laneConnections(id,graph)) {
        const from=midpoint(edge.from),to=midpoint(edge.to),direction=to.clone().sub(from),length=direction.length();
        if(length<.001)continue;
        const color=edge.kind==='successor'?0x66ef90:edge.kind==='predecessor'?0x67baff:edge.status==='allowed'?0xffd36b:edge.status==='blocked'?0xf17979:0xadb5c2;
        highlight.add(new THREE.ArrowHelper(direction.normalize(),from,length,color,Math.min(1,length*.2),Math.min(.5,length*.1)));
      }
    }
    render();
  }

  function setLayers(value) {
    layers = { ...layers, ...value };
    layers.opacity = THREE.MathUtils.clamp(Number(layers.opacity), 0, 1);
    layers.backgroundOpacity = THREE.MathUtils.clamp(Number(layers.backgroundOpacity), 0, 1);
    for (const [name, group] of Object.entries(groups)) group.visible = !!layers[name];
    if (polygonMesh) polygonMesh.material.opacity = layers.opacity;
    for (const object of groups.background.children) object.material.opacity = layers.backgroundOpacity;
    setSelection(selection);
  }

  async function fetchData(url, signal, type = 'arrayBuffer') {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response[type]();
  }

  async function loadMesh(asset, signal, version) {
    const [positionData, indexData] = await Promise.all([fetchData(asset.positionsUrl, signal), fetchData(asset.indicesUrl, signal)]);
    if (disposed || version !== generation) return;
    if (positionData.byteLength % 12 || indexData.byteLength % 12) throw new Error(`${asset.name}: 잘못된 3D 배열`);
    const positions = new Float32Array(positionData), indices = new Uint32Array(indexData);
    if (!positions.length || !positions.every(Number.isFinite) || !indices.every(i => i < positions.length / 3)) throw new Error(`${asset.name}: 잘못된 3D 좌표/인덱스`);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: asset.color || '#555b65', side: THREE.DoubleSide }));
    mesh.name = asset.name;
    groups.assets.add(mesh);
    render();
  }

  async function loadOverview(overview, signal, version) {
    const blob = await fetchData(overview.url, signal, 'blob');
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    if (disposed || version !== generation) { bitmap.close(); return; }
    const bounds = overview.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
      bitmap.close(); throw new Error('배경 이미지 범위가 올바르지 않습니다.');
    }
    const [minX, minY, maxX, maxY] = bounds;
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    texture.addEventListener('dispose', () => bitmap.close());
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, opacity: layers.backgroundOpacity, depthWrite: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxY - minY), material);
    plane.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0);
    groups.background.add(plane);
    render();
  }

  let nativeCenterData=[];
  function setNativeCenterlines(items){
    nativeCenterData=items;release(groups.nativeCenters);const batches=new Map();
    for(const item of items)appendLine(batches,'nativeCenters',item.points,{});
    for(const batch of batches.values())groups.nativeCenters.add(lineBatchObject(batch));
    groups.nativeCenters.visible=!!layers.nativeCenters;render();
  }

  async function setProject(model, assets = {}) {
    if (disposed) return;
    projectModel = model;
    request?.abort();
    request = new AbortController();
    const version = ++generation;
    for (const group of Object.values(groups)) release(group);
    release(highlight); polygonMesh = null; polygonFaces = [];
    projectBounds.makeEmpty();
    for (const node of model.nodes.values()) {
      if ([node.x, node.y, node.z].every(Number.isFinite)) projectBounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
    }
    const storedIds = new Set(), stopIds = new Set(), boundaryIds = new Set(), centerlineIds = new Set(), originalIds = new Set();
    const polygons = { positions: [], indices: [], faces: [] }, lineBatches = new Map();
    let skipped = 0;
    for (const relation of model.lanelets) {
      let geometry = null;
      try { geometry = polygonGeometry(model.polygon(relation.id)); } catch { /* Broken references remain available in model diagnostics. */ }
      if (geometry) appendPolygon(polygons, relation.id, geometry);
      else skipped++;
      for (const member of relation.members) {
        if (member.type !== 'way') continue;
        if (member.role === 'left' || member.role === 'right') boundaryIds.add(String(member.ref));
        if (member.role === 'centerline') storedIds.add(String(member.ref));
      }
      try {
        const bounds = model.laneletBounds(relation.id), points = [];
        for (let i = 0; i <= 25; i++) {
          const left = pointAtFraction(bounds.leftPoints, i / 25), right = pointAtFraction(bounds.rightPoints, i / 25);
          points.push({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, z: (left.z + right.z) / 2 });
        }
        appendLine(lineBatches, 'derivedCenter', points, {});
      } catch { /* Invalid boundaries cannot produce a derived reference centerline. */ }
    }
    for (const way of model.ways.values()) {
      if (way.tags.type === 'stop_line' || String(way.tags['mgeo:lane_type']) === '530') stopIds.add(String(way.id));
      if (boundaryIds.has(String(way.id))) continue;
      if (way.tags['mgeo:geometry'] === 'original_centerline') centerlineIds.add(String(way.id));
      if (way.tags['mgeo:geometry'] === 'original') originalIds.add(String(way.id));
    }
    for (const [name, ids] of [['storedCenters', storedIds], ['stopLines', stopIds], ['boundaries', boundaryIds], ['centerlines', centerlineIds], ['original', originalIds]]) {
      for (const id of ids) {
        const way = model.ways.get(id) || model.ways.get(Number(id));
        if (!way) continue;
        try { appendLine(lineBatches, name, model.wayPoints(way.id), way.tags); } catch { /* Skip a boundary with missing nodes. */ }
      }
    }
    if (polygons.indices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(polygons.positions, 3));
      geometry.setIndex(polygons.indices);
      geometry.computeBoundingSphere();
      // A single fill color needs no per-vertex color buffer; selection is a separate mesh.
      const material = new THREE.MeshBasicMaterial({ color: '#4ec8a1', side: THREE.DoubleSide, transparent: true, opacity: layers.opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, forceSinglePass: true });
      polygonMesh = new THREE.Mesh(geometry, material);
      polygonFaces = polygons.faces;
      groups.polygons.add(polygonMesh);
    }
    for (const batch of lineBatches.values()) groups[batch.kind].add(lineBatchObject(batch));
    const nodeIds = new Set([...boundaryIds].flatMap(id => model.ways.get(id)?.nodes || []));
    const vertices = [...nodeIds].map(id => model.nodes.get(id)).filter(p => p && [p.x, p.y, p.z].every(Number.isFinite));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flatMap(p => [p.x, p.y, p.z]), 3));
    groups.vertices.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ffb657', size: 3, sizeAttenuation: false })));
    setNativeCenterlines(nativeCenterData);
    setLayers(layers);
    resize(); fit();
    const note = '3D 읽기 전용 · 실제 XYZ / 높이 1× · 배경 Z=0 참고 평면 · 복합선은 겹친 선 기호 · ID/방향/격자는 2D 전용 · 보간 중심선은 참고용';
    onStatus(`${note} · 도로 자산 불러오는 중`);
    const tasks = (assets.meshes || []).map(asset => loadMesh(asset, request.signal, version));
    if (assets.overview) tasks.push(loadOverview(assets.overview, request.signal, version));
    const results = await Promise.allSettled(tasks);
    if (disposed || version !== generation) return;
    const failed = results.filter(result => result.status === 'rejected' && result.reason?.name !== 'AbortError');
    onStatus(`${note} · 도로/도색 메시 ${groups.assets.children.length}개${skipped ? ` · 표시 불가 면 ${skipped}개` : ''}${failed.length ? ` · 자산 로드 실패 ${failed.length}개 (${failed[0].reason.message})` : ''}`);
    render();
  }

  function down(event) { pointerDown = { x: event.clientX, y: event.clientY, button: event.button }; }
  function up(event) {
    if (!pointerDown || pointerDown.button !== 0 || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) return;
    pointerDown = null;
    if (!groups.polygons.visible) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = polygonMesh ? raycaster.intersectObject(polygonMesh, false)[0] : null;
    const selected = hit ? { type: 'relation', id: polygonFaces[hit.faceIndex] } : null;
    onSelect(selected, event.shiftKey || event.ctrlKey || event.metaKey);
  }
  renderer.domElement.addEventListener('pointerdown', down);
  renderer.domElement.addEventListener('pointerup', up);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function dispose() {
    disposed = true; generation++; request?.abort(); observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    controls.removeEventListener('change', render); controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', down);
    renderer.domElement.removeEventListener('pointerup', up);
    for (const group of Object.values(groups)) release(group);
    release(highlight);
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); legend.remove();
    polygonMesh = null; polygonFaces = [];
    projectModel = null;
  }

  return { setNativeCenterlines, setProject, setSelection, setLayers, fit, resize, dispose };
}

// Runnable geometry regression check: node view3d.js --self-test
if (typeof process !== 'undefined' && process.argv?.includes('--self-test')) {
  const points = [[0, 0, 1], [4, 0, 2], [4, 4, 3], [2, 2, 4], [0, 4, 5], [0, 0, 1]].map(([x, y, z]) => ({ x, y, z }));
  const geometry = polygonGeometry(points), positions = geometry.getAttribute('position'), indices = geometry.index.array;
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = Array.from(indices.slice(i, i + 3), index => points[index]);
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  if (area !== 12 || positions.count !== 5 || points.slice(0, 5).some((p, i) => positions.getZ(i) !== p.z)) throw new Error('Concave polygon area / original elevation regression');
  if (polygonGeometry([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]) !== null) throw new Error('Degenerate polygon regression');
  const batch = { positions: [], indices: [], faces: [] };
  appendPolygon(batch, 'first', geometry);
  appendPolygon(batch, 'second', polygonGeometry(points.map(p => ({ ...p, x: p.x + 10 }))));
  if (batch.faces.length !== 6 || batch.faces[0] !== 'first' || batch.faces[3] !== 'second' || batch.indices.slice(9).some(i => i < 5) || batch.positions[17] !== 1) throw new Error('Batched polygon picking / vertex offset regression');
  const lines = new Map(), segment = [{ x: 0, y: 0, z: 2 }, { x: 3, y: 0, z: 6 }];
  appendLine(lines, 'boundaries', segment, { subtype: 'dashed', color: 'yellow' });
  appendLine(lines, 'boundaries', segment, { subtype: 'dashed', color: 'yellow' });
  const stroke = [...lines.values()][0];
  if (lines.size !== 1 || stroke.positions.length !== 12 || stroke.distances.join() !== '0,5,0,5') throw new Error('Line batching / per-way dash distance regression');
  appendLine(lines, 'boundaries', segment, { subtype: 'solid_dashed', color: 'yellow' });
  if (lines.size !== 2) throw new Error('Mixed solid and dashed symbol regression');
  for (const line of lines.values()) { const object = lineBatchObject(line); object.geometry.dispose(); object.material.dispose(); }
  console.log('3D checks passed: concave area, original Z, batched face picking, per-way dash distances, mixed line batching.');
}
