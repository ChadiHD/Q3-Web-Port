// Self-check for the VQ3 TAS optimizer. Run: node tests/waypoint-optimizer.check.mjs
import assert from 'node:assert/strict';
import { WaypointOptimizer } from '../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js';
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
const nearWp2 = turn.replay.positions.some(p => Math.hypot(p.x - 800, p.y) <= 32);
assert.ok(nearWp2, 'turn: path never passes through waypoint 2');
console.log(`ok turn: ${turn.inputs.length} frames, ${turn.jumps} jumps, ${speed(turn, turn.inputs.length - 1).toFixed(0)} ups`);

// From a spawn (Q3 coords, 24 up like a real info_player_deathmatch): lands first, then
// every waypoint is a target, so waypoint 1 must be reached too.
const spawned = await run([[400, 0], [2000, 0]], { origin: [0, 0, 24] });
assert.equal(spawned.first, 1);
assert.equal(spawned.reached, 2, `spawn: reached ${spawned.reached}/2`);
assert.equal(spawned.start[2], 24, 'spawn: starts landed on the floor');
assert.ok(Math.abs(spawned.replay.positions[0].x) < 5, 'spawn: run starts at the spawn');
console.log(`ok spawn: ${spawned.inputs.length} frames, ${spawned.jumps} jumps, ${speed(spawned, spawned.inputs.length - 1).toFixed(0)} ups`);
