// Self-check for the movement-script runner. Run: node tests/movement-script.check.mjs
import assert from 'node:assert/strict';
import { runScript } from '../Q3BeamSearch/wwwroot/js/movement-script.js';
import { flatFloorQ3 } from './flat-floor-q3.mjs';

const SPAWN = { origin: [0, 0, 24], angle: 90 };
const run = text => runScript(text, flatFloorQ3(), SPAWN);
const f = Math.fround;
const speed = (r, i) => Math.hypot(r.replay.velocities[i].x, r.replay.velocities[i].y);

// wait: N frames, bare = 1, 0 = none, negative = 1 (Cmd_Wait_f); comments and quoted ';'
let r = run('+forward; wait 10 // ten\n-forward\nwait\nwait 0\n/* wait 99 */ wait -3\necho "a;b"');
assert.equal(r.error, null);
assert.equal(r.inputs.length, 12);
assert.deepEqual(r.inputs.map(i => i.f), [...Array(10).fill(127), 0, 0]);
assert.ok(r.replay.onGround[0] && Math.abs(r.replay.positions[0].x) < 1, 'starts landed at the spawn');
console.log('ok wait / comments / quotes');

// spawn angle 90 and +left turning, float for float like CL_AdjustAngles on the script yaw
r = run('+left; wait 50');
let yaw = f((16384 + 0.5) * 360 / 65536);
const t = f(f(0.008) * f(140));
r.inputs.forEach((inp, i) => {
    yaw = f(f(yaw - 0) + t);
    assert.equal(inp.yaw, yaw, `frame ${i}: yaw`);
    assert.equal(inp.yawShort, Math.trunc(f(f(yaw * 65536) / 360)) & 0xffff);
});
console.log(`ok +left: 50 frames turn ${(r.inputs[49].yaw - 90).toFixed(4)} deg`);

// setyaw is exact; cvars change the turn rate
r = run('setyaw 45; +forward; wait; seta cl_yawspeed 280; +right; wait');
assert.equal(r.inputs[0].yawShort, 8192);
assert.equal(r.inputs[1].yawShort, Math.trunc(f(f(f(f((8192 + 0.5) * 360 / 65536) - f(f(0.008) * f(280))) * 65536) / 360)) & 0xffff);
console.log('ok setyaw / cl_yawspeed');

// +moveup sends 10 (cl_scriptRun cap) and jumps; +movedown crouches, no jump
r = run('+moveup; wait 3');
assert.deepEqual(r.inputs.map(i => i.u), [10, 10, 10]);
assert.ok(r.replay.velocities[0].z > 200, 'jumped');
r = run('+movedown; wait 3');
assert.ok(r.inputs.every(i => i.u === -127) && r.replay.onGround.every(Boolean), 'crouch, no jump');
console.log('ok +moveup / +movedown');

// errors stop the run at their line, keeping the frames before it
r = run('+forward; wait 5\nfoo 1');
assert.equal(r.error, 'line 2: Unknown command "foo"');
assert.equal(r.inputs.length, 5);
assert.match(run('set fixedtime 4; wait').error, /fixedtime 8/);
assert.equal(run('+forward; wait 3; set fixedtime 0').error, null, 'restoring cvars after the last frame is fine');
assert.match(run('+attack').error, /isn't supported/);
console.log('ok errors');

// +snapbot +forward +left with +autojump: the bot adds moveleft, curves left, gains speed,
// and autojump hops frame-perfect with upmove 10
r = run('+snapbot; +forward; +left; +autojump; wait 400');
assert.equal(r.error, null);
const n = r.inputs.length, ups = speed(r, n - 1);
assert.ok(r.inputs.every(i => i.s === -127), 'bot holds moveleft');
assert.ok(ups > 450, `snapbot: ${ups.toFixed(0)} ups after 400 frames`);
for (let i = 0; i < n - 1; i++)
    if (r.replay.onGround[i]) assert.equal(r.inputs[i + 1].u, 10, `landed on frame ${i} but no jump on ${i + 1}`);
const heading = i => Math.atan2(r.replay.velocities[i].y, r.replay.velocities[i].x);
const turned = Math.atan2(Math.sin(heading(n - 1) - heading(5)), Math.cos(heading(n - 1) - heading(5)));
assert.ok(turned > 0.2, `snapbot should curve left, turned ${turned.toFixed(2)} rad`);
console.log(`ok +snapbot: ${n} frames, ${ups.toFixed(0)} ups, curved ${(turned * 180 / Math.PI).toFixed(0)} deg left`);

// +strafebot (CGaz) runs too, and never beats the snap bot by much
const s = run('+strafebot; +forward; +left; +autojump; wait 400');
console.log(`ok +strafebot: ${speed(s, s.inputs.length - 1).toFixed(0)} ups (snapbot ${ups.toFixed(0)})`);
