// Self-check for the VQ3 TAS optimizer. Run: node tests/waypoint-optimizer.check.mjs
import assert from 'node:assert/strict';
import { WaypointOptimizer, hitboxTouches } from '../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js';
import { flatFloorQ3 } from './flat-floor-q3.mjs';

const run = (wps, spawn = null) => new WaypointOptimizer(flatFloorQ3())
    .optimizeRoute(wps.map(([x, y]) => ({ position: { x, y, z: 0 }, radius: 32 })), null, spawn);
const speed = (r, i) => Math.hypot(r.replay.velocities[i].x, r.replay.velocities[i].y);

// Straight 2000 units from waypoint 1. Running at the 320 ground cap takes ~800 frames.
const straight = await run([[0, 0], [2000, 0]]);
const n = straight.inputs.length;
assert.equal(straight.reached, 1);
assert.equal(straight.replay.positions.length, n);
assert.ok(n < 600, `straight: ${n} frames, strafe-jumping should beat running (~800)`);
assert.ok(speed(straight, n - 1) > 500, `straight: ${speed(straight, n - 1).toFixed(0)} ups, should gain far beyond 320`);
assert.ok(straight.jumps >= 3, `straight: only ${straight.jumps} jumps`);
assert.ok(straight.inputs.every(i => Math.abs(i.f) <= 127 && Math.abs(i.s) <= 127 && i.u >= 0 && i.u <= 127), 'moves must fit a signed char');
assert.ok(straight.inputs.every(i => Number.isInteger(i.yawShort) && i.yawShort >= 0 && i.yawShort < 65536), 'yaw is an exact short');
// Frame-perfect bunnyhop with upmove 10 (PM_CheckJump's minimum: full wishspeed on the jump frame).
const first = straight.inputs.findIndex(i => i.u);
assert.ok(straight.inputs.every(i => i.u === 0 || i.u === 10), 'jump frames send upmove 10');
for (let i = first; i < n - 1; i++)
    if (straight.replay.onGround[i]) assert.equal(straight.inputs[i + 1].u, 10, `landed on frame ${i} but no jump on ${i + 1}`);
console.log(`ok straight: ${n} frames, ${straight.jumps} jumps, ${speed(straight, n - 1).toFixed(0)} ups`);

// 90° turn: waypoints reached in order (viewer y = -Q3_Y, so -800 is a left turn).
const turn = await run([[0, 0], [800, 0], [800, -800]]);
assert.equal(turn.reached, 2, `turn: reached ${turn.reached}/2`);
// Reached = the hitbox touches waypoint 2's ball (radius 32 resting on the floor: centre 32 up)
const nearWp2 = turn.replay.positions.some(p => hitboxTouches(p.x - 800, p.y, p.z - 32, 32));
assert.ok(nearWp2, 'turn: the hitbox never touches waypoint 2');
console.log(`ok turn: ${turn.inputs.length} frames, ${turn.jumps} jumps, ${speed(turn, turn.inputs.length - 1).toFixed(0)} ups`);

// A pool finishes candidates in any order; merged in job order the route is the same.
// This runner simulates the jobs last-first, like a pool where the late jobs finish first.
const pooled = new WaypointOptimizer(flatFloorQ3());
pooled.legRunner = async (start, beam, jobs, wps, seg) =>
    jobs.map((j, i) => [i, j]).reverse()
        .map(([i, j]) => [i, pooled._extend(start, beam[j.node], wps, seg, j.p)])
        .sort((a, b) => a[0] - b[0]).map(([, c]) => c);
const turnPooled = await pooled.optimizeRoute([[0, 0], [800, 0], [800, -800]].map(([x, y]) => ({ position: { x, y, z: 0 }, radius: 32 })), null);
assert.deepEqual(turnPooled.inputs, turn.inputs, 'pooled leg runner gives the same route');
console.log(`ok pooled: same ${turnPooled.inputs.length}-frame route with candidates simulated out of order`);

// From a spawn (Q3 coords, 24 up like a real info_player_deathmatch): lands first, then
// every waypoint is a target, so waypoint 1 must be reached too.
const spawned = await run([[400, 0], [2000, 0]], { origin: [0, 0, 24] });
assert.equal(spawned.first, 1);
assert.equal(spawned.reached, 2, `spawn: reached ${spawned.reached}/2`);
assert.equal(spawned.start[2], 24, 'spawn: starts landed on the floor');
assert.ok(Math.abs(spawned.replay.positions[0].x) < 5, 'spawn: run starts at the spawn');
console.log(`ok spawn: ${spawned.inputs.length} frames, ${spawned.jumps} jumps, ${speed(spawned, spawned.inputs.length - 1).toFixed(0)} ups`);

// CPM: same turn course; the air frames may use the strafe key alone (sidestrafe) or forward
// alone (air control), and the route is no slower than VQ3's.
const cpmTurn = await new WaypointOptimizer(flatFloorQ3(), true)
    .optimizeRoute([[0, 0], [800, 0], [800, -800]].map(([x, y]) => ({ position: { x, y, z: 0 }, radius: 32 })), null);
assert.equal(cpmTurn.reached, 2, `cpm turn: reached ${cpmTurn.reached}/2`);
const alone = cpmTurn.inputs.filter(i => !i.f || !i.s).length;
assert.ok(alone > 0, 'cpm turn: never used a key alone');
assert.ok(cpmTurn.inputs.length <= turn.inputs.length, `cpm turn: ${cpmTurn.inputs.length} frames, VQ3 ${turn.inputs.length}`);
console.log(`ok cpm turn: ${cpmTurn.inputs.length} frames (VQ3 ${turn.inputs.length}), ${alone} frames with one key, ${speed(cpmTurn, cpmTurn.inputs.length - 1).toFixed(0)} ups`);
