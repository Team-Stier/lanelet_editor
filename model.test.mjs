import assert from 'node:assert/strict';
import {LaneletModel, polylineLength, nearestSegment, pointInPolygon, polygonArea} from './model.js';

function fixture() {
  return {
    version: 1, crs: 'EPSG:32652', origin: [302595, 4124145, 0], meta: {survey: 'keep'},
    nodes: [
      {id: '1', x: 0, y: 4, z: 2, tags: {custom: 'node'}, lat: 37, lon: 127},
      {id: '2', x: 20, y: 4, z: 4, tags: {}},
      {id: '3', x: 0, y: 0, z: 2, tags: {}},
      {id: '4', x: 20, y: 0, z: 4, tags: {}},
      {id: '5', x: 0, y: -4, z: 2, tags: {}},
      {id: '6', x: 20, y: -4, z: 4, tags: {}}
    ],
    ways: [
      {id: '10', nodes: ['1', '2'], tags: {type: 'line_thin', subtype: 'solid'}},
      {id: '11', nodes: ['4', '3'], tags: {type: 'line_thick', subtype: 'solid_dashed', custom: 'boundary'}, tagPairs: [['type', 'line_thick'], ['custom', 'a'], ['custom', 'boundary']], osmAttributes: {visible: 'true'}},
      {id: '12', nodes: ['5', '6'], tags: {type: 'line_thin', subtype: 'solid'}}
    ],
    relations: [
      {id: '20', members: [{type: 'way', ref: '10', role: 'left'}, {type: 'way', ref: '11', role: 'right'}], tags: {type: 'lanelet', custom: 'lane-a'}},
      {id: '21', members: [{type: 'way', ref: '11', role: 'left'}, {type: 'way', ref: '12', role: 'right'}], tags: {type: 'lanelet', custom: 'lane-b'}},
      {id: '30', members: [{type: 'way', ref: '11', role: 'ref_line'}], tags: {type: 'regulatory_element', subtype: 'custom'}, extraChildren: ['<custom foo="bar"/>']}
    ]
  };
}

const model = new LaneletModel(fixture());
assert.deepEqual(model.toJSON(), fixture(), 'import/export retains all custom data');
assert.deepEqual(model.laneletBounds('20').rightPoints.map(n => n.id), ['3', '4']);
assert.ok(polygonArea(model.polygon('20')) < 0);
assert.equal(pointInPolygon({x: 5, y: 2}, model.polygon('20')), true);
assert.equal(nearestSegment({x: 5, y: 5}, model.wayPoints('10')).distance, 1);
assert.equal(polylineLength(model.wayPoints('10')), 20);
assert.deepEqual(model.topology().lanes.get('20').rightNeighbors, ['21']);
model.moveNode('3', {x: -1, y: 0.5});
assert.equal(model.laneletBounds('20').rightPoints[0].x, -1);
assert.equal(model.laneletBounds('21').leftPoints[0].x, -1);
assert.equal(model._history.at(-1).changes.length, 1, 'movement records one entity, not the project');
assert.equal(model.dirty, 1);
model.undo(); assert.equal(model.nodes.get('3').x, 0); assert.equal(model.dirty, 0);
model.redo(); assert.equal(model.nodes.get('3').x, -1);
model.undo();
const beforeInvalid = model.toJSON();
assert.throws(() => model.transaction('invalid', () => {model.moveNode('1', {x: 1}); model.moveNode('3', {x: NaN});}), /숫자/);
assert.deepEqual(model.toJSON(), beforeInvalid, 'failed transaction rolls all changes back');
assert.throws(() => model.deleteNode('3'), /두 점/);
assert.deepEqual(model.toJSON(), beforeInvalid);
const inserted = model.insertVertex('11', 0, 0.5);
assert.equal(model.ways.get('11').nodes[1], inserted);
assert.equal(model.laneletBounds('21').leftPoints[1].id, inserted);
model.deleteNode(inserted); assert.equal(model.nodes.has(inserted), false);
model.moveNode('1', {x: -0.1}); assert.equal(model.nodes.get('1').lat, undefined); model.undo();
model.setTags('relation', '20', {speed_limit: '30'});
assert.equal(model.relations.get('20').tags.custom, 'lane-a');
model.undo();
model.setTags('way', '11', {subtype: 'dashed', custom: 'edited'});
assert.deepEqual(model.ways.get('11').tagPairs, [['type', 'line_thick'], ['subtype', 'dashed'], ['custom', 'edited']]);
model.undo();
assert.deepEqual(model.ways.get('11').tagPairs, fixture().ways[1].tagPairs);

