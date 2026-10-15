// wwwroot/js/movement-script.js
// Runs a movement script the way the modified oDFe runs it with cl_scriptRun 1
// (References/oDFe/code/client/cl_input.c), on the real WASM Pmove, so the viewer shows
// what `exec` does in game. Same order as the engine:
//   - Cbuf: the commands up to `wait N` run, then N frames (usercmds) use that state
//     (oDFe Cbuf_Wait counts once per frame; bare `wait` = 1, `wait 0` = no frame).
//   - Each frame is CL_CreateCmd: CL_AdjustAngles turns the script yaw (+left / +right,
//     float math identical to the engine's), CL_KeyMove, the upmove 10 cap, CL_MoveBots
//     (+autojump / +snapbot / +strafebot from the previous frame's result), then the cmd
//     yaw is ANGLE2SHORT(script yaw). The mouse is ignored.
//   - The run starts at the map spawn, landed, facing the spawn angle.
//   - cpm: CPM physics (DeFRaG df_promode 1) for Pmove and the bots; `scriptphysics vq3|cpm`
//     (exports start with it) must match it.

import { bestYaw, cgazYaw, shortToYaw } from './strafe.js';
import { PmoveRunner } from './pmove-runner.js';

const f = Math.fround;
export const ANGLE2SHORT = deg => Math.trunc(f(f(deg * 65536) / 360)) & 0xffff;
const PMF_JUMP_HELD = 2, PMF_RESPAWNED = 512;
const MAX_FRAMES = 125 * 600;   // 10 minutes

// +key / -key buttons the engine has, by command name
export const KEYS = ['forward', 'back', 'moveleft', 'moveright', 'moveup', 'movedown', 'left', 'right',
              'speed', 'strafe', 'autojump', 'snapbot', 'strafebot'];
// cvars the movement depends on (engine defaults), and what the run must keep
const CVARS = { cl_yawspeed: '140', cl_anglespeedkey: '1.5', cl_run: '1' };
const FIXED = { cl_scriptRun: '1', fixedtime: '8', com_maxfps: '125', sv_fps: '125', g_speed: '320', g_gravity: '800' };
// commands that don't change movement
const NO_EFFECT = new Set(['echo', 'viewpos', 'centerview', 'clear', 'scriptpos']);

class ScriptError extends Error {
    constructor(line, message) { super(`line ${line}: ${message}`); this.line = line; }
}

// Cbuf_Execute's split: ';' or a line break ends a command (';' not inside quotes);
// "//" to the end of the line and /* ... */ are comments.
function splitCommands(text) {
    const out = [];
    let cur = '', line = 1, startLine = 1, quotes = false;
    const push = () => { if (cur.trim()) out.push({ text: cur.trim(), line: startLine }); cur = ''; startLine = line; };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (!quotes && c === '/' && text[i + 1] === '/') {
            while (i + 1 < text.length && text[i + 1] !== '\n') i++;
            continue;
        }
        if (!quotes && c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2), stop = end < 0 ? text.length : end + 2;
            for (let j = i; j < stop; j++) if (text[j] === '\n') line++;
            i = stop - 1;
            continue;
        }
        if (c === '"') quotes = !quotes;
        if (c === '\n' || c === '\r' || (c === ';' && !quotes)) {
            push();
            if (c === '\n') { line++; quotes = false; startLine = line; }
            continue;
        }
        cur += c;
    }
    push();
    return out;
}

// The server yaw short at spawn: SetClientViewAngle gives ANGLE2SHORT(spawn angle).
export const spawnYawShort = spawn => ANGLE2SHORT(f(spawn?.angle || 0));

const tokenize = s => [...s.matchAll(/"([^"]*)"?|(\S+)/g)].map(m => m[1] ?? m[2]);
const atoi = s => parseInt(s, 10) || 0;

