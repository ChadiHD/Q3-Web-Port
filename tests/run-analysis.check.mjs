// Self-check for the statistics dashboard's run analysis. Run: node tests/run-analysis.check.mjs
import assert from 'node:assert/strict';
import { WaypointOptimizer } from '../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js';
import { analyseRun, summarise } from '../Q3BeamSearch/wwwroot/js/run-analysis.js';
import { simulate } from '../Q3BeamSearch/wwwroot/js/strafe.js';
import { flatFloorQ3 } from './flat-floor-q3.mjs';

// A straight optimizer run on the flat floor, stored like the viewer's framesFromRun (y = -Q3 y)
const route = await new WaypointOptimizer(flatFloorQ3())
    .optimizeRoute([[0, 0], [2000, 0]].map(([x, y]) => ({ position: { x, y, z: 0 }, radius: 32 })));
const frames = route.replay.positions.map((p, i) => ({
    x: p.x, y: -p.y, z: p.z, vx: route.replay.velocities[i].x, vy: route.replay.velocities[i].y,
    onGround: route.replay.onGround[i], yawDeg: route.inputs[i].yaw, yawShort: route.inputs[i].yawShort,
    forwardMove: route.inputs[i].f, rightMove: route.inputs[i].s, upMove: route.inputs[i].u
}));

const rows = analyseRun(frames);
const s = summarise(rows);
assert.equal(s.modelled, 1, `flat floor: the model should reproduce every frame, got ${(s.modelled * 100).toFixed(1)}%`);
assert.equal(s.jumps, route.jumps, 'jumps = frames that left the ground with jump held');
assert.ok(s.efficiency > 90, `optimizer run: ${s.efficiency.toFixed(1)}% efficiency, expected near 100`);
assert.ok(rows.filter(r => r.mode === 'air' && r.angle !== null).every(r => r.angle < 90 && r.opt >= r.min),
    'air strafe angles sit between 0 and 90°, the best angle above the no-accel one');
console.log(`ok optimizer run: ${s.frames} frames, ${s.jumps} jumps, ${s.efficiency.toFixed(1)}% efficiency, ${(s.atBest * 100).toFixed(0)}% at the best yaw`);

// One wasted air frame: wish straight along the velocity (under the no-accel angle) gains nothing
const k = rows.findIndex(r => r.i > 100 && r.mode === 'air' && r.speed > 400);
const fr = frames[k], prev = rows[k - 1];
const keys = { f: fr.forwardMove, s: fr.rightMove, u: fr.upMove };
fr.yawShort = Math.round((Math.atan2(prev.vy, prev.vx) - Math.atan2(-keys.s, keys.f)) * 32768 / Math.PI) & 0xffff;
fr.yawDeg = fr.yawShort * 360 / 65536;
[fr.vx, fr.vy] = simulate({ vel: [prev.vx, prev.vy, prev.vz], mode: 'air', cpm: false }, keys, fr.yawShort);
const bad = analyseRun(frames)[k];
assert.ok(bad.match && bad.angle < bad.min, `frame ${k}: wish along the velocity, ${bad.angle.toFixed(2)}° (no accel below ${bad.min.toFixed(1)}°)`);
assert.ok(bad.eff < 10, `frame ${k}: ${bad.eff.toFixed(1)}% efficiency, expected about 0`);
console.log(`ok wasted frame ${k}: ${bad.eff.toFixed(1)}% efficiency`);