const splitModel = new LaneletModel(fixture());
const halves = splitModel.splitLanelet('20', 0.5);
assert.equal(halves[0], '20');
assert.equal(splitModel.lanelets.length, 4);
assert.equal(splitModel.ways.size, 6);
const first = splitModel.laneletBounds(halves[0]), second = splitModel.laneletBounds(halves[1]);
assert.equal(first.leftPoints.at(-1).id, second.leftPoints[0].id);
assert.equal(first.rightPoints.at(-1).id, second.rightPoints[0].id);
const neighborFirst = splitModel.laneletBounds('21');
assert.equal(first.right.id, neighborFirst.left.id, 'neighbors reuse exactly the same first cut way');
const neighborSecondId = splitModel.topology().lanes.get('21').successors[0];
assert.equal(second.right.id, splitModel.laneletBounds(neighborSecondId).left.id, 'neighbors reuse exactly the same second cut way');
assert.equal(splitModel.relations.get('30').members.length, 2, 'non-lanelet relation is updated, not lost');
assert.deepEqual(splitModel.relations.get('30').extraChildren, ['<custom foo="bar"/>']);
assert.equal(first.right.tags.subtype, 'solid_dashed');
assert.deepEqual(first.right.tagPairs, fixture().ways[1].tagPairs);
assert.equal(splitModel.diagnostics().filter(d => d.severity === 'error').length, 0);
splitModel.undo(); assert.deepEqual(splitModel.toJSON(), fixture());
splitModel.redo(); assert.equal(splitModel.lanelets.length, 4);

const extendModel = new LaneletModel(fixture());
const extension = extendModel.extendLanelet('20', 8);
assert.deepEqual(extendModel.topology().lanes.get('20').successors, [extension]);
assert.deepEqual(extendModel.topology().lanes.get(extension).predecessors, ['20']);
const prefix = extendModel.extendLanelet('20', 8, 'start');
assert.deepEqual(extendModel.topology().lanes.get(prefix).successors, ['20']);
const otherBoundaryBefore = clone(extendModel.ways.get('11'));
extendModel.reverseLanelet('20');
assert.deepEqual(extendModel.ways.get('11'), otherBoundaryBefore, 'reverse cannot change a neighbors boundary style or direction');
assert.deepEqual(extendModel.laneletBounds('20').leftPoints.map(n => n.id), ['4', '3']);
assert.equal(extendModel.laneletBounds('20').left.tags.subtype, 'solid_dashed', 'already reverse-stored marking retains its raw orientation');
const marked = new LaneletModel(fixture());
marked.ways.get('11').nodes.reverse();
marked.reverseLanelet('20');
assert.equal(marked.laneletBounds('20').left.tags.subtype, 'dashed_solid', 'reversing the raw way swaps asymmetric markings');
assert.equal(marked.ways.get('11').tags.subtype, 'solid_dashed');

