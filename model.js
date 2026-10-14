// Lanelet2 entities stay shared by ID. History records only changed entities.
const EPS = 1e-8;
const clone = value => structuredClone(value);
const key = value => String(value);
const cross = (a, b) => a.x * b.y - a.y * b.x;
const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y});
const lerp = (a, b, t) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: (a.z || 0) + ((b.z || 0) - (a.z || 0)) * t});
const finite = n => typeof n === 'number' && Number.isFinite(n);
const MERGE_SOURCE_TAGS = new Set([
  'link_id', 'link_ids', 'additional_source_link_ids', 'source_link_ids', 'reverse_link_id', 'shared_link_id', 'shared_link_ids',
  'station_start', 'station_end', 'reverse_station_start', 'reverse_station_end', 'shared_link_station_start', 'shared_link_station_end', 'source_station_range',
  'from_node', 'to_node', 'reverse_from_node', 'reverse_to_node', 'left_neighbor_link_id', 'right_neighbor_link_id',
  'boundary_id', 'boundary_ids', 'boundary_entity', 'reverse_boundary_id', 'shared_boundary_ids', 'source_group_center_way'
].map(name => 'mgeo:' + name));

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const polylineLength = points => points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
export const polygonArea = points => {if (!points.length) return 0; const origin = points[0]; return points.reduce((sum, p, i) => {const q = points[(i + 1) % points.length]; return sum + (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y);}, 0) / 2;};

export function pointAtFraction(points, fraction) {
  if (points.length < 2 || !finite(fraction) || fraction < 0 || fraction > 1) throw Error('유효한 선과 0~1 사이 위치가 필요합니다.');
  const total = polylineLength(points);
  if (total < EPS) throw Error('길이가 0인 경계입니다.');
  const target = total * fraction;
  let traversed = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const length = distance(points[i], points[i + 1]);
    if (length > EPS && (traversed + length >= target - EPS || i === points.length - 2)) {
      const t = Math.max(0, Math.min(1, (target - traversed) / length));
      return {...lerp(points[i], points[i + 1], t), segmentIndex: i, t, fraction};
    }
    traversed += length;
  }
  throw Error('경계상의 위치를 계산할 수 없습니다.');
}

export function nearestSegment(point, points) {
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], d = sub(b, a), l2 = d.x * d.x + d.y * d.y;
    const t = l2 ? Math.max(0, Math.min(1, ((point.x - a.x) * d.x + (point.y - a.y) * d.y) / l2)) : 0;
    const projected = lerp(a, b, t), dist = distance(point, projected);
    if (!best || dist < best.distance) best = {...projected, point: projected, segmentIndex: i, t, distance: dist};
  }
  return best;
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (nearestSegment(point, [a, b]).distance < EPS) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => cross(sub(q, p), sub(r, p));
  const on = (p, q, r) => Math.abs(orient(p, q, r)) < EPS && r.x >= Math.min(p.x, q.x) - EPS && r.x <= Math.max(p.x, q.x) + EPS && r.y >= Math.min(p.y, q.y) - EPS && r.y <= Math.max(p.y, q.y) + EPS;
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return (abC * abD < -EPS && cdA * cdB < -EPS) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function selfIntersects(points, closed = true) {
  const n = points.length, count = closed ? n : n - 1;
  // ponytail: quadratic within one lane; use a sweep line if individual lanes reach thousands of vertices.
  for (let i = 0; i < count; i++) for (let j = i + 2; j < count; j++) {
    if (closed && i === 0 && j === count - 1) continue;
    if (segmentsIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
  }
  return false;
}

function lineCuts(points, a, b) {
  const axis = sub(b, a), hits = [];
  let traversed = 0;
  const total = polylineLength(points);
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1], edge = sub(q, p), denominator = cross(edge, axis), length = distance(p, q);
    if (Math.abs(denominator) > EPS) {
      const t = cross(sub(a, p), axis) / denominator;
      if (t >= -EPS && t <= 1 + EPS) {
        const clamped = Math.max(0, Math.min(1, t));
        const hit = {...lerp(p, q, clamped), segmentIndex: i, t: clamped, fraction: (traversed + length * clamped) / total};
        if (!hits.some(h => distance(h, hit) < 1e-6)) hits.push(hit);
      }
    } else if (Math.abs(cross(sub(p, a), axis)) < EPS) {
      throw Error('분할선과 겹치는 경계 구간이 있습니다. 다른 분할 위치를 선택해 주세요.');
    }
    traversed += length;
  }
  return hits;
}

function mergedMetadata(first, second, ignored = []) {
  const result = clone(first), skip = new Set(['id', 'nodes', 'members', 'ndAttributes', ...ignored]);
  for (const [name, value] of Object.entries(second)) {
    if (skip.has(name) || name === 'tagPairs') continue;
    if (name === 'tags' || name === 'osmAttributes') {
      result[name] ||= {};
      for (const [k, v] of Object.entries(value)) {
        if (ignored.includes(k)) continue;
        if (Object.hasOwn(result[name], k) && result[name][k] !== v) throw Error(`속성 ${k}가 서로 달라 병합할 수 없습니다.`);
        result[name][k] = v;
      }
    } else if (name === 'extraChildren') result[name] = [...new Set([...(result[name] || []), ...value])];
    else if (!Object.hasOwn(result, name)) result[name] = clone(value);
    else if (JSON.stringify(result[name]) !== JSON.stringify(value)) throw Error(`메타데이터 ${name}이 서로 달라 병합할 수 없습니다.`);
  }
  if (first.tagPairs || second.tagPairs) {
    result.tagPairs = clone(first.tagPairs || Object.entries(first.tags));
    for (const pair of second.tagPairs || Object.entries(second.tags)) if (!ignored.includes(pair[0]) && !result.tagPairs.some(p => p[0] === pair[0] && p[1] === pair[1])) result.tagPairs.push(clone(pair));
  }
  return result;
}

function mergedSourceMetadata(first, second, sourceTags = MERGE_SOURCE_TAGS) {
  const result = mergedMetadata(first, second, [...sourceTags]);
  // Source stations describe the originals, not the edited lane's length.
  for (const name of sourceTags) {
    const values = [first, second].flatMap(entity => {
      const value = entity.tags[name];
      if (value === undefined) return [];
      const pairs = (entity.tagPairs || []).filter(([tag]) => tag === name).map(([, value]) => value);
      return pairs.length && pairs.at(-1) === value ? pairs : [value];
    });
    if (!values.length) continue;
    result.tags[name] = [...new Set(values.flatMap(value => value.split(';')))].join(';');
    if (result.tagPairs) {
      result.tagPairs = result.tagPairs.filter(([tag]) => tag !== name);
      result.tagPairs.push([name, result.tags[name]]);
    }
  }
  return result;
}

