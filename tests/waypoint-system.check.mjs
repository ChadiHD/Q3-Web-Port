// Self-check for waypoint numbering: numbers stay fixed on delete, gaps are reported, duplicates
// are refused, and the route order follows the numbers.
// Run: node tests/waypoint-system.check.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// waypoint-system.js imports 'three' and draws labels on a canvas. Neither matters here, so both
// are stubs: every THREE class builds an object that accepts any call.
const stub = () => new Proxy(function () {}, { get: (t, k) => (k in t ? t[k] : (t[k] = stub())), apply: () => stub(), construct: () => stub() });
globalThis.document = { createElement: () => stub() };
registerHooks({
    resolve: (spec, ctx, next) => (spec === 'three' ? { url: 'stub:three', shortCircuit: true } : next(spec, ctx)),
    load: (url, ctx, next) => (url === 'stub:three'
        ? { format: 'module', source: 'const s = globalThis.__stub; export const Raycaster = s(), Vector2 = s(), Vector3 = s(), Group = s(), SphereGeometry = s(), MeshBasicMaterial = s(), Mesh = s(), EdgesGeometry = s(), LineBasicMaterial = s(), LineSegments = s(), Line = s(), BufferGeometry = s(), CanvasTexture = s(), SpriteMaterial = s(), Sprite = s();', shortCircuit: true }
        : next(url, ctx)),
});
globalThis.__stub = stub;
const { WaypointSystem } = await import('../Q3BeamSearch/wwwroot/js/waypoint-system.js');

const scene = { add() {}, remove() {} };
const ws = new WaypointSystem(scene, null);
const at = x => ({ x, y: 0, z: 0 });
const numbers = () => ws.waypoints.map(w => w.number);

// Default number = lowest free one
ws.addWaypoint(at(1)); ws.addWaypoint(at(2)); ws.addWaypoint(at(3));
assert.deepEqual(numbers(), [1, 2, 3]);

// Deleting 2 keeps 1 and 3, reports 2 missing, and offers 2 next
ws.deleteWaypoint(1);
assert.deepEqual(numbers(), [1, 3]);
assert.deepEqual(ws.missingNumbers(), [2]);
assert.equal(ws.nextFreeNumber(), 2);

// Putting 2 back slots it between 1 and 3 (route order), marker arrays stay parallel
ws.addWaypoint(at(22), 2);
assert.deepEqual(numbers(), [1, 2, 3]);
assert.deepEqual(ws.waypoints.map(w => w.position.x), [1, 22, 3]);
assert.equal(ws.waypointMarkers.length, ws.waypoints.length);
assert.deepEqual(ws.missingNumbers(), []);

// A duplicate number is refused
assert.equal(ws.addWaypoint(at(99), 3), null);
assert.equal(ws.waypoints.length, 3);

// A jump ahead leaves gaps
ws.addWaypoint(at(6), 6);
assert.deepEqual(ws.missingNumbers(), [4, 5]);
assert.equal(ws.nextFreeNumber(), 4);

// Playback progress stays on the same waypoint when an earlier one is deleted
ws.currentWaypoint = 2;   // next to reach: number 3
ws.deleteWaypoint(0);
assert.equal(ws.waypoints[ws.currentWaypoint].number, 3);

console.log('ok numbering, gaps, duplicates, order');

// Reach rule (shared by playback and the optimizer): the player's hitbox (±15 across, -24..+32
// around the origin) touches the ball. A ball of radius 32 resting on the floor: centre 32 up,
// a standing player's origin 24 up, so dz = -8.
const { hitboxTouches } = await import('../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js');
assert.ok(hitboxTouches(0, 0, 0, 32), 'origin at the centre');
assert.ok(hitboxTouches(40, 0, -8, 32), 'standing 40 off: the box side is 25 from the centre, grazing counts');
assert.ok(!hitboxTouches(50, 0, -8, 32), 'standing 50 off: 35 > 32');
assert.ok(hitboxTouches(40, 0, 37, 32), 'hopping 45 up, 40 off: nearest box point 25 across, 13 up = 28.2');
assert.ok(!hitboxTouches(45, 0, 37, 32), 'hopping 45 up, 45 off: 30 across, 13 up = 32.7');
assert.ok(!hitboxTouches(40, 40, -8, 32), 'diagonal: the box corner is 35.4 away');
assert.ok(!hitboxTouches(0, 0, 100, 32), 'passing 100 above: the box bottom is 76 over the centre');
const raised = ws.addWaypoint(at(7), 7, 64, 120);
assert.equal(raised.height, 120);
console.log('ok hitbox reach rule, raised waypoints');

// Live editing: resize keeps the waypoint (same number and place), selection survives it
ws.select(raised);
ws.resize(raised, 48, 0);
assert.equal(ws.selectedWaypoint, raised);
assert.deepEqual([raised.number, raised.radius, raised.height], [7, 48, 0]);
assert.equal(ws.waypointMarkers.length, ws.waypoints.length);
ws.deleteWaypoint(ws.waypoints.indexOf(raised));
assert.equal(ws.selectedWaypoint, null, 'deleting the selected waypoint ends editing');
console.log('ok select, resize, delete while selected');