const directionalFixture = fixture();
Object.assign(directionalFixture.ways[1].tags, {'lane_change:left': 'yes', 'lane_change:right': 'no', 'mgeo:lane_shape': 'solid broken'});
directionalFixture.ways[1].tagPairs.push(['lane_change:left', 'no'], ['lane_change:left', 'yes'], ['lane_change:right', 'no'], ['mgeo:lane_shape', 'solid broken']);
directionalFixture.ways[1].ndAttributes = [{survey: 'end'}, {survey: 'start'}];
const directional = new LaneletModel(directionalFixture), directionalBefore = directional.toJSON();
assert.equal(directional.laneConnections('20').find(e => e.to === '21').status, 'allowed');
const directionalExtension = directional.extendLanelet('20', 8), extendedBoundary = directional.laneletBounds(directionalExtension).right;
assert.equal(extendedBoundary.tags['lane_change:left'], 'no', 'extension retains physical crossing permissions when normalizing a reverse-stored boundary');
assert.equal(extendedBoundary.tags['lane_change:right'], 'yes');
assert.deepEqual(extendedBoundary.tagPairs.slice(-4), [['lane_change:right', 'no'], ['lane_change:right', 'yes'], ['lane_change:left', 'no'], ['mgeo:lane_shape', 'solid broken']]);
assert.deepEqual(directional.ways.get('11'), directionalFixture.ways[1], 'extension leaves the shared original boundary unchanged');
const directionalExtended = directional.toJSON();
directional.reverseLanelet(directionalExtension);
const reversedBoundary = directional.laneletBounds(directionalExtension).left;
assert.equal(reversedBoundary.tags['lane_change:left'], 'yes');
assert.equal(reversedBoundary.tags['lane_change:right'], 'no', 'reversal retains physical crossing permissions');
assert.deepEqual(reversedBoundary.tagPairs, directionalFixture.ways[1].tagPairs);
assert.equal(reversedBoundary.tags['mgeo:lane_shape'], 'solid broken');
assert.deepEqual(reversedBoundary.ndAttributes, [{}, {survey: 'end'}]);
assert.deepEqual(directional.ways.get('11'), directionalFixture.ways[1], 'reversal leaves the shared original boundary unchanged');
directional.undo(); assert.deepEqual(directional.toJSON(), directionalExtended);
directional.undo(); assert.deepEqual(directional.toJSON(), directionalBefore);

const laneChangeFixture = fixture();
Object.assign(laneChangeFixture.ways[1].tags, {lane_change: 'yes', 'lane_change:left': 'yes', 'lane_change:right': 'no', 'mgeo:boundary_id': 'shared-source'});
const laneChange = new LaneletModel(laneChangeFixture), laneChangeBefore = laneChange.toJSON();
assert.equal(laneChange.setLaneletLaneChange('20', 'right', 'no'), '11');
assert.equal(laneChange.ways.get('11').tags['lane_change:left'], 'no', 'right crossing on a reverse-stored boundary updates the stored left permission');
assert.equal(laneChange.ways.get('11').tags['lane_change:right'], 'no');
assert.equal(laneChange.laneConnections('20').find(e => e.to === '21').status, 'blocked');
assert.equal(laneChange.laneConnections('21').find(e => e.to === '20').status, 'blocked');
assert.deepEqual(laneChange.toJSON().relations, laneChangeBefore.relations, 'permission editing preserves shared boundary references');
assert.deepEqual(laneChange.ways.get('11').nodes, ['4', '3']);
assert.deepEqual({...laneChange.ways.get('11').tags, 'lane_change:left': 'yes'}, laneChangeFixture.ways[1].tags, 'all other boundary attributes stay unchanged');
assert.deepEqual(laneChange.ways.get('11').tagPairs.filter(([name]) => !name.startsWith('lane_change:')), laneChangeFixture.ways[1].tagPairs);
laneChange.undo(); assert.deepEqual(laneChange.toJSON(), laneChangeBefore);
laneChange.setLaneletLaneChange('21', 'left', 'yes');
assert.equal(laneChange.ways.get('11').tags['lane_change:right'], 'yes', 'the opposite Lanelet crossing updates the other stored permission');
assert.equal(laneChange.ways.get('11').tags['lane_change:left'], 'yes');
assert.equal(laneChange.laneConnections('21').find(e => e.to === '20').status, 'allowed');
assert.equal(laneChange.laneConnections('20').find(e => e.to === '21').status, 'allowed');
laneChange.undo(); assert.deepEqual(laneChange.toJSON(), laneChangeBefore);
laneChange.setLaneletLaneChange('20', 'right', 'no');
const laneChangeBlocked = laneChange.toJSON();
laneChange.setLaneletLaneChange('20', 'right', null);
assert.equal(Object.hasOwn(laneChange.ways.get('11').tags, 'lane_change:left'), false);
assert.equal(laneChange.ways.get('11').tags.lane_change, 'yes');
assert.equal(laneChange.laneConnections('20').find(e => e.to === '21').status, 'allowed', 'removing the directional override restores the global permission');
assert.equal(laneChange.laneConnections('21').find(e => e.to === '20').status, 'blocked');
laneChange.undo(); assert.deepEqual(laneChange.toJSON(), laneChangeBlocked);
laneChange.undo(); assert.deepEqual(laneChange.toJSON(), laneChangeBefore);
assert.throws(() => laneChange.setLaneletLaneChange('20', 'up', 'yes'), /left.*right/);
assert.throws(() => laneChange.setLaneletLaneChange('20', 'right', 'maybe'), /yes.*no/);
assert.deepEqual(laneChange.toJSON(), laneChangeBefore, 'invalid permission edits do not change the model');

