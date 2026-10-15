// wwwroot/js/cfg-export.js
// cfg files for the modified oDFe (docs/SCRIPTING.md), in two flavours:
//   - as written: the script itself;
//   - baked: frame-exact, one `setyaw` + key changes + `wait` per change, from any run's
//     inputs (scripts, optimizer routes, the frame editor). No bots or turn keys, so it
//     replays the same usercmds whatever the bots would decide in game.
// Both get a header that sets up cl_scriptRun, checks the physics (scriptphysics stops the script
// when the game runs the other one) and sets the start yaw, and a footer that releases
// everything, restores normal play and prints where the tool says the run ends next to where
// the game is (`scriptpos`). Baked files print that comparison every second too.
// They are meant for `scriptplay <name>`, which counts one usercmd per wait in any engine
// (`exec` depends on how the engine counts wait, and reads at most 64 KB).

import { runScript, KEYS, spawnYawShort } from './movement-script.js';
import { raceTime, formatMs } from './race-timer.js';

const yawDeg = s => s * 45 / 8192;   // s * 360/65536 as an exact decimal; setyaw rounds it back to s
const RELEASE = KEYS.map(k => '-' + k).join('; ');
const CHECK_EVERY = 125;             // a checkpoint every second

function header(map, name, startYaw, cpm) {
    return [
        `// ${name}.cfg: ${cpm ? 'CPM' : 'VQ3'} movement for ${map}, made with Q3BeamSearch (docs/SCRIPTING.md)`,
        `// Needs the modified oDFe. Put it in defrag/, then: df_promode ${cpm ? 1 : 0}, devmap ${map}, stand still at the spawn, scriptplay ${name}`,
        '// scriptplay sends one usercmd per wait in any engine; exec only matches in builds that count wait once a frame.',
        'set fixedtime 8; set com_maxfps 125; set cl_run 1; set cl_scriptRun 1',
        `scriptphysics ${cpm ? 'cpm' : 'vq3'}`,
        RELEASE,
        ...(startYaw === null ? [] : [`setyaw ${yawDeg(startYaw)}`]),
    ];
}

// What the tool expects after `frames` usercmds, then the game's own state (scriptpos).
function checkpoint(run, frames, what = 'expected') {
    const p = run.replay.positions[frames - 1], v = run.replay.velocities[frames - 1];
    return `echo ${what} after ${frames} frames: origin ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}, ${Math.round(Math.hypot(v.x, v.y))} ups, vz ${Math.round(v.z)}; scriptpos`;
}

// triggers (race-timer.js findTimerTriggers): also echo the race time DeFRaG should print
function footer(run, triggers) {
    const race = triggers ? raceTime(run.replay.positions, triggers) : null;
    return [RELEASE, 'set cl_scriptRun 0; set fixedtime 0', checkpoint(run, run.inputs.length, 'expected end'),
            ...(race?.ms != null ? [`echo expected race time ${formatMs(race.ms)} (start trigger left after frame ${race.start}, stop trigger at frame ${race.stop})`] : [])];
}

// The keys that give one frame's moves under cl_scriptRun (+moveup sends 10, +speed walks at 64).
function keysFor(inp, i) {
    const mags = [inp.f, inp.s, inp.u < 0 ? inp.u : 0].map(Math.abs).filter(Boolean);
    const m = mags[0] ?? 127;
    if (mags.some(x => x !== m) || (m !== 127 && m !== 64) || (inp.u > 0 && inp.u !== 10))
        throw new Error(`frame ${i}: moves ${inp.f}/${inp.s}/${inp.u} can't be made with keys`);
    const keys = new Set();
    if (inp.f > 0) keys.add('forward'); else if (inp.f < 0) keys.add('back');
    if (inp.s > 0) keys.add('moveright'); else if (inp.s < 0) keys.add('moveleft');
    if (inp.u > 0) keys.add('moveup'); else if (inp.u < 0) keys.add('movedown');
    if (m === 64) keys.add('speed');
    return keys;
}

const same = (a, b) => a.f === b.f && a.s === b.s && a.u === b.u && a.yawShort === b.yawShort;

// Frame-exact cfg lines for inputs [{f, s, u, yawShort}]. checkpointAt(i) may return a line
// to run right before frame i (i = 125, 250, ...); waits are split there.
export function bakeInputs(inputs, checkpointAt = () => null) {
    const lines = [];
    let held = new Set(), yaw = null;
    for (let i = 0; i < inputs.length;) {
        if (i && i % CHECK_EVERY === 0) { const c = checkpointAt(i); if (c) lines.push(c); }
        const inp = inputs[i], want = keysFor(inp, i), cmds = [];
        for (const k of held) if (!want.has(k)) cmds.push('-' + k);
        for (const k of want) if (!held.has(k)) cmds.push('+' + k);
        if (inp.yawShort !== yaw) cmds.push(`setyaw ${yawDeg(inp.yawShort)}`);
        let n = 1;
        while (i + n < inputs.length && same(inputs[i + n], inp) && (i + n) % CHECK_EVERY) n++;
        cmds.push(n > 1 ? `wait ${n}` : 'wait');
        lines.push(cmds.join('; '));
        held = want; yaw = inp.yawShort; i += n;
    }
    return lines;
}

const file = (name, lines) => ({ name: `${name}.cfg`, text: lines.join('\n') + '\n' });

// Baked export of a run's inputs. The expectations come from replaying the baked cfg in the
// tool, which starts at the landed spawn like the game; that replay must give the same usercmds.
// Returns {files: [{name, text}], run}.
export function exportBaked(inputs, { Q3, spawn, map, name, triggers = null, cpm = false }) {
    if (!inputs.length) throw new Error('nothing to export');
    const head = header(map, name, null, cpm);
    const run = runScript([...head, ...bakeInputs(inputs)].join('\n'), Q3, spawn, cpm);
    if (run.error) throw new Error(`baked cfg failed in the simulator: ${run.error}`);
    const lines = [...head, ...bakeInputs(inputs, i => checkpoint(run, i)), ...footer(run, triggers)];
    const check = runScript(lines.join('\n'), Q3, spawn, cpm);
    const i = inputs.findIndex((inp, k) => !check.inputs[k] || !same(inp, check.inputs[k]));
    if (check.error || i >= 0 || check.inputs.length !== inputs.length)
        throw new Error(check.error ?? `baked cfg doesn't reproduce frame ${i >= 0 ? i : check.inputs.length}`);
    return { files: [file(name, lines)], run: check };
}

// The script as written, with the header (start yaw = the spawn's, as the tool assumes) and
// footer. Returns {files, run}; run.error is set when the tool can't run the script.
export function exportScript(script, { Q3, spawn, map, name, triggers = null, cpm = false }) {
    const run = runScript(script, Q3, spawn, cpm);
    if (run.error) return { files: [], run };
    if (!run.inputs.length) throw new Error('the script runs no frames');
    const lines = [...header(map, name, spawnYawShort(spawn), cpm), ...script.replace(/\r/g, '').split('\n'), ...footer(run, triggers)];
    return { files: [file(name, lines)], run };
}
