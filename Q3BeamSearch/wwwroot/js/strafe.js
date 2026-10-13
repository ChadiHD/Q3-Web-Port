// wwwroot/js/strafe.js
// Snap-aware VQ3 yaw chooser.
//
// Pmove rounds the velocity to whole units at the end of every frame
// (trap_SnapVector), so the best view angle is the one whose ROUNDED velocity
// scores highest, not the continuous CGaz angle. This file has a one-frame model
// of bg_pmove.c in float32 (flat ground, no walls) and searches the 65536 yaw
// shorts with seeds + a coarse grid + bisection instead of trying them all.
// Engine twin: CL_SnapYaw in oDFe code/client/cl_snapyaw.c (same algorithm).

const f = Math.fround;
const FT = f(0.008);                 // pml.frametime at 125 fps
const SPEED = 320, STOP_SPEED = 100, FRICTION = 6, ACCEL = 10, AIR_ACCEL = 1;
const JUMP_VELOCITY = 270, OVERCLIP = f(1.001);
const DEG2RAD = (Math.PI * 2) / 360; // AngleVectors' M_PI*2/360
const SHORTS = 65536, HALF = 32768;

// Round half to even, like Sys_SnapVector's SSE/x87 rounding.
export function rint(x) {
    const fl = Math.floor(x), d = x - fl;
    return d < 0.5 ? fl : d > 0.5 ? fl + 1 : fl % 2 === 0 ? fl : fl + 1;
}

// View yaw in degrees that ANGLE2SHORT (which truncates) turns back into `s`.
export const shortToYaw = s => (s + 0.5) * 360 / SHORTS;

const len3 = (x, y, z) => f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));

// Everything that doesn't depend on the yaw: friction, cmd scale, jump.
// mode: 'air', 'ground' (walking, jump not pressed or still held) or 'jump'
// (on the ground and this frame jumps: PM_CheckJump then AirMove).
function prepare(vel, mode, keys) {
    let vx = f(vel[0]), vy = f(vel[1]), vz = f(vel[2] ?? 0);
    const ground = mode === 'ground';
    const up = ground ? 0 : keys.u;   // ground: a held jump gets upmove cleared by PM_CheckJump
    if (mode === 'jump') vz = JUMP_VELOCITY;

    // PM_Friction (in the air only the "speed < 1" stop applies)
    const sp = len3(vx, vy, ground ? 0 : vz);
    if (sp < 1) { vx = 0; vy = 0; }
    else if (ground) {
        const control = sp < STOP_SPEED ? STOP_SPEED : sp;
        let ns = f(sp - f(f(control * FRICTION) * FT));
        if (ns < 0) ns = 0;
        ns = f(ns / sp);
        vx = f(vx * ns); vy = f(vy * ns); vz = f(vz * ns);
    }

    // PM_CmdScale
    const max = Math.max(Math.abs(keys.f), Math.abs(keys.s), Math.abs(up));
    const total = f(Math.sqrt(keys.f * keys.f + keys.s * keys.s + up * up));
    const scale = max ? f(f(SPEED * max) / (127 * total)) : 0;
    return { vx, vy, vz, F: keys.f, S: keys.s, scale, accel: ground ? ACCEL : AIR_ACCEL, ground };
}

// Horizontal velocity after the frame, snapped, for yaw short `s`.
function outcome(p, s) {
    // PM_UpdateViewAngles (signed short) + AngleVectors at pitch = roll = 0
    const yaw = f((s >= HALF ? s - SHORTS : s) * (360 / SHORTS));
    const a = f(yaw * DEG2RAD), sy = f(Math.sin(a)), cy = f(Math.cos(a));
    // forward = (cy, sy), right = (sy, -cy); both normalized
    const il = f(1 / f(Math.sqrt(f(f(cy * cy) + f(sy * sy)))));
    const fx = f(cy * il), fy = f(sy * il), rx = f(sy * il), ry = f(-cy * il);
    const wx = f(f(fx * p.F) + f(rx * p.S)), wy = f(f(fy * p.F) + f(ry * p.S));
    let vx = p.vx, vy = p.vy, vz = p.vz;

    // PM_Accelerate
    const wl = f(Math.sqrt(f(f(wx * wx) + f(wy * wy))));
    if (wl) {
        const iw = f(1 / wl), dx = f(wx * iw), dy = f(wy * iw), ws = f(wl * p.scale);
        const add = f(ws - f(f(vx * dx) + f(vy * dy)));
        if (add > 0) {
            let acc = f(f(p.accel * FT) * ws);
            if (acc > add) acc = add;
            vx = f(vx + f(acc * dx)); vy = f(vy + f(acc * dy));
        }
    }

    // PM_WalkMove: clip to the (flat) ground plane, keep the speed
    if (p.ground) {
        const vl = len3(vx, vy, vz);
        const back = vz < 0 ? f(vz * OVERCLIP) : f(vz / OVERCLIP);
        vz = f(vz - back);
        const n = len3(vx, vy, vz);
        if (n) {
            const inv = f(1 / n);
            vx = f(f(vx * inv) * vl); vy = f(f(vy * inv) * vl);
        }
    }
    return [rint(vx), rint(vy)];
}

// One frame: snapped horizontal velocity for state {vel, mode}, keys {f, s, u}, yaw short.
export function simulate(state, keys, yawShort) {
    return outcome(prepare(state.vel, state.mode, keys), yawShort & 0xffff);
}