for (const [tag, opposite] of [['lane_change:left', 'lane_change:right'], ['lane_change:right', 'lane_change:left']]) {
  const data = fixture(); data.ways[1].nodes.reverse();
  data.ways[1].tags[tag] = 'yes'; data.ways[1].tagPairs.push([tag, 'yes']);
  const singleDirection = new LaneletModel(data);
  singleDirection.reverseLanelet('20');
  const boundary = singleDirection.laneletBounds('20').left;
  assert.equal(boundary.tags[tag], undefined, 'a one-sided crossing permission leaves its previous side');
  assert.equal(boundary.tags[opposite], 'yes');
  assert.deepEqual(boundary.tagPairs.at(-1), [opposite, 'yes']);
  singleDirection.undo(); assert.deepEqual(singleDirection.toJSON(), data);
}

for (const [sourceId, side, width, expectedY, sharedId] of [['20', 'left', 4, 8, '10'], ['21', 'right', 3.5, -7.5, '12'], ['20', 'right', 3, -3, '11']]) {
  const data = fixture();
  if (sharedId === '11') data.relations = data.relations.filter(r => r.id !== '21');
  const source = data.relations.find(r => r.id === sourceId);
  source.tags = {type: 'lanelet', subtype: 'road', one_way: 'yes', speed_limit: '40 km/h', 'participant:vehicle': 'yes', 'mgeo:link_id': 'source-link', 'editor:repair': 'source-only'};
  source.members.push({type: 'way', ref: '10', role: 'centerline'}, {type: 'relation', ref: '30', role: 'regulatory_element'});
  Object.assign(data.ways.find(w => w.id === sharedId).tags, {'lane_change:left': 'yes', 'lane_change:right': 'yes'});
  const adjacent = new LaneletModel(data), before = adjacent.toJSON(), newId = adjacent.createAdjacentLanelet(sourceId, side, width);
  const bounds = adjacent.laneletBounds(newId), innerSide = side === 'left' ? 'right' : 'left';
  assert.equal(bounds[innerSide].id, sharedId, 'adjacent lanes share the original boundary ID');
  assert.deepEqual(bounds[side + 'Points'].map(p => [p.x, p.y, p.z]), [[0, expectedY, 2], [20, expectedY, 4]]);
  assert.deepEqual(bounds[side].tags, {type: 'line_thin', subtype: 'dashed', color: 'white'});
  assert.deepEqual(adjacent.relations.get(newId).tags, {type: 'lanelet', subtype: 'road', one_way: 'yes', speed_limit: '40 km/h', 'participant:vehicle': 'yes'});
  assert.equal(adjacent.relations.get(newId).members.length, 2);
  assert.ok(adjacent.topology().lanes.get(sourceId)[side + 'Neighbors'].includes(newId));
  assert.deepEqual(adjacent.topology().lanes.get(newId)[innerSide + 'Neighbors'], [sourceId]);
  assert.equal(adjacent.laneConnections(sourceId).find(e => e.to === newId).status, 'allowed', 'adjacent lanes follow the same direction even with reverse-stored shared boundaries');
  for (const kind of ['nodes', 'ways', 'relations']) for (const original of before[kind]) assert.deepEqual(adjacent[kind].get(original.id), original);
  const after = adjacent.toJSON();
  assert.throws(() => adjacent.createAdjacentLanelet(sourceId, side, width), /이미.*인접 Lanelet/);
  assert.deepEqual(adjacent.toJSON(), after);
  adjacent.undo(); assert.deepEqual(adjacent.toJSON(), before);
}
const rejectedAdjacent = new LaneletModel(fixture()), rejectedAdjacentBefore = rejectedAdjacent.toJSON();
for (const width of [0, 0.049, NaN, Infinity, '3.5']) assert.throws(() => rejectedAdjacent.createAdjacentLanelet('20', 'left', width), /폭/);
assert.throws(() => rejectedAdjacent.createAdjacentLanelet('20', 'up'), /left.*right/);
assert.throws(() => rejectedAdjacent.createAdjacentLanelet('20', 'right'), /이미.*인접 Lanelet/);
assert.throws(() => rejectedAdjacent.connectLaneletNeighbor('20', 'left', '30'), /Lanelet이 아닙니다/);
assert.deepEqual(rejectedAdjacent.toJSON(), rejectedAdjacentBefore);
assert.equal(rejectedAdjacent.canUndo, false);
const bentAdjacent = new LaneletModel({version: 1, nodes: [], ways: [], relations: []});
const bentId = bentAdjacent.createLanelet([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 1}, {x: 0, y: 1}], 0.2), bentBefore = bentAdjacent.toJSON();
assert.throws(() => bentAdjacent.createAdjacentLanelet(bentId, 'left', 1), /교차|굴곡/);
assert.deepEqual(bentAdjacent.toJSON(), bentBefore, 'an invalid offset rolls back every generated entity');