function directedWay(way, points) {
  const result = {...clone(way), nodes: points.map(p => p.id)};
  if (result.nodes[0] !== way.nodes[0]) {
    if (result.ndAttributes) result.ndAttributes.reverse();
    const left = result.tags['lane_change:left'], right = result.tags['lane_change:right'];
    if (right === undefined) delete result.tags['lane_change:left']; else result.tags['lane_change:left'] = right;
    if (left === undefined) delete result.tags['lane_change:right']; else result.tags['lane_change:right'] = left;
    if (result.tagPairs) result.tagPairs = result.tagPairs.map(([name, value]) => [name === 'lane_change:left' ? 'lane_change:right' : name === 'lane_change:right' ? 'lane_change:left' : name, value]);
    if (['solid_dashed', 'dashed_solid'].includes(result.tags.subtype)) {
      result.tags.subtype = result.tags.subtype === 'solid_dashed' ? 'dashed_solid' : 'solid_dashed';
      if (result.tagPairs) result.tagPairs = result.tagPairs.map(([name, value]) => [name, name === 'subtype' ? result.tags.subtype : value]);
    }
  }
  return result;
}

export class LaneletModel {
  constructor(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.ways) || !Array.isArray(data.relations)) throw Error('nodes, ways, relations 배열이 필요합니다.');
    this.header = clone(Object.fromEntries(Object.entries(data).filter(([name]) => !['nodes', 'ways', 'relations'].includes(name))));
    this.nodes = new Map(); this.ways = new Map(); this.relations = new Map();
    for (const type of ['node', 'way', 'relation']) for (const raw of data[type + 's']) {
      if (raw.id == null) throw Error(`${type} ID가 없습니다.`);
      const entity = {...clone(raw), id: key(raw.id), tags: clone(raw.tags || {})};
      if (this[type + 's'].has(entity.id)) throw Error(`중복 ${type} ID: ${entity.id}`);
      if (type === 'node' && (!finite(entity.x) || !finite(entity.y) || (entity.z != null && !finite(entity.z)))) throw Error(`노드 ${entity.id}의 좌표가 유효하지 않습니다.`);
      if (type === 'way') entity.nodes = (entity.nodes || []).map(key);
      if (type === 'relation') entity.members = (entity.members || []).map(m => ({...m, ref: key(m.ref)}));
      this[type + 's'].set(entity.id, entity);
    }
    this._nextId = -1;
    for (const map of [this.nodes, this.ways, this.relations]) for (const id of map.keys()) if (/^-\d+$/.test(id)) this._nextId = Math.min(this._nextId, Number(id) - 1);
    this._nodeWays = new Map(); this._wayRelations = new Map();
    for (const way of this.ways.values()) this._index('way', way, true);
    for (const relation of this.relations.values()) this._index('relation', relation, true);
    this._history = []; this._future = []; this._active = null;
    this.revision = 0; this._state = 0; this._savedState = 0; this._sequence = 0;
  }
  get lanelets() {return [...this.relations.values()].filter(r => r.tags.type === 'lanelet');}
  get canUndo() {return this._history.length > 0;}
  get canRedo() {return this._future.length > 0;}
  get dirty() {return this._state === this._savedState && !this._active?.changes.size ? 0 : 1;}
  markSaved() {this._savedState = this._state;}
  markUnsaved() {this._savedState = -1;}
  toJSON() {return {...clone(this.header), nodes: [...this.nodes.values()].map(clone), ways: [...this.ways.values()].map(clone), relations: [...this.relations.values()].map(clone)};}
  _map(type) {const name = type.endsWith('s') ? type : type + 's'; if (!['nodes', 'ways', 'relations'].includes(name)) throw Error(`지원하지 않는 객체 종류: ${type}`); return this[name];}
  _get(type, id) {const result = this._map(type).get(key(id)); if (!result) throw Error(`${type} ${id}를 찾을 수 없습니다.`); return result;}
  _id() {return String(this._nextId--);}
  _index(type, entity, add) {
    if (!entity || type === 'node') return;
    const index = type === 'way' ? this._nodeWays : this._wayRelations;
    const refs = type === 'way' ? entity.nodes : entity.members.filter(m => m.type === 'way').map(m => m.ref);
    for (const ref of refs) {let entries = index.get(ref); if (add) {if (!entries) index.set(ref, entries = new Set()); entries.add(entity.id);} else if (entries) {entries.delete(entity.id); if (!entries.size) index.delete(ref);}}
  }
  _write(type, id, entity) {
    type = type.replace(/s$/, ''); id = key(id);
    if (!this._active) throw Error('편집 트랜잭션이 필요합니다.');
    const map = this._map(type), token = type + ':' + id;
    if (!this._active.changes.has(token)) this._active.changes.set(token, {type, id, before: map.has(id) ? clone(map.get(id)) : null});
    this._index(type, map.get(id), false);
    if (entity === null) map.delete(id); else map.set(id, {...clone(entity), id});
    this._index(type, map.get(id), true);
  }
  _apply(changes, field) {
    for (const change of changes) {const map = this._map(change.type); this._index(change.type, map.get(change.id), false); if (change[field] === null) map.delete(change.id); else map.set(change.id, clone(change[field])); this._index(change.type, map.get(change.id), true);}
  }
  beginTransaction(label = '편집') {
    if (this._active) throw Error('이미 진행 중인 편집이 있습니다.');
    this._active = {label, changes: new Map(), nextId: this._nextId, beforeState: this._state};
  }
  commitTransaction() {
    const tx = this._active; if (!tx) return false;
    const changes = [...tx.changes.values()].map(c => ({...c, after: this._map(c.type).has(c.id) ? clone(this._map(c.type).get(c.id)) : null})).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after));
    this._active = null;
    if (!changes.length) return false;
    const afterState = ++this._sequence;
    this._history.push({label: tx.label, changes, beforeState: tx.beforeState, afterState});
    if (this._history.length > 100) this._history.shift();
    this._future.length = 0; this._state = afterState; this.revision++;
    return true;
  }
  rollbackTransaction() {
    if (!this._active) return false;
    this._apply([...this._active.changes.values()], 'before'); this._nextId = this._active.nextId; this._active = null;
    return true;
  }
  transaction(label, fn) {
    if (this._active) return fn(this);
    this.beginTransaction(label);
    try {const result = fn(this); if (result?.then) throw Error('편집 트랜잭션은 동기 함수여야 합니다.'); this.commitTransaction(); return result;} catch (error) {this.rollbackTransaction(); throw error;}
  }
  undo() {if (this._active) throw Error('진행 중인 편집을 먼저 완료해 주세요.'); const tx = this._history.pop(); if (!tx) return false; this._apply(tx.changes, 'before'); this._future.push(tx); this._state = tx.beforeState; this.revision++; return tx.label;}
  redo() {if (this._active) throw Error('진행 중인 편집을 먼저 완료해 주세요.'); const tx = this._future.pop(); if (!tx) return false; this._apply(tx.changes, 'after'); this._history.push(tx); this._state = tx.afterState; this.revision++; return tx.label;}
  bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes.values()) {minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);}
    if (!this.nodes.size) minX = minY = maxX = maxY = 0;
    return {minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY};
  }
  wayPoints(id) {return this._get('way', id).nodes.map(id => this._get('node', id));}
  laneletBounds(id) {
    const relation = this._get('relation', id);
    if (relation.tags.type !== 'lanelet') throw Error(`${id}는 Lanelet이 아닙니다.`);
    const boundary = role => {const members = relation.members.filter(m => m.type === 'way' && m.role === role); if (members.length !== 1) throw Error(`Lanelet ${id}의 ${role} 경계가 하나여야 합니다.`); return this._get('way', members[0].ref);};
    const left = boundary('left'), right = boundary('right');
    let leftPoints = this.wayPoints(left.id), rightPoints = this.wayPoints(right.id);
    if (leftPoints.length < 2 || rightPoints.length < 2) throw Error(`Lanelet ${id}의 경계 점이 부족합니다.`);
    const same = distance(leftPoints[0], rightPoints[0]) + distance(leftPoints.at(-1), rightPoints.at(-1));
    const opposite = distance(leftPoints[0], rightPoints.at(-1)) + distance(leftPoints.at(-1), rightPoints[0]);
    if (opposite < same) rightPoints.reverse();
    if (polygonArea([...leftPoints, ...rightPoints.toReversed()]) > 0) {leftPoints.reverse(); rightPoints.reverse();}
    return {left, right, leftPoints, rightPoints};
  }
  polygon(id) {const {leftPoints, rightPoints} = this.laneletBounds(id); return [...leftPoints, ...rightPoints.toReversed()];}
  _validateLane(id) {
    const {leftPoints, rightPoints} = this.laneletBounds(id), polygon = [...leftPoints, ...rightPoints.toReversed()];
    if (polylineLength(leftPoints) < 0.01 || polylineLength(rightPoints) < 0.01) throw Error(`Lanelet ${id}: 경계 길이가 너무 짧습니다.`);
    if (Math.abs(polygonArea(polygon)) < 0.001 || distance(leftPoints[0], rightPoints[0]) < 0.01 || distance(leftPoints.at(-1), rightPoints.at(-1)) < 0.01) throw Error(`Lanelet ${id}: 폭이 0이거나 면적이 없습니다.`);
    if (selfIntersects(polygon)) throw Error(`Lanelet ${id}: 경계가 교차하거나 자체 교차합니다.`);
  }
  moveNode(id, position) {
    return this.transaction('점 이동', () => {
      const node = {...this._get('node', id)}, p = {...node, ...position};
      if (!finite(p.x) || !finite(p.y) || (p.z != null && !finite(p.z))) throw Error('좌표는 유한한 숫자여야 합니다.');
      node.x = p.x; node.y = p.y; if (p.z != null) node.z = p.z;
      if (node.x !== this.nodes.get(key(id)).x || node.y !== this.nodes.get(key(id)).y) {delete node.lat; delete node.lon;}
      this._write('node', id, node); return node;
    });
  }
  setTags(type, id, patch) {
    return this.transaction('속성 변경', () => {
      const entity = clone(this._get(type, id));
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('속성은 키와 값으로 입력해 주세요.');
      const changedKeys = new Set(Object.entries(patch).filter(([name, value]) => value == null ? Object.hasOwn(entity.tags, name) : entity.tags[name] !== String(value)).map(([name]) => name));
      for (const [name, value] of Object.entries(patch)) {if (!name.trim()) throw Error('속성 이름이 비어 있습니다.'); if (value == null) delete entity.tags[name]; else entity.tags[name] = String(value);}
      if (entity.tagPairs) {entity.tagPairs = entity.tagPairs.filter(([name]) => !changedKeys.has(name)); for (const name of changedKeys) if (entity.tags[name] != null) entity.tagPairs.push([name, entity.tags[name]]);}
      this._write(type, id, entity); return entity;
    });
  }
  insertVertex(wayId, segmentIndex, t = 0.5) {
    return this.transaction('경계 점 추가', () => {
      const way = clone(this._get('way', wayId));
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= way.nodes.length - 1 || !finite(t) || t < 0 || t > 1) throw Error('유효한 경계 구간과 0~1 사이 위치가 필요합니다.');
      if (t < EPS) return way.nodes[segmentIndex]; if (t > 1 - EPS) return way.nodes[segmentIndex + 1];
      const id = this._id(), node = {id, ...lerp(this.nodes.get(way.nodes[segmentIndex]), this.nodes.get(way.nodes[segmentIndex + 1]), t), tags: {}};
      this._write('node', id, node); way.nodes.splice(segmentIndex + 1, 0, id); if (way.ndAttributes) way.ndAttributes.splice(segmentIndex + 1, 0, {}); this._write('way', wayId, way); return id;
    });
  }
  deleteNode(id) {
    return this.transaction('점 삭제', () => {
      id = key(id); this._get('node', id);
      const ways = [...(this._nodeWays.get(id) || [])].map(id => this._get('way', id));
      for (const way of ways) if (new Set(way.nodes.filter(ref => ref !== id)).size < 2) throw Error(`경계 ${way.id}에 최소 두 점이 필요합니다.`);
      if ([...this.relations.values()].some(r => r.members.some(m => m.type === 'node' && m.ref === id))) throw Error('relation이 직접 참조하는 점입니다. 참조를 먼저 정리해 주세요.');
      for (const way of ways) {const updated = {...way, nodes: way.nodes.filter(ref => ref !== id)}; if (way.ndAttributes) updated.ndAttributes = way.ndAttributes.filter((_, i) => way.nodes[i] !== id); this._write('way', way.id, updated);}
      this._write('node', id, null); return true;
    });
  }
  deleteLanelet(id) {
    return this.transaction('Lanelet 삭제', () => {
      this.laneletBounds(id);
      if ([...this.relations.values()].some(r => r.id !== key(id) && r.members.some(m => m.type === 'relation' && m.ref === key(id)))) throw Error('다른 relation이 참조하는 Lanelet입니다. 참조를 먼저 정리해 주세요.');
      this._write('relation', id, null); return true;
    });
  }
  setLaneletBoundary(id, role, wayId) {
    return this.transaction('공유 경계 지정', () => {
      if (!['left', 'right'].includes(role)) throw Error('경계 역할은 left 또는 right여야 합니다.');
      this.laneletBounds(id); this._get('way', wayId);
      const relation = this._get('relation', id), updated = {...relation, members: relation.members.map(m => m.type === 'way' && m.role === role ? {...m, ref: key(wayId)} : m)};
      this._write('relation', id, updated); this._validateLane(id); return key(id);
    });
  }
  setLaneletLaneChange(id, side, value) {
    if (!['left', 'right'].includes(side)) throw Error('차선 변경 방향은 left 또는 right여야 합니다.');
    if (!['yes', 'no', null].includes(value)) throw Error('차선 변경 값은 yes, no 또는 null이어야 합니다.');
    const bounds = this.laneletBounds(id), way = bounds[side], forward = way.nodes[0] === bounds[side + 'Points'][0].id;
    const crossingSide = forward ? side : side === 'left' ? 'right' : 'left';
    this.setTags('way', way.id, {['lane_change:' + crossingSide]: value});
    return way.id;
  }
  connectLaneletNeighbor(id, side, neighborId) {
    return this.transaction('좌우 Lanelet 연결', () => {
      if (!['left', 'right'].includes(side)) throw Error('연결 방향은 left 또는 right여야 합니다.');
      if (key(id) === key(neighborId)) throw Error('다른 Lanelet을 연결 대상으로 선택해 주세요.');
      const selected = this.laneletBounds(id), neighbor = this.laneletBounds(neighborId), opposite = side === 'left' ? 'right' : 'left';
      this._validateLane(neighborId);
      const a = selected[side + 'Points'], b = neighbor[opposite + 'Points'];
      if ((a.at(-1).x - a[0].x) * (b.at(-1).x - b[0].x) + (a.at(-1).y - a[0].y) * (b.at(-1).y - b[0].y) <= 0) throw Error('같은 진행 방향인 Lanelet만 연결할 수 있습니다.');
      this.setLaneletBoundary(id, side, neighbor[opposite].id);
      if (this.laneletBounds(id)[side + 'Points'][0].id !== b[0].id) throw Error('대상 경계가 선택 Lanelet의 요청한 쪽에 있지 않아 같은 방향으로 연결할 수 없습니다.');
      return key(neighborId);
    });
  }
  weldNodes(sourceId, targetId) {
    return this.transaction('점 ID 결합', () => {
      sourceId = key(sourceId); targetId = key(targetId);
      const source = this._get('node', sourceId), target = this._get('node', targetId);
      if (sourceId === targetId) return targetId;
      const combined = mergedMetadata(target, source, ['x', 'y', 'z', 'lat', 'lon', 'local_x', 'local_y', 'local_z', 'ele']);
      const affected = new Set();
      for (const wayId of [...(this._nodeWays.get(sourceId) || [])]) {
        const way = this._get('way', wayId), updated = {...clone(way), nodes: []};
        if (way.ndAttributes) updated.ndAttributes = [];
        for (let i = 0; i < way.nodes.length; i++) {
          const id = way.nodes[i] === sourceId ? targetId : way.nodes[i];
          if (updated.nodes.at(-1) === id) {
            if (way.ndAttributes) {const existing = updated.ndAttributes.at(-1); for (const [k, v] of Object.entries(way.ndAttributes[i])) {if (Object.hasOwn(existing, k) && existing[k] !== v) throw Error(`경계 ${wayId}의 점 메타데이터가 서로 다릅니다.`); existing[k] = v;}}
            continue;
          }
          updated.nodes.push(id); if (way.ndAttributes) updated.ndAttributes.push(clone(way.ndAttributes[i]));
        }
        if (new Set(updated.nodes).size < 2) throw Error(`결합하면 경계 ${wayId}에 두 점 미만이 남습니다.`);
        for (const relationId of this._wayRelations.get(wayId) || []) if (this.relations.get(relationId)?.tags.type === 'lanelet') affected.add(relationId);
        this._write('way', wayId, updated);
      }
      for (const relation of this.relations.values()) if (relation.members.some(m => m.type === 'node' && m.ref === sourceId)) this._write('relation', relation.id, {...relation, members: relation.members.map(m => m.type === 'node' && m.ref === sourceId ? {...m, ref: targetId} : m)});
      this._write('node', targetId, combined); this._write('node', sourceId, null);
      for (const relationId of affected) this._validateLane(relationId);
      return targetId;
    });
  }
  mergeLaneletChain(ids) {
    return this.transaction('선택 Lanelet 병합', () => {
      const remaining = new Set(ids.map(key));
      if (remaining.size < 2) throw Error('Lanelet을 두 개 이상 선택해 주세요.');
      const graph = this.topology().lanes;
      const starts = [...remaining].filter(id => !(graph.get(id)?.predecessors || []).some(p => remaining.has(p)));
      if (starts.length !== 1) throw Error('같은 방향으로 연결된 한 줄의 Lanelet을 선택해 주세요.');
      const order = [starts[0]]; remaining.delete(starts[0]);
      while (remaining.size) {
        const next = (graph.get(order.at(-1))?.successors || []).filter(id => remaining.has(id));
        if (next.length !== 1) throw Error('선택에 끊어진 구간 또는 분기점이 있습니다.');
        order.push(next[0]); remaining.delete(next[0]);
      }
      for (const id of order.slice(1)) this.mergeLanelets(order[0], id);
      return order[0];
    });
  }
  mergeLanelets(firstId, secondId) {
    return this.transaction('연속 Lanelet 병합', () => {
      firstId = key(firstId); secondId = key(secondId);
      if (firstId === secondId) throw Error('서로 다른 연속 Lanelet 두 개가 필요합니다.');
      const first = this._get('relation', firstId), second = this._get('relation', secondId), a = this.laneletBounds(firstId), b = this.laneletBounds(secondId);
      if (a.leftPoints.at(-1).id !== b.leftPoints[0].id || a.rightPoints.at(-1).id !== b.rightPoints[0].id) throw Error('첫 Lanelet의 끝과 두 번째 시작의 좌우 점 ID가 모두 일치해야 합니다.');
      const others = relation => relation.members.filter(m => m.type !== 'way' || !['left', 'right'].includes(m.role));
      if (first.members.some(m => m.role === 'centerline') || second.members.some(m => m.role === 'centerline')) throw Error('명시적인 centerline이 있는 Lanelet은 자동 병합할 수 없습니다.');
      if (JSON.stringify(others(first)) !== JSON.stringify(others(second))) throw Error('경계 외 relation 구성원이 서로 달라 자동 병합할 수 없습니다.');
      if ([...this.relations.values()].some(r => r.members.some(m => m.type === 'relation' && [firstId, secondId].includes(m.ref)))) throw Error('다른 relation이 참조하는 Lanelet은 자동 병합할 수 없습니다.');
      for (const way of [a.left, a.right, b.left, b.right]) if ([...(this._wayRelations.get(way.id) || [])].some(id => id !== firstId && id !== secondId)) throw Error('이웃과 공유하거나 다른 relation이 참조하는 경계는 자동 병합할 수 없습니다.');
      for (const tag of new Set([...Object.keys(first.tags), ...Object.keys(second.tags)])) if (!MERGE_SOURCE_TAGS.has(tag) && first.tags[tag] !== second.tags[tag]) throw Error(`Lanelet 속성 ${tag}가 서로 달라 병합할 수 없습니다.`);
      const relation = mergedSourceMetadata(first, second), replacement = new Map();
      for (const side of ['left', 'right']) {
        const wa = directedWay(a[side], a[side + 'Points']), wb = directedWay(b[side], b[side + 'Points']);
        const allKeys = new Set([...Object.keys(wa.tags), ...Object.keys(wb.tags)]);
        const sourceTags = new Set(MERGE_SOURCE_TAGS);
        if ([wa, wb].every(w => !['original', 'original_centerline'].includes(w.tags['mgeo:geometry']))) sourceTags.add('mgeo:geometry');
        // Virtual lines ignore original paint, while stop-line/reference classifiers stay active.
        if ([wa, wb].every(w => w.tags.type === 'virtual' && String(w.tags['mgeo:lane_type']) !== '530')) for (const name of ['mgeo:lane_shape', 'mgeo:lane_type', 'mgeo:lane_width']) sourceTags.add(name);
        if ([...allKeys].some(k => !sourceTags.has(k) && wa.tags[k] !== wb.tags[k])) throw Error(`${side} 경계 속성이 달라 하나의 선으로 병합할 수 없습니다.`);
        const combined = mergedSourceMetadata(wa, wb, sourceTags), id = this._id();
        combined.id = id; combined.nodes = [...wa.nodes, ...wb.nodes.slice(1)];
        if (wa.ndAttributes || wb.ndAttributes) {
          const aa = wa.ndAttributes || wa.nodes.map(() => ({})), bb = wb.ndAttributes || wb.nodes.map(() => ({}));
          const seam = {...aa.at(-1)}; for (const [k, v] of Object.entries(bb[0])) {if (Object.hasOwn(seam, k) && seam[k] !== v) throw Error('연결 점의 메타데이터가 서로 다릅니다.'); seam[k] = v;}
          combined.ndAttributes = [...aa.slice(0, -1), seam, ...bb.slice(1)];
        }
        this._write('way', id, combined); replacement.set(side, id);
      }
      relation.members = first.members.map(m => m.type === 'way' && replacement.has(m.role) ? {...m, ref: replacement.get(m.role)} : clone(m));
      this._write('relation', firstId, relation); this._write('relation', secondId, null); this._validateLane(firstId);
      return firstId;
    });
  }
  createLanelet(centerPoints, width = 3.5) {
    return this.transaction('Lanelet 생성', () => {
      if (!Array.isArray(centerPoints) || centerPoints.length < 2 || !finite(width) || width < 0.05) throw Error('중심점 두 개 이상과 0.05m 이상의 폭이 필요합니다.');
      const centers = centerPoints.map(p => Array.isArray(p) ? {x: p[0], y: p[1], z: p[2] || 0} : p);
      if (centers.some(p => !finite(p.x) || !finite(p.y) || (p.z != null && !finite(p.z)))) throw Error('중심선 좌표가 유효하지 않습니다.');
      const directions = centers.slice(1).map((p, i) => {const length = distance(p, centers[i]); if (length < 0.01) throw Error('연속 중심점의 거리가 너무 짧습니다.'); return {x: (p.x - centers[i].x) / length, y: (p.y - centers[i].y) / length};});
      const left = [], right = [];
      for (let i = 0; i < centers.length; i++) {
        const previous = directions[Math.max(0, i - 1)], next = directions[Math.min(i, directions.length - 1)];
        const sum = {x: previous.x + next.x, y: previous.y + next.y}, norm = Math.hypot(sum.x, sum.y);
        if (norm < 0.1) throw Error('중심선이 너무 급하게 되돌아갑니다.');
        const normal = {x: -sum.y / norm, y: sum.x / norm}, denominator = normal.x * -previous.y + normal.y * previous.x;
        if (denominator < 0.25) throw Error('급격한 굴곡입니다. 중심점을 추가하거나 폭을 줄여 주세요.');
        const offset = width / 2 / denominator;
        for (const [side, sign] of [[left, 1], [right, -1]]) {const id = this._id(); this._write('node', id, {id, x: centers[i].x + sign * normal.x * offset, y: centers[i].y + sign * normal.y * offset, z: centers[i].z || 0, tags: {}}); side.push(id);}
      }
      const leftId = this._id(), rightId = this._id(), id = this._id();
      this._write('way', leftId, {id: leftId, nodes: left, tags: {type: 'line_thin', subtype: 'solid'}});
      this._write('way', rightId, {id: rightId, nodes: right, tags: {type: 'line_thin', subtype: 'dashed'}});
      this._write('relation', id, {id, members: [{type: 'way', ref: leftId, role: 'left'}, {type: 'way', ref: rightId, role: 'right'}], tags: {type: 'lanelet', subtype: 'road', location: 'urban', one_way: 'yes'}});
      this._validateLane(id); return id;
    });
  }
  createAdjacentLanelet(id, side = 'right', width = 3.5) {
    return this.transaction('인접 Lanelet 생성', () => {
      if (!['left', 'right'].includes(side)) throw Error('생성 방향은 left 또는 right여야 합니다.');
      if (!finite(width) || width < 0.05) throw Error('0.05m 이상의 유한한 차선 폭이 필요합니다.');
      const source = this._get('relation', id), bounds = this.laneletBounds(id), inner = bounds[side], points = bounds[side + 'Points'];
      const neighborId = [...(this._wayRelations.get(inner.id) || [])].find(ref => ref !== source.id && this.relations.get(ref).tags.type === 'lanelet' && this.relations.get(ref).members.some(m => m.type === 'way' && m.ref === inner.id && ['left', 'right'].includes(m.role)));
      if (neighborId) throw Error(`이미 ${side === 'left' ? '왼쪽' : '오른쪽'} 인접 Lanelet #${neighborId}이 있습니다.`);
      if (points.some(p => !finite(p.x) || !finite(p.y) || (p.z != null && !finite(p.z)))) throw Error('공유 경계 좌표가 유효하지 않습니다.');
      const directions = points.slice(1).map((p, i) => {const length = distance(p, points[i]); if (length < 0.01) throw Error('연속 경계점의 거리가 너무 짧습니다.'); return {x: (p.x - points[i].x) / length, y: (p.y - points[i].y) / length};});
      const nodes = [], sign = side === 'left' ? 1 : -1;
      for (let i = 0; i < points.length; i++) {
        const previous = directions[Math.max(0, i - 1)], next = directions[Math.min(i, directions.length - 1)];
        const sum = {x: previous.x + next.x, y: previous.y + next.y}, norm = Math.hypot(sum.x, sum.y);
        if (norm < 0.1) throw Error('공유 경계가 너무 급하게 되돌아갑니다.');
        const normal = {x: -sum.y / norm, y: sum.x / norm}, denominator = normal.x * -previous.y + normal.y * previous.x;
        if (denominator < 0.25) throw Error('급격한 굴곡입니다. 경계점을 추가하거나 폭을 줄여 주세요.');
        const offset = width / denominator, x = points[i].x + sign * normal.x * offset, y = points[i].y + sign * normal.y * offset;
        if (!finite(x) || !finite(y)) throw Error('새 경계 좌표가 유효하지 않습니다.');
        const nodeId = this._id(); this._write('node', nodeId, {id: nodeId, x, y, z: points[i].z || 0, tags: {}}); nodes.push(nodeId);
      }
      const outerId = this._id(), newId = this._id();
      this._write('way', outerId, {id: outerId, nodes, tags: {type: 'line_thin', subtype: 'dashed', color: 'white'}});
      const tags = Object.fromEntries(Object.entries(source.tags).filter(([name]) => !name.startsWith('mgeo:') && !name.startsWith('editor:')));
      this._write('relation', newId, {id: newId, members: [{type: 'way', ref: side === 'left' ? outerId : inner.id, role: 'left'}, {type: 'way', ref: side === 'left' ? inner.id : outerId, role: 'right'}], tags});
      this._validateLane(newId); return newId;
    });
  }
  duplicateLanelet(id, dx = 0, dy = 0) {
    return this.transaction('Lanelet 복제', () => {
      if (!finite(dx) || !finite(dy)) throw Error('복제 이동량이 유효하지 않습니다.');
      const source = this._get('relation', id); this.laneletBounds(id);
      const nodes = new Map(), ways = new Map();
      const members = source.members.map(member => {
        if (member.type !== 'way' || !['left', 'right', 'centerline'].includes(member.role)) return clone(member);
        if (!ways.has(member.ref)) {
          const way = this._get('way', member.ref), newId = this._id();
          const nodeIds = way.nodes.map(ref => {if (!nodes.has(ref)) {const nodeId = this._id(), node = {...clone(this._get('node', ref)), id: nodeId}; node.x += dx; node.y += dy; delete node.lat; delete node.lon; this._write('node', nodeId, node); nodes.set(ref, nodeId);} return nodes.get(ref);});
          this._write('way', newId, {...clone(way), id: newId, nodes: nodeIds}); ways.set(member.ref, newId);
        }
        return {...member, ref: ways.get(member.ref)};
      });
      const newId = this._id(); this._write('relation', newId, {...clone(source), id: newId, members}); this._validateLane(newId); return newId;
    });
  }
  reverseLanelet(id) {
    return this.transaction('주행 방향 반전', () => {
      const source = this._get('relation', id), bounds = this.laneletBounds(id);
      const members = source.members.map(member => {
        if (member.type !== 'way' || !['left', 'right', 'centerline'].includes(member.role)) return clone(member);
        const way = this._get('way', member.ref), newId = this._id();
        const points = member.role === 'left' ? bounds.leftPoints : member.role === 'right' ? bounds.rightPoints : this.wayPoints(member.ref);
        const reversed = {...directedWay(way, points.toReversed()), id: newId};
        this._write('way', newId, reversed);
        return {...member, ref: newId, role: member.role === 'left' ? 'right' : member.role === 'right' ? 'left' : member.role};
      });
      this._write('relation', id, {...source, members}); this._validateLane(id); return key(id);
    });
  }
  extendLanelet(id, length, end = 'end') {
    return this.transaction('Lanelet 연장', () => {
      if (!finite(length) || length < 0.05 || !['start', 'end'].includes(end)) throw Error('0.05m 이상의 연장 길이와 start/end 방향이 필요합니다.');
      const source = this._get('relation', id), bounds = this.laneletBounds(id), start = end === 'start';
      if (source.members.some(m => m.type === 'way' && m.role === 'centerline')) throw Error('명시적인 centerline을 가진 Lanelet 연장은 지원하지 않습니다. 중심선을 먼저 정리해 주세요.');
      const index = start ? 0 : -1, near = start ? 1 : -2;
      const endpoint = lerp(bounds.leftPoints.at(index), bounds.rightPoints.at(index), 0.5), previous = lerp(bounds.leftPoints.at(near), bounds.rightPoints.at(near), 0.5);
      const norm = distance(endpoint, previous); if (norm < EPS) throw Error('끝부분의 진행 방향을 결정할 수 없습니다.');
      const dx = (endpoint.x - previous.x) / norm * length, dy = (endpoint.y - previous.y) / norm * length;
      const members = source.members.map(member => {
        if (member.type !== 'way' || !['left', 'right'].includes(member.role)) return clone(member);
        const points = member.role === 'left' ? bounds.leftPoints : bounds.rightPoints, oldNode = points.at(index), nodeId = this._id(), wayId = this._id();
        this._write('node', nodeId, {id: nodeId, x: oldNode.x + dx, y: oldNode.y + dy, z: oldNode.z || 0, tags: {}});
        const original = this._get('way', member.ref), extended = {...directedWay(original, points), id: wayId, nodes: start ? [nodeId, oldNode.id] : [oldNode.id, nodeId]};
        if (original.ndAttributes) {const endpointAttrs = original.ndAttributes[original.nodes.indexOf(oldNode.id)]; extended.ndAttributes = start ? [{}, clone(endpointAttrs)] : [clone(endpointAttrs), {}];}
        this._write('way', wayId, extended);
        return {...member, ref: wayId};
      });
      const newId = this._id(); this._write('relation', newId, {...clone(source), id: newId, members}); this._validateLane(newId); return newId;
    });
  }
  splitLanelet(id, fraction = 0.5) {
    return this.transaction('공유 경계와 Lanelet 분할', () => {
      id = key(id);
      if (!finite(fraction) || fraction <= 0.001 || fraction >= 0.999) throw Error('분할 위치는 0.1%~99.9% 사이여야 합니다.');
      const selected = this.laneletBounds(id), cutLeft = pointAtFraction(selected.leftPoints, fraction), cutRight = pointAtFraction(selected.rightPoints, fraction);
      if (distance(cutLeft, cutRight) < 0.01) throw Error('분할선의 폭이 너무 좁습니다.');
      const queue = [id], affected = new Map(), cuts = new Map();
      while (queue.length) {
        const laneId = queue.shift(); if (affected.has(laneId)) continue;
        const boundary = this.laneletBounds(laneId), relation = this._get('relation', laneId);
        if (relation.members.some(m => m.type === 'way' && m.role === 'centerline')) throw Error(`Lanelet ${laneId}에 명시적인 centerline이 있어 자동 분할할 수 없습니다.`);
        if ([...this.relations.values()].some(r => r.members.some(m => m.type === 'relation' && m.ref === laneId))) throw Error(`Lanelet ${laneId}를 다른 relation이 참조합니다. 참조 의미를 확인해야 분할할 수 있습니다.`);
        affected.set(laneId, {relation: clone(relation), boundary});
        for (const [way, points] of [[boundary.left, boundary.leftPoints], [boundary.right, boundary.rightPoints]]) {
          const forward = points[0].id === way.nodes[0];
          if (cuts.has(way.id) && cuts.get(way.id).forward !== forward) throw Error(`공유 경계의 Lanelet ${laneId}는 반대 방향입니다. 자동 동시 분할이 불가능합니다.`);
          if (!cuts.has(way.id)) {
            const hits = lineCuts(this.wayPoints(way.id), cutLeft, cutRight);
            if (hits.length !== 1 || hits[0].fraction <= 0.001 || hits[0].fraction >= 0.999) throw Error(`경계 ${way.id}를 한 번만 가로지르는 내부 분할선을 만들 수 없습니다.`);
            cuts.set(way.id, {way: clone(way), hit: hits[0], forward});
          }
          for (const neighborId of this._wayRelations.get(way.id) || []) {
            const neighbor = this._get('relation', neighborId);
            if (neighbor.tags.type === 'lanelet' && neighbor.members.some(m => m.type === 'way' && m.ref === way.id && ['left', 'right'].includes(m.role)) && !affected.has(neighborId)) queue.push(neighborId);
          }
        }
      }
      for (const cut of cuts.values()) {
        const {way, hit} = cut, ids = [...way.nodes], attrs = way.ndAttributes ? clone(way.ndAttributes) : null; let seam, at;
        if (hit.t < EPS) {seam = ids[hit.segmentIndex]; at = hit.segmentIndex;}
        else if (hit.t > 1 - EPS) {seam = ids[hit.segmentIndex + 1]; at = hit.segmentIndex + 1;}
        else {seam = this._id(); this._write('node', seam, {id: seam, x: hit.x, y: hit.y, z: hit.z, tags: {}}); at = hit.segmentIndex + 1; ids.splice(at, 0, seam); if (attrs) attrs.splice(at, 0, {});}
        cut.first = this._id(); cut.second = this._id();
        this._write('way', cut.first, {...way, id: cut.first, nodes: ids.slice(0, at + 1), ...(attrs ? {ndAttributes: attrs.slice(0, at + 1)} : {})});
        this._write('way', cut.second, {...way, id: cut.second, nodes: ids.slice(at), ...(attrs ? {ndAttributes: attrs.slice(at)} : {})});
      }
      const results = new Map();
      for (const [laneId, {relation, boundary}] of affected) {
        const newId = this._id(), halves = [[], []];
        for (const member of relation.members) {
          const cut = member.type === 'way' ? cuts.get(member.ref) : null;
          if (cut && ['left', 'right'].includes(member.role)) {
            const points = member.role === 'left' ? boundary.leftPoints : boundary.rightPoints, forward = points[0].id === cut.way.nodes[0];
            halves[0].push({...member, ref: forward ? cut.first : cut.second}); halves[1].push({...member, ref: forward ? cut.second : cut.first});
          } else if (cut) throw Error(`Lanelet ${laneId}의 ${member.role} 참조를 안전하게 분할할 수 없습니다.`);
          else {halves[0].push(clone(member)); halves[1].push(clone(member));}
        }
        this._write('relation', laneId, {...relation, members: halves[0]}); this._write('relation', newId, {...relation, id: newId, members: halves[1]}); results.set(laneId, [laneId, newId]);
      }
      for (const relation of [...this.relations.values()]) {
        if (relation.tags.type === 'lanelet') continue;
        if (relation.members.some(m => m.type === 'way' && cuts.has(m.ref))) {
          const members = relation.members.flatMap(m => {const cut = m.type === 'way' ? cuts.get(m.ref) : null; return cut ? [{...m, ref: cut.first}, {...m, ref: cut.second}] : [m];});
          this._write('relation', relation.id, {...relation, members});
        }
      }
      for (const cut of cuts.values()) this._write('way', cut.way.id, null);
      for (const pair of results.values()) for (const laneId of pair) this._validateLane(laneId);
      return results.get(id);
    });
  }
  topology() {
    const lanes = new Map(), edges = [], adjacency = [], starts = new Map(), endings = new Map(), boundaryUse = new Map();
    const append = (map, k, value) => {if (!map.has(k)) map.set(k, []); map.get(k).push(value);};
    for (const relation of this.lanelets) {
      const record = {successors: [], predecessors: [], neighbors: [], leftNeighbors: [], rightNeighbors: []}; lanes.set(relation.id, record);
      try {
        const b = this.laneletBounds(relation.id), start = b.leftPoints[0].id + '|' + b.rightPoints[0].id, end = b.leftPoints.at(-1).id + '|' + b.rightPoints.at(-1).id;
        append(starts, start, relation.id); append(endings, end, relation.id);
        append(boundaryUse, b.left.id, {id: relation.id, side: 'left'}); append(boundaryUse, b.right.id, {id: relation.id, side: 'right'});
      } catch { /* Invalid imported lanes remain visible in diagnostics. */ }
    }
    for (const [seam, fromIds] of endings) for (const from of fromIds) for (const to of starts.get(seam) || []) if (from !== to) {lanes.get(from).successors.push(to); lanes.get(to).predecessors.push(from); edges.push({from, to});}
    for (const [way, uses] of boundaryUse) for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
      const a = uses[i], b = uses[j]; if (a.id === b.id) continue;
      for (const [from, to] of [[a, b], [b, a]]) {const lane = lanes.get(from.id); if (!lane.neighbors.includes(to.id)) lane.neighbors.push(to.id); lane[from.side + 'Neighbors'].push(to.id);}
      adjacency.push({from: a.id, to: b.id, way});
    }
    return {lanes, edges, adjacency};
  }
  laneConnections(id, topology = this.topology()) {
    id = key(id); const lane = topology.lanes.get(id);
    if (!lane) return [];
    const edges = [
      ...lane.successors.map(to => ({from:id,to,kind:'successor',status:'connected'})),
      ...lane.predecessors.map(from => ({from,to:id,kind:'predecessor',status:'connected'}))
    ];
    const b = this.laneletBounds(id);
    for (const side of ['left','right']) for (const to of lane[side+'Neighbors']) {
      const way = b[side], points = b[side+'Points'], neighbor = this.laneletBounds(to);
      const otherSide = neighbor.left.id === way.id ? 'left' : 'right';
      const sameDirection = neighbor[otherSide+'Points'][0].id === points[0].id;
      const forward = way.nodes[0] === points[0].id;
      const crossingSide = forward ? side : side === 'left' ? 'right' : 'left';
      const flag = way.tags['lane_change:'+crossingSide] ?? way.tags.lane_change;
      const participant = this.relations.get(to).tags['participant:vehicle'];
      let status = 'unknown', reason = '차선 변경 허용 태그 없음';
      if (!sameDirection || side === otherSide) {status='blocked';reason='반대 방향 또는 같은 쪽 경계 공유';}
      else if (participant === 'no') {status='blocked';reason='차량 통행 불가';}
      else if (flag === 'no') {status='blocked';reason='경계 차선 변경 금지 태그';}
      else if (flag === 'yes') {status='allowed';reason='같은 방향 · 경계 차선 변경 허용 태그';}
      edges.push({from:id,to,kind:side,status,reason,way:way.id});
    }
    return edges;
  }
  diagnostics() {
    const issues = [], usedWays = new Set(), usedNodes = new Set();
    const add = (severity, code, type, id, message) => issues.push({severity, code, type, id, message});
    for (const way of this.ways.values()) {
      if (new Set(way.nodes).size < 2) add('error', 'short_way', 'way', way.id, '경계에 서로 다른 점이 두 개 이상 필요합니다.');
      for (const id of way.nodes) {usedNodes.add(id); if (!this.nodes.has(id)) add('error', 'missing_node', 'way', way.id, `노드 ${id} 참조가 없습니다.`);}
      try {const points = this.wayPoints(way.id); if (polylineLength(points) < 0.01) add('error', 'zero_length', 'way', way.id, '경계 길이가 0에 가깝습니다.'); if (selfIntersects(points, false)) add('error', 'self_intersection', 'way', way.id, '경계가 자체 교차합니다.');} catch { /* Reported missing references above. */ }
    }
    for (const relation of this.relations.values()) {
      for (const member of relation.members) {
        if (member.type === 'way') usedWays.add(member.ref); if (member.type === 'node') usedNodes.add(member.ref);
        if (!['node', 'way', 'relation'].includes(member.type) || !this._map(member.type).has(member.ref)) add('error', 'missing_member', 'relation', relation.id, `${member.type} ${member.ref} 참조가 없습니다.`);
      }
      if (relation.tags.type !== 'lanelet') continue;
      try {
        this._validateLane(relation.id);
        const b = this.laneletBounds(relation.id);
        if (b.left.nodes[0] !== b.leftPoints[0].id || b.right.nodes[0] !== b.rightPoints[0].id) add('info', 'aligned_direction', 'relation', relation.id, '경계 저장 순서가 달라 화면에서 방향을 맞췄습니다. 공유 경계에서는 정상일 수 있습니다.');
        const l = polylineLength(b.leftPoints), r = polylineLength(b.rightPoints);
        if (Math.max(l, r) > Math.min(l, r) * 3) add('warning', 'uneven_boundaries', 'relation', relation.id, '좌우 경계 길이가 크게 다릅니다. 곡선 형상을 확인해 주세요.');
      } catch (error) {add('error', 'invalid_lanelet', 'relation', relation.id, error.message);}
    }
    const orphanWays = [...this.ways.keys()].filter(id => !usedWays.has(id)), orphanNodes = [...this.nodes.keys()].filter(id => !usedNodes.has(id));
    if (orphanWays.length) issues.push({severity: 'info', code: 'unreferenced_ways', type: 'way', id: orphanWays[0], count: orphanWays.length, message: `relation이 참조하지 않는 way ${orphanWays.length}개가 있습니다. 독립 지도 요소일 수 있습니다.`});
    if (orphanNodes.length) issues.push({severity: 'info', code: 'unreferenced_nodes', type: 'node', id: orphanNodes[0], count: orphanNodes.length, message: `다른 요소가 참조하지 않는 node ${orphanNodes.length}개가 있습니다.`});
    return issues;
  }
}