// Best yaw short for this frame.
//   state: { vel: [x, y, z], mode: 'air' | 'ground' | 'jump' }
//   keys:  { f, s, u } as sent in the usercmd (-127..127)
//   side:  +1 = wish direction left of the velocity (turn left), -1 = right
//   score: { aim: unit [x, y] or null, lambda } scores (1-λ)|v'| + λ v'·aim; default speed only
// Returns { yawShort, vel: [x, y], evals } or null when the yaw can't matter
// (no movement keys, or standing still: keep the current view).
export function bestYaw(state, keys, side, { aim = null, lambda = 0 } = {}) {
    const p = prepare(state.vel, state.mode, keys);
    const v = Math.hypot(p.vx, p.vy);
    if ((!keys.f && !keys.s) || v < 1) return null;

    const va = Math.atan2(p.vy, p.vx);
    const offset = Math.atan2(-keys.s, keys.f);           // wish direction relative to the view
    const k = SHORTS / (2 * Math.PI);
    const base = ((Math.round((va - offset) * k) % SHORTS) + SHORTS) % SHORTS;
    // t = 0..HALF-1 walks from the velocity direction (δ = 0) toward the chosen side
    const yawAt = t => (base + side * t + SHORTS) & 0xffff;
    const tOf = psi => (((Math.round((psi - offset) * k) - base) * side) % SHORTS + SHORTS) % SHORTS;

    // 1) seeds: where the full-accel circle crosses a rounding line (x or y = n + 0.5),
    //    and the edges of the clamped band (addspeed between 0 and a), each ±1 short
    const W = Math.hypot(keys.f, keys.s) * p.scale, A = p.accel * 0.008 * W;
    const psis = [];
    for (let n = Math.floor(p.vx - A); n <= Math.ceil(p.vx + A); n++) {
        const c = (n + 0.5 - p.vx) / A;
        if (Math.abs(c) <= 1) { const t = Math.acos(c); psis.push(t, -t); }
    }
    for (let n = Math.floor(p.vy - A); n <= Math.ceil(p.vy + A); n++) {
        const c = (n + 0.5 - p.vy) / A;
        if (Math.abs(c) <= 1) { const t = Math.asin(c); psis.push(t, Math.PI - t); }
    }
    if (v > W - A) {
        const dOpt = Math.acos((W - A) / v), dMin = v > W ? Math.acos(W / v) : 0;
        psis.push(va + dOpt, va - dOpt, va + dMin, va - dMin);
    }
    const ts = new Set([0, HALF - 1]);
    for (const psi of psis) {
        const t = tOf(psi);
        for (const d of [-1, 0, 1]) if (t + d >= 0 && t + d < HALF) ts.add(t + d);
    }
    // 2) coarse grid (the ground accel circle is big, so it needs a finer one)
    const step = p.ground ? 64 : 1024;
    for (let t = 0; t < HALF; t += step) ts.add(t);

    // 3) bisect between neighbours whose outcomes differ, down to one short
    let evals = 0;
    const out = new Map();
    const at = t => { let o = out.get(t); if (!o) { o = outcome(p, yawAt(t)); out.set(t, o); evals++; } return o; };
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const split = (a, b) => {
        if (same(at(a), at(b)) || b - a <= 1) return;   // evaluate both ends first: they become zone edges
        const m = (a + b) >> 1;
        split(a, m); split(m, b);
    };
    const sorted = [...ts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) split(sorted[i], sorted[i + 1]);

    // 4) zones = runs of equal outcome; best score wins, ties go to the smaller turn.
    //    Answer the zone's middle short so float differences (JS vs C) can't flip it.
    const score = o => {
        const sp = Math.hypot(o[0], o[1]);
        return aim ? (1 - lambda) * sp + lambda * (o[0] * aim[0] + o[1] * aim[1]) : sp;
    };
    const ordered = [...out.keys()].sort((a, b) => a - b);
    let best = null, bestScore = -Infinity, start = ordered[0];
    for (let i = 0; i < ordered.length; i++) {
        const t = ordered[i], o = out.get(t), next = ordered[i + 1];
        if (next !== undefined && same(o, out.get(next))) continue;
        const sc = score(o);
        if (sc > bestScore + 1e-9) { bestScore = sc; best = { from: start, to: t, vel: o }; }
        start = next;
    }
    return { yawShort: yawAt((best.from + best.to) >> 1), vel: best.vel, evals };
}

// The continuous CGaz angle (ignores snapping) rounded to a short: +strafebot.
export function cgazYaw(state, keys, side) {
    const p = prepare(state.vel, state.mode, keys);
    const v = Math.hypot(p.vx, p.vy);
    if ((!keys.f && !keys.s) || v < 1) return null;
    const W = Math.hypot(keys.f, keys.s) * p.scale, A = p.accel * 0.008 * W;
    const d = v > W - A ? Math.acos((W - A) / v) : 0;   // max-accel angle between wish and velocity
    const yaw = Math.atan2(p.vy, p.vx) + side * d - Math.atan2(-keys.s, keys.f);
    const s = ((Math.round(yaw * SHORTS / (2 * Math.PI)) % SHORTS) + SHORTS) % SHORTS;
    return { yawShort: s, vel: outcome(p, s) };
}