for (const [side, neighborY, opposite] of [['left', 5, 'right'], ['right', -5, 'left']]) {
  const linked = new LaneletModel({version: 1, nodes: [], ways: [], relations: []});
  const selectedId = linked.createLanelet([{x: 0, y: 0}, {x: 20, y: 0}], 4), neighborId = linked.createLanelet([{x: 0, y: neighborY}, {x: 20, y: neighborY}], 4);
  const before = linked.toJSON(), neighborBefore = clone(linked.relations.get(neighborId));
  assert.equal(linked.connectLaneletNeighbor(selectedId, side, neighborId), neighborId);
  assert.equal(linked.laneletBounds(selectedId)[side].id, linked.laneletBounds(neighborId)[opposite].id);
  assert.deepEqual(linked.topology().lanes.get(selectedId)[side + 'Neighbors'], [neighborId]);
  assert.deepEqual(linked.topology().lanes.get(neighborId)[opposite + 'Neighbors'], [selectedId]);
  assert.deepEqual(linked.relations.get(neighborId), neighborBefore);
  for (const kind of ['nodes', 'ways']) for (const original of before[kind]) assert.deepEqual(linked[kind].get(original.id), original);
  linked.undo(); assert.deepEqual(linked.toJSON(), before);
  assert.throws(() => linked.connectLaneletNeighbor(selectedId, 'up', neighborId), /left.*right/);
  assert.throws(() => linked.connectLaneletNeighbor(selectedId, side, selectedId), /다른 Lanelet/);
  assert.throws(() => linked.connectLaneletNeighbor(selectedId, side, 'missing'), /찾을 수 없습니다/);
  assert.throws(() => linked.connectLaneletNeighbor(selectedId, opposite, neighborId), /방향|경계/);
  assert.deepEqual(linked.toJSON(), before, 'rejected neighbor connections leave the source unchanged');
  linked.reverseLanelet(neighborId); const opposingBefore = linked.toJSON();
  assert.throws(() => linked.connectLaneletNeighbor(selectedId, side, neighborId), /방향/);
  assert.deepEqual(linked.toJSON(), opposingBefore);
}

const atomic = new LaneletModel(fixture());
atomic.relations.get('21').members = [{type: 'way', ref: '12', role: 'left'}, {type: 'way', ref: '11', role: 'right'}];
const oppositeBefore = atomic.toJSON();
assert.throws(() => atomic.splitLanelet('20', 0.5), /반대 방향/);
assert.deepEqual(atomic.toJSON(), oppositeBefore);
assert.equal(atomic.canUndo, false);

const created = new LaneletModel({version: 1, crs: 'EPSG:32652', nodes: [], ways: [], relations: [], meta: {}});
const lane = created.createLanelet([{x: 0, y: 0}, {x: 10, y: 0}, {x: 15, y: 5}], 3.5);
assert.equal(created.diagnostics().filter(d => d.severity === 'error').length, 0);
const duplicate = created.duplicateLanelet(lane, 30, 10);
assert.equal(created.laneletBounds(duplicate).leftPoints[0].x - created.laneletBounds(lane).leftPoints[0].x, 30);
created.markSaved(); assert.equal(created.dirty, 0);
created.deleteLanelet(duplicate); assert.equal(created.lanelets.length, 1); assert.equal(created.dirty, 1);
created.undo(); assert.equal(created.dirty, 0);
const createBefore = created.toJSON();
assert.throws(() => created.createLanelet([{x: 0, y: 0}, {x: 0, y: 0}], 3.5));
assert.deepEqual(created.toJSON(), createBefore);
created.beginTransaction('drag');
for (let x = 0; x < 10; x++) created.moveNode(created.laneletBounds(lane).leftPoints[0].id, {x});
created.commitTransaction();
assert.equal(created._history.at(-1).changes.length, 1);

