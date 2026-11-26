// wwwroot/js/run-analysis.js
// Frame-by-frame movement analysis of a run, for the statistics dashboard (stats.js).
//
// Each frame is replayed with strafe.js's one-frame Pmove model (bit-exact on flat ground with
// no walls, snapping included) from the previous frame's velocity, with the frame's keys and
// yaw. When the model lands on the frame's real velocity it also asks the model for the best
// yaw short with the same keys, so efficiency = speed gained / the most it could have gained.
// Frames the model doesn't reproduce (walls, slopes, jump pads, runs without the Pmove
// velocity) get no efficiency. The CGaz angles are continuous and shown for every frame with keys.
import { simulate, bestYaw, strafeAngles } from './strafe.js';

export const FPS = 125;
const DEG = 180 / Math.PI;
export const wrapDeg = d => ((d % 360) + 540) % 360 - 180;   // to -180..180
const ANGLE2SHORT = deg => Math.trunc(deg * 65536 / 360) & 0xffff;

// frames: viewer frames [{x, y (= -Q3 y), z, vx?, vy? (Q3 Pmove velocity), speed, onGround,
// yawDeg, yawShort?, forwardMove, rightMove, upMove}], 125 per second. Returns one row per
// frame in Q3 coordinates; the per-move fields are null on frame 0 and where they don't apply.
export function analyseRun(frames, cpm = false) {
    let prev = null;
    return frames.map((fr, i) => {
        const x = fr.x, y = -fr.y, z = fr.z;
        const vx = fr.vx ?? (prev ? (x - prev.x) * FPS : 0), vy = fr.vy ?? (prev ? (y - prev.y) * FPS : 0);
        const keys = { f: fr.forwardMove ?? 0, s: fr.rightMove ?? 0, u: fr.upMove ?? 0 };
        const yaw = fr.yawDeg ?? 0;
        const row = {
            i, x, y, z, vx, vy, vz: prev ? (z - prev.z) * FPS : 0, speed: Math.hypot(vx, vy),
            onGround: !!fr.onGround, keys, yaw, velYaw: Math.atan2(vy, vx) * DEG,
            wishYaw: keys.f || keys.s ? yaw + Math.atan2(-keys.s, keys.f) * DEG : null,   // forward·f + right·s
            mode: null, gain: null, angle: null, opt: null, min: null, match: false, best: null, eff: null
        };
        if (prev) {
            row.gain = row.speed - prev.speed;
            // On the ground before the move (the last frame's ground trace): walk, or jump if it left the ground
            row.mode = !prev.onGround ? 'air' : keys.u > 0 && !row.onGround ? 'jump' : 'ground';
            const state = { vel: [prev.vx, prev.vy, prev.onGround ? 0 : prev.vz], mode: row.mode, cpm };
            const a = strafeAngles(state, keys);
            if (a) {
                const d = wrapDeg(row.wishYaw - prev.velYaw);
                row.angle = Math.abs(d); row.opt = a.opt * DEG; row.min = a.min * DEG;
                const [ox, oy] = simulate(state, keys, fr.yawShort ?? ANGLE2SHORT(yaw));
                row.match = ox === vx && oy === vy;   // the model reproduces this frame
                if (row.match) {
                    row.best = Math.hypot(...bestYaw(state, keys, d >= 0 ? 1 : -1).vel);   // same strafe side
                    const room = row.best - a.speed;
                    if (room > 0) row.eff = Math.min(100, Math.max(0, 100 * (row.speed - a.speed) / room));
                }
            }
        }
        prev = row;
        return row;
    });
}

// Whole-run numbers for the summary tiles. Averages are over the frames that have them (null: none).
export function summarise(rows) {
    let path = 0;
    for (let i = 1; i < rows.length; i++) path += Math.hypot(rows[i].x - rows[i - 1].x, rows[i].y - rows[i - 1].y);
    const keyed = rows.filter(r => r.angle !== null), rated = rows.filter(r => r.eff !== null);
    const matched = keyed.filter(r => r.match).length;
    return {
        frames: rows.length,
        seconds: rows.length / FPS,
        maxSpeed: rows.reduce((m, r) => Math.max(m, r.speed), 0),
        finalSpeed: rows.at(-1)?.speed ?? 0,
        path,
        jumps: rows.filter(r => r.mode === 'jump').length,
        groundShare: rows.length ? rows.filter(r => r.onGround).length / rows.length : 0,
        efficiency: rated.length ? rated.reduce((s, r) => s + r.eff, 0) / rated.length : null,
        atBest: rated.length ? rated.filter(r => r.speed >= r.best).length / rated.length : null,
        modelled: keyed.length ? matched / keyed.length : null
    };
}