// Runs `text` from the spawn ({origin: Q3 [x, y, z], angle: degrees}, or null: origin 0).
// Returns {inputs: [{f, s, u, yaw, yawShort}], replay: {positions, velocities, onGround},
// start, error}. On an error the frames up to it are still returned.
export function runScript(text, Q3, spawn = null, cpm = false) {
    const sim = new PmoveRunner(Q3, cpm);
    const start = sim.settle(spawn ? spawn.origin : [0, 0, 0]);
    const st = sim.reset(start);
    const keys = Object.fromEntries(KEYS.map(k => [k, false]));
    const cvars = { ...CVARS, ...FIXED };
    const num = name => f(parseFloat(cvars[name]) || 0);
    let yaw = f(shortToYaw(spawnYawShort(spawn)));   // the server yaw at spawn, as the script yaw
    let scriptRunModified = false;

    const inputs = [], positions = [], velocities = [], onGround = [];

    // One CL_CreateCmd + Pmove.
    function frame() {
        if (scriptRunModified) {   // cl_scriptRun switched on: script yaw restarts from the server yaw
            scriptRunModified = false;
            yaw = f(shortToYaw(ANGLE2SHORT(yaw)));
        }

        // CL_AdjustAngles (cls.frametime = 8 with fixedtime 8)
        const speed = keys.speed ? f(0.001 * 8 * num('cl_anglespeedkey')) : f(0.001 * 8);
        if (!keys.strafe) {
            const t = f(speed * num('cl_yawspeed'));
            yaw = f(yaw - f(t * (keys.right ? 1 : 0)));
            yaw = f(yaw + f(t * (keys.left ? 1 : 0)));
        }

        // CL_KeyMove (cfg keys carry no timestamp, so CL_KeyState is exactly 0 or 1)
        const movespeed = ((keys.speed ? 1 : 0) ^ atoi(cvars.cl_run)) ? 127 : 64;
        const k = name => (keys[name] ? movespeed : 0);
        const clamp = v => Math.max(-127, Math.min(127, v));
        let side = (keys.strafe ? k('right') - k('left') : 0) + k('moveright') - k('moveleft');
        let fwd = clamp(k('forward') - k('back'));
        let up = clamp(k('moveup') - k('movedown'));
        side = clamp(side);
        if (up > 10) up = 10;   // cl_scriptRun: a jump only needs 10, and 10 keeps the wishspeed

        // CL_MoveBots, on the previous frame's result (cl.snap.ps)
        const canJump = st.onGround && !(st.pmFlags & (PMF_JUMP_HELD | PMF_RESPAWNED));
        if (keys.autojump && canJump) up = 10;
        if (keys.snapbot || keys.strafebot) {
            if (!side) {
                const turn = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);   // +1 left, -1 right
                if (turn) side = -movespeed * turn;
            }
            if (side) {
                const mode = !st.onGround ? 'air' : canJump && up >= 10 ? 'jump' : 'ground';
                const pick = keys.snapbot ? bestYaw : cgazYaw;
                const r = pick({ vel: st.vel, mode, cpm }, { f: fwd, s: side, u: up }, side < 0 ? 1 : -1);
                if (r) yaw = f(shortToYaw(r.yawShort));
            }
        }

        const inp = { f: fwd, s: side, u: up, yaw, yawShort: ANGLE2SHORT(yaw) };
        sim.step(st, inp);
        inputs.push(inp);
        positions.push({ x: st.pos[0], y: st.pos[1], z: st.pos[2] });
        velocities.push({ x: st.vel[0], y: st.vel[1], z: st.vel[2] });
        onGround.push(st.onGround);
    }

    function setCvar(name, value) {
        const key = Object.keys(cvars).find(c => c.toLowerCase() === name.toLowerCase()) ?? name;
        if (key === 'cl_scriptRun' && cvars[key] !== value) scriptRunModified = true;
        cvars[key] = value;
    }

    // Setting them is fine (an export's footer restores them); running frames isn't.
    function checkFixed(line) {
        for (const [key, want] of Object.entries(FIXED))
            if (parseFloat(cvars[key]) !== parseFloat(want))
                throw new ScriptError(line, `the simulator runs scripts with ${key} ${want}`);
    }

    function execute({ text: cmdText, line }) {
        const args = tokenize(cmdText);
        if (!args.length) return;
        const cmd = args[0].toLowerCase();

        if (cmd[0] === '+' || cmd[0] === '-') {
            const name = cmd.slice(1);
            if (!KEYS.includes(name)) throw new ScriptError(line, `${args[0]} isn't supported by the simulator`);
            if (args.length > 1) throw new ScriptError(line, `${args[0]} takes no arguments in a script`);
            keys[name] = cmd[0] === '+';
        } else if (cmd === 'wait') {
            let n = args.length === 2 ? atoi(args[1]) : 1;
            if (n < 0) n = 1;
            if (n) checkFixed(line);
            if (inputs.length + n > MAX_FRAMES) throw new ScriptError(line, `script runs past ${MAX_FRAMES} frames`);
            for (let i = 0; i < n; i++) frame();
        } else if (cmd === 'setyaw') {
            if (args.length !== 2) throw new ScriptError(line, 'usage: setyaw <degrees>');
            const s = Math.floor((parseFloat(args[1]) || 0) * 65536 / 360 + 0.5) & 0xffff;
            yaw = f(shortToYaw(s));
        } else if (cmd === 'scriptphysics') {
            const want = (args[1] ?? '').toLowerCase();
            if (args.length !== 2 || (want !== 'vq3' && want !== 'cpm')) throw new ScriptError(line, 'usage: scriptphysics <vq3|cpm>');
            if ((want === 'cpm') !== cpm) throw new ScriptError(line, `the script is for ${want.toUpperCase()}: switch Physics to ${want.toUpperCase()}`);
        } else if (cmd === 'df_promode' || (/^set[asu]?$/.test(cmd) && args[1]?.toLowerCase() === 'df_promode')) {
            throw new ScriptError(line, 'df_promode only changes with the map: pick VQ3 or CPM in the Physics menu (exports add scriptphysics)');
        } else if (cmd === 'set' || cmd === 'seta' || cmd === 'sets' || cmd === 'setu') {
            if (args.length < 3) throw new ScriptError(line, `usage: ${cmd} <variable> <value>`);
            setCvar(args[1], args.slice(2).join(' '));
        } else if (Object.keys(cvars).some(c => c.toLowerCase() === cmd)) {
            if (args.length > 1) setCvar(args[0], args.slice(1).join(' '));
        } else if (!NO_EFFECT.has(cmd)) {
            throw new ScriptError(line, `Unknown command "${args[0]}"`);
        }
    }

    let error = null;
    try {
        for (const c of splitCommands(text)) execute(c);
    } catch (e) {
        if (!(e instanceof ScriptError)) throw e;
        error = e.message;
    }
    return { inputs, replay: { positions, velocities, onGround }, start: start.pos, error };
}