const welded = new LaneletModel(fixture());
const newPoint = welded.insertVertex('10', 0, 0.5);
welded.setTags('node', newPoint, {survey: 'retained'});
welded.transaction('node member', () => welded._write('relation', '31', {id: '31', tags: {type: 'custom'}, members: [{type: 'node', ref: newPoint, role: 'marker'}]}));
const beforeWeld = welded.toJSON();
assert.equal(welded.weldNodes(newPoint, '1'), '1');
assert.equal(welded.nodes.has(newPoint), false);
assert.deepEqual(welded.ways.get('10').nodes, ['1', '2']);
assert.equal(welded.nodes.get('1').tags.survey, 'retained');
assert.equal(welded.relations.get('31').members[0].ref, '1');
welded.undo(); assert.deepEqual(welded.toJSON().ways, beforeWeld.ways);
welded.redo();
const collapseBefore = welded.toJSON();
assert.throws(() => welded.weldNodes('1', '2'), /두 점/);
assert.deepEqual(welded.toJSON(), collapseBefore);

const mergeModel = new LaneletModel({version: 1, nodes: [], ways: [], relations: []});
const mergeFirst = mergeModel.createLanelet([{x: 0, y: 0}, {x: 20, y: 0}], 4), mergeSecond = mergeModel.extendLanelet(mergeFirst, 10);
const mergeSourceA = {'mgeo:link_id': 'link-a', 'mgeo:station_start': '0', 'mgeo:station_end': '20', 'mgeo:from_node': 'node-a', 'mgeo:to_node': 'node-b'};
const mergeSourceB = {'mgeo:link_id': 'link-b', 'mgeo:station_start': '20', 'mgeo:station_end': '30', 'mgeo:from_node': 'node-b', 'mgeo:to_node': 'node-c'};
mergeModel.setTags('relation', mergeFirst, mergeSourceA);
mergeModel.setTags('relation', mergeSecond, mergeSourceB);
for (const side of ['left', 'right']) {
  mergeModel.setTags('way', mergeModel.laneletBounds(mergeFirst)[side].id, {'mgeo:boundary_id': `${side}-a`, 'mgeo:boundary_entity': 'lane_boundary'});
  mergeModel.setTags('way', mergeModel.laneletBounds(mergeSecond)[side].id, {'mgeo:boundary_id': `${side}-b`, 'mgeo:boundary_entity': 'road_boundary'});
}
for (const id of [mergeFirst, mergeSecond]) {
  const relation = mergeModel.relations.get(id), bounds = mergeModel.laneletBounds(id);
  for (const entity of [relation, bounds.left, bounds.right]) entity.tagPairs = Object.entries(entity.tags);
}
mergeModel.relations.get(mergeFirst).tagPairs.unshift(['mgeo:link_id', 'original-link']);
const mergeBefore = mergeModel.toJSON();
assert.equal(mergeModel.mergeLanelets(mergeFirst, mergeSecond), mergeFirst);
assert.equal(mergeModel.lanelets.length, 1);
for (const tag of Object.keys(mergeSourceA)) assert.equal(mergeModel.relations.get(mergeFirst).tags[tag], tag === 'mgeo:link_id' ? 'original-link;link-a;link-b' : `${mergeSourceA[tag]};${mergeSourceB[tag]}`);
for (const side of ['left', 'right']) {
  assert.equal(mergeModel.laneletBounds(mergeFirst)[side].tags['mgeo:boundary_id'], `${side}-a;${side}-b`);
  assert.equal(mergeModel.laneletBounds(mergeFirst)[side].tags['mgeo:boundary_entity'], 'lane_boundary;road_boundary');
}
const mergeExport = mergeModel.toJSON(), mergedBounds = mergeModel.laneletBounds(mergeFirst);
for (const entity of [mergeExport.relations.find(r => r.id === mergeFirst), ...mergeExport.ways.filter(w => [mergedBounds.left.id, mergedBounds.right.id].includes(w.id))]) {
  for (const [name, value] of Object.entries(entity.tags)) assert.deepEqual(entity.tagPairs.filter(([tag]) => tag === name), [[name, value]]);
}
assert.equal(polylineLength(mergeModel.laneletBounds(mergeFirst).leftPoints), 30);
mergeModel.undo(); assert.deepEqual(mergeModel.toJSON(), mergeBefore);
mergeModel.setTags('way', mergeModel.laneletBounds(mergeSecond).right.id, {'mgeo:lane_shape': 'different'});
const boundaryConflict = mergeModel.toJSON();
assert.throws(() => mergeModel.mergeLanelets(mergeFirst, mergeSecond), /경계 속성/);
assert.deepEqual(mergeModel.toJSON(), boundaryConflict, 'marking conflicts roll back a partially merged left boundary');
const mergedNeighbor = new LaneletModel(fixture()), neighboringExtension = mergedNeighbor.extendLanelet('20', 10);
const unsafeBefore = mergedNeighbor.toJSON();
assert.throws(() => mergedNeighbor.mergeLanelets('20', neighboringExtension), /공유/);
assert.deepEqual(mergedNeighbor.toJSON(), unsafeBefore);

