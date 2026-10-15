// Self-check for the oDFe cfg exports. Run: node tests/cfg-export.check.mjs
import assert from 'node:assert/strict';
import { exportBaked, exportScript, bakeInputs } from '../Q3BeamSearch/wwwroot/js/cfg-export.js';
import { runScript } from '../Q3BeamSearch/wwwroot/js/movement-script.js';
import { WaypointOptimizer } from '../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js';
import { flatFloorQ3 } from './flat-floor-q3.mjs';

const SPAWN = { origin: [0, 0, 24], angle: 90 };
const opts = name => ({ Q3: flatFloorQ3(), spawn: SPAWN, map: 'flat', name });
const usercmds = r => r.inputs.map(i => `${i.f}/${i.s}/${i.u}/${i.yawShort}`);

// Baked script run: re-running the export gives the same usercmds, without bots.
const script = '+snapbot; +forward; +left; +autojump; wait 300; -left; +right; wait 100; -snapbot; +speed; wait 20';
const ran = runScript(script, flatFloorQ3(), SPAWN);
const baked = exportBaked(ran.inputs, opts('flat_baked'));
assert.equal(baked.files.length, 1);
const text = baked.files[0].text;
assert.match(text, /^\/\/ flat_baked\.cfg: VQ3 movement for flat/);
assert.match(text, /scriptplay flat_baked/);
assert.match(text, /set fixedtime 8; set com_maxfps 125; set cl_run 1; set cl_scriptRun 1\nscriptphysics vq3\n/);
assert.ok(!/snapbot|autojump|\+left|\+right/.test(text.replace(/^-.*$/gm, '')), 'baked: no bots or turn keys pressed');
assert.match(text, /\+speed/, 'walking frames press +speed');
assert.match(text, /set cl_scriptRun 0; set fixedtime 0\necho expected end after 420 frames: origin .*; scriptpos\n$/);
// a checkpoint before frames 125, 250, 375: the tool's state after that many frames, then scriptpos
const checks = [...text.matchAll(/^echo expected after (\d+) frames: origin (\S+) (\S+) (\S+), (\d+) ups.*; scriptpos$/gm)];
assert.deepEqual(checks.map(m => +m[1]), [125, 250, 375]);
for (const m of checks) assert.equal(+m[2], +ran.replay.positions[+m[1] - 1].x.toFixed(1));
const rerun = runScript(text, flatFloorQ3(), SPAWN);
assert.equal(rerun.error, null);
assert.deepEqual(usercmds(rerun), usercmds(ran));
console.log(`ok baked script: ${ran.inputs.length} frames in ${text.split('\n').length} lines, ${text.length} bytes, checkpoints at ${checks.map(m => m[1])}`);

// An optimizer route bakes the same way.
const route = await new WaypointOptimizer(flatFloorQ3())
    .optimizeRoute([{ position: { x: 1500, y: 0, z: 0 }, radius: 32 }], null, SPAWN);
const rb = exportBaked(route.inputs, opts('flat_route'));
assert.deepEqual(usercmds(runScript(rb.files[0].text, flatFloorQ3(), SPAWN)), usercmds(route));
assert.ok(Math.abs(rb.run.replay.positions.at(-1).x - route.replay.positions.at(-1).x) < 1e-3, 'same end as the optimizer replay');
console.log(`ok baked route: ${route.inputs.length} frames`);

// Long runs stay one file (scriptplay reads any size).
const wiggle = Array.from({ length: 4000 }, (_, i) => ({ f: 127, s: i % 2 ? 127 : -127, u: 0, yawShort: (i * 997) & 0xffff }));
const long = exportBaked(wiggle, opts('flat_long'));
assert.equal(long.files.length, 1);
assert.deepEqual(usercmds(runScript(long.files[0].text, flatFloorQ3(), SPAWN)), usercmds({ inputs: wiggle }));
console.log(`ok long: ${wiggle.length} frames, ${long.files[0].text.length} bytes in one file`);

// As written: header + the script + footer; runs the same as the script alone.
const asw = exportScript(script, opts('flat_script'));
assert.match(asw.files[0].text, /set cl_scriptRun 1\nscriptphysics vq3\n-forward;.*\nsetyaw 90\n\+snapbot/);
assert.deepEqual(usercmds(runScript(asw.files[0].text, flatFloorQ3(), SPAWN)), usercmds(ran));
assert.equal(exportScript('+forward; wait 3\nbogus', opts('x')).run.error, 'line 2: Unknown command "bogus"');
console.log('ok as written');

// Moves keys can't make are refused.
assert.throws(() => bakeInputs([{ f: 100, s: 0, u: 0, yawShort: 0 }]), /can't be made with keys/);
assert.throws(() => bakeInputs([{ f: 127, s: 0, u: 127, yawShort: 0 }]), /can't be made with keys/);
console.log('ok refuses non-key moves');

// CPM: the header declares it (scriptplay stops on a VQ3 game), and the run replays only as CPM.
const cpmRun = runScript(script, flatFloorQ3(), SPAWN, true);
const cpm = exportBaked(cpmRun.inputs, { ...opts('flat_cpm'), cpm: true }).files[0].text;
assert.match(cpm, /^\/\/ flat_cpm\.cfg: CPM movement for flat.*\n.*df_promode 1, devmap flat/);
assert.match(cpm, /\nscriptphysics cpm\n/);
assert.deepEqual(usercmds(runScript(cpm, flatFloorQ3(), SPAWN, true)), usercmds(cpmRun));
assert.match(runScript(cpm, flatFloorQ3(), SPAWN).error, /line 5: the script is for CPM: switch Physics to CPM/);
console.log('ok cpm export');