const virtualMerge = new LaneletModel({version: 1, nodes: [], ways: [], relations: []});
const virtualFirst = virtualMerge.createLanelet([{x: 0, y: 0}, {x: 20, y: 0}], 4), virtualSecond = virtualMerge.extendLanelet(virtualFirst, 10);
virtualMerge.setTags('way', virtualMerge.laneletBounds(virtualFirst).right.id, {
  type: 'virtual', subtype: null, color: null, 'lane_change:left': 'no', 'lane_change:right': 'no',
  'mgeo:geometry': 'virtual_source_centerline_and_anchors', 'mgeo:boundary_entity': 'source-a'
});
virtualMerge.setTags('way', virtualMerge.laneletBounds(virtualSecond).right.id, {
  type: 'virtual', subtype: null, color: null, 'lane_change:left': 'no', 'lane_change:right': 'no',
  'mgeo:geometry': 'source_polyline_with_topology_caps', 'mgeo:boundary_entity': 'source-b',
  'mgeo:boundary_id': 'B2256W000075', 'mgeo:lane_shape': 'solid', 'mgeo:lane_type': '505', 'mgeo:lane_width': '0.15'
});
const virtualBefore = virtualMerge.toJSON();
assert.equal(virtualMerge.mergeLanelets(virtualFirst, virtualSecond), virtualFirst, 'virtual boundaries can merge despite preserved source marker differences');
assert.equal(virtualMerge.lanelets.length, 1);
assert.deepEqual(virtualMerge.laneletBounds(virtualFirst).right.tags, {
  type: 'virtual', 'lane_change:left': 'no', 'lane_change:right': 'no',
  'mgeo:geometry': 'virtual_source_centerline_and_anchors;source_polyline_with_topology_caps',
  'mgeo:boundary_entity': 'source-a;source-b', 'mgeo:boundary_id': 'B2256W000075',
  'mgeo:lane_shape': 'solid', 'mgeo:lane_type': '505', 'mgeo:lane_width': '0.15'
});
virtualMerge.undo(); assert.deepEqual(virtualMerge.toJSON(), virtualBefore);
virtualMerge.setTags('way', virtualMerge.laneletBounds(virtualSecond).right.id, {'mgeo:lane_type': '530'});
const virtualStopLineBefore = virtualMerge.toJSON();
assert.throws(() => virtualMerge.mergeLanelets(virtualFirst, virtualSecond), /right 경계 속성/, 'stop-line source types still affect virtual boundary rendering');
assert.deepEqual(virtualMerge.toJSON(), virtualStopLineBefore, 'stop-line conflicts leave both Lanelets unchanged');
virtualMerge.setTags('way', virtualMerge.laneletBounds(virtualSecond).right.id, {'mgeo:lane_type': '505', 'mgeo:geometry': 'original'});
const virtualOriginalBefore = virtualMerge.toJSON();
assert.throws(() => virtualMerge.mergeLanelets(virtualFirst, virtualSecond), /right 경계 속성/, 'original source layer classifications cannot be merged into displayed virtual boundaries');
assert.deepEqual(virtualMerge.toJSON(), virtualOriginalBefore);

const assignModel = new LaneletModel(fixture());
const assignmentBefore = assignModel.toJSON();
assert.throws(() => assignModel.setLaneletBoundary('20', 'left', '11'), /폭/);
assert.deepEqual(assignModel.toJSON(), assignmentBefore);
assignModel.transaction('copy', () => assignModel._write('way', '100', {...assignModel.ways.get('10'), id: '100'}));
assignModel.setLaneletBoundary('20', 'left', '100');
assert.equal(assignModel.laneletBounds('20').left.id, '100');

const metadataFixture = fixture();
metadataFixture.ways[1].ndAttributes = [{survey: 'end'}, {survey: 'start'}];
const metadata = new LaneletModel(metadataFixture);
const extra = metadata.insertVertex('11', 0, 0.5);
assert.deepEqual(metadata.ways.get('11').ndAttributes, [{survey: 'end'}, {}, {survey: 'start'}]);
metadata.deleteNode(extra); assert.deepEqual(metadata.ways.get('11').ndAttributes, metadataFixture.ways[1].ndAttributes);
metadata.setTags('way', '11', {...metadata.ways.get('11').tags, speed_limit: '20'});
assert.equal(metadata.ways.get('11').tagPairs.filter(([name]) => name === 'custom').length, 2, 'unchanged duplicate tags survive a full UI tags patch');
const metadataExtend = metadata.extendLanelet('20', 10);
assert.deepEqual(metadata.laneletBounds(metadataExtend).right.ndAttributes, [{survey: 'end'}, {}]);
metadata.undo();
metadata.splitLanelet('20', 0.5);
for (const w of metadata.ways.values()) if (w.ndAttributes) assert.equal(w.ndAttributes.length, w.nodes.length);
metadata.undo(); metadata.reverseLanelet('21');
assert.deepEqual(metadata.laneletBounds('21').right.ndAttributes, [{survey: 'end'}, {survey: 'start'}]);
console.log('model: import preservation, shared edits, atomic history, split neighbors, exact topology, create/duplicate/reverse passed');

function clone(value) {return structuredClone(value);}

// Multi-selection order must not affect merging; one undo restores the whole chain.
const chain = new LaneletModel({version:1,nodes:[],ways:[],relations:[]});
const c1=chain.createLanelet([{x:0,y:0},{x:10,y:0}],4),c2=chain.extendLanelet(c1,10),c3=chain.extendLanelet(c2,10);
chain.setTags('relation',c1,{'mgeo:link_id':'link-a;link-b'});chain.setTags('relation',c2,{'mgeo:link_id':'link-b;link-c'});
const chainBefore=chain.toJSON();
assert.equal(chain.mergeLaneletChain([c3,c1,c2]),c1);
assert.equal(chain.relations.get(c1).tags['mgeo:link_id'],'link-a;link-b;link-c');
assert.equal(chain.lanelets.length,1);chain.undo();assert.deepEqual(chain.toJSON(),chainBefore);
chain.setTags('relation',c3,{speed_limit:'20'});const conflict=chain.toJSON();
assert.throws(()=>chain.mergeLaneletChain([c1,c2,c3]),/속성/);for(const kind of ['nodes','ways','relations'])assert.deepEqual(chain.toJSON()[kind].sort((a,b)=>a.id.localeCompare(b.id)),conflict[kind].sort((a,b)=>a.id.localeCompare(b.id)));
const connections=new LaneletModel(fixture());
assert.equal(connections.laneConnections('20').find(e=>e.to==='21').status,'unknown');
connections.setTags('way','11',{'lane_change:left':'yes','lane_change:right':'no'});
assert.equal(connections.laneConnections('20').find(e=>e.to==='21').status,'allowed');
assert.equal(connections.laneConnections('21').find(e=>e.to==='20').status,'blocked');
connections.reverseLanelet('21');
assert.ok(!connections.laneConnections('20').some(e=>e.to==='21'&&e.status==='allowed'));
console.log('multi-select chain merge, atomic rollback, directed lane-change and opposing traffic checks passed');
