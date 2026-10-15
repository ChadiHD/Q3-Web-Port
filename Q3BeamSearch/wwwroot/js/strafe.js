// wwwroot/js/strafe.js
// Snap-aware VQ3 / CPM yaw chooser.
//
// Pmove rounds the velocity to whole units at the end of every frame
// (trap_SnapVector), so the best view angle is the one whose ROUNDED velocity
// scores highest, not the continuous CGaz angle. This file has a one-frame model
// of bg_pmove.c in float32 (flat ground, no walls) and searches the 65536 yaw
// shorts with seeds + a coarse grid + bisection instead of trying them all.
// Engine twin: CL_SnapYaw in oDFe code/client/cl_snapyaw.c (same algorithm).
// CPM (state.cpm, DeFRaG df_promode 1) follows the WASM's PM_AirMove / PM_WalkMove.

const f = Math.fround;
const FT = f(0.008);                 // pml.frametime at 125 fps
const SPEED = 320, STOP_SPEED = 100, FRICTION = 6, ACCEL = 10, AIR_ACCEL = 1;
const JUMP_VELOCITY = 270, OVERCLIP = f(1.001);
// CPM: ground accel, air accel against the velocity, strafe keys alone (accel, wishspeed cap), air control
const CPM_ACCEL = 15, CPM_AIR_STOP = 2.5, CPM_STRAFE_ACCEL = 70, CPM_STRAFE_WISH = 30, CPM_AIR_CONTROL = 150;
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

// Everything that doesn't depend on the yaw: friction, cmd scale, jump, accel.
// mode: 'air', 'ground' (walking, jump not pressed or still held) or 'jump'
// (on the ground and this frame jumps: PM_CheckJump then AirMove).
function prepare(vel, mode, keys, cpm) {
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
    const p = { vx, vy, vz, F: keys.f, S: keys.s, scale, accel: ground ? ACCEL : AIR_ACCEL, ground,
                cap: Infinity, stop: 0, control: false };
    if (cpm && ground) p.accel = CPM_ACCEL;
    else if (cpm && !keys.f && keys.s) { p.accel = CPM_STRAFE_ACCEL; p.cap = CPM_STRAFE_WISH; }
    else if (cpm) { p.stop = CPM_AIR_STOP; p.control = !!keys.f && !keys.s; }
    return p;
}

// Normalized forward vector (FX, FY) of every yaw short, as PM_UpdateViewAngles (signed short)
// + AngleVectors at pitch = roll = 0 make it in float32; right = (FY, -FX). Depends on the short
// only, so it's built once on first use instead of a sin / cos pair per evaluated short.
let FX = null, FY = null;
function buildVectors() {
    FX = new Float32Array(SHORTS); FY = new Float32Array(SHORTS);
    for (let s = 0; s < SHORTS; s++) {
        const yaw = f((s >= HALF ? s - SHORTS : s) * (360 / SHORTS));
        const a = f(yaw * DEG2RAD), sy = f(Math.sin(a)), cy = f(Math.cos(a));
        const il = f(1 / f(Math.sqrt(f(f(cy * cy) + f(sy * sy)))));
        FX[s] = f(cy * il); FY[s] = f(sy * il);
    }
}

// outcome() result: the snapped horizontal velocity (module variables, so the search
// allocates nothing per evaluated short).
let OX = 0, OY = 0;

// Horizontal velocity after the frame, snapped, for yaw short `s`: sets OX, OY.
function outcome(p, s) {
    if (!FX) buildVectors();
    // forward = (fx, fy), right = (fy, -fx) = (sy, -cy) normalized
    const fx = FX[s], fy = FY[s], rx = fy, ry = -fx;
    const wx = f(f(fx * p.F) + f(rx * p.S)), wy = f(f(fy * p.F) + f(ry * p.S));
    let vx = p.vx, vy = p.vy, vz = p.vz;

    // PM_Accelerate (CPM: accel 2.5 against the velocity, a wishspeed cap for strafe keys alone)
    const wl = f(Math.sqrt(f(f(wx * wx) + f(wy * wy))));
    if (wl) {
        const iw = f(1 / wl), dx = f(wx * iw), dy = f(wy * iw), ws = Math.min(f(wl * p.scale), p.cap);
        const dot = f(f(vx * dx) + f(vy * dy)), add = f(ws - dot);
        if (add > 0) {
            let acc = f(f((p.stop && dot < 0 ? p.stop : p.accel) * FT) * ws);
            if (acc > add) acc = add;
            vx = f(vx + f(acc * dx)); vy = f(vy + f(acc * dy));
        }
        // PM_CPMAirControl: forward or back alone turns the velocity toward the wish direction
        if (p.control) {
            const sp = f(Math.sqrt(f(f(vx * vx) + f(vy * vy))));
            if (sp) {
                const is = f(1 / sp);
                let nx = f(vx * is), ny = f(vy * is);
                const d = f(f(nx * dx) + f(ny * dy));
                if (d > 0) {
                    const k = f(f(f(32 * CPM_AIR_CONTROL) * f(d * d)) * FT);
                    nx = f(f(nx * sp) + f(dx * k)); ny = f(f(ny * sp) + f(dy * k));
                    const l = f(Math.sqrt(f(f(nx * nx) + f(ny * ny))));
                    if (l) { const il2 = f(1 / l); nx = f(nx * il2); ny = f(ny * il2); }
                }
                vx = f(nx * sp); vy = f(ny * sp);
            }
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
    OX = rint(vx); OY = rint(vy);
}

// One frame: snapped horizontal velocity for state {vel, mode}, keys {f, s, u}, yaw short.
export function simulate(state, keys, yawShort) {
    outcome(prepare(state.vel, state.mode, keys, state.cpm), yawShort & 0xffff);
    return [OX, OY];
}

// bestYaw's scratch, reused by every call: a search point t (0..HALF-1) is marked or
// evaluated in this call when its stamp equals `gen`. Replaces a Map, a Set and two
// comparator sorts per call.
const marked = new Int32Array(HALF), seen = new Int32Array(HALF);
const outX = new Int32Array(HALF), outY = new Int32Array(HALF);
const starts = new Int32Array(HALF), evaluated = new Int32Array(HALF);
let gen = 0;

// Best yaw short for this frame.
//   state: { vel: [x, y, z], mode: 'air' | 'ground' | 'jump', cpm: CPM physics }
//   keys:  { f, s, u } as sent in the usercmd (-127..127)
//   side:  +1 = wish direction left of the velocity (turn left), -1 = right
//   score: { aim: unit [x, y] or null, lambda } scores (1-λ)|v'| + λ v'·aim; default speed only
// Returns { yawShort, vel: [x, y], evals } or null when the yaw can't matter
// (no movement keys, or standing still: keep the current view).
export function bestYaw(state, keys, side, { aim = null, lambda = 0 } = {}) {
    const p = prepare(state.vel, state.mode, keys, state.cpm);
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
    //    (CPM: also the smaller circle of the 2.5 accel against the velocity)
    const W = Math.min(Math.hypot(keys.f, keys.s) * p.scale, p.cap), A = p.accel * 0.008 * W;
    const psis = [];
    for (const R of p.stop ? [A, p.stop * 0.008 * W] : [A]) {
        for (let n = Math.floor(p.vx - R); n <= Math.ceil(p.vx + R); n++) {
            const c = (n + 0.5 - p.vx) / R;
            if (Math.abs(c) <= 1) { const t = Math.acos(c); psis.push(t, -t); }
        }
        for (let n = Math.floor(p.vy - R); n <= Math.ceil(p.vy + R); n++) {
            const c = (n + 0.5 - p.vy) / R;
            if (Math.abs(c) <= 1) { const t = Math.asin(c); psis.push(t, Math.PI - t); }
        }
    }
    if (v > W - A) {
        const dOpt = Math.acos((W - A) / v), dMin = v > W ? Math.acos(W / v) : 0;
        psis.push(va + dOpt, va - dOpt, va + dMin, va - dMin);
    }
    if (++gen === 0x7fffffff) { marked.fill(0); seen.fill(0); gen = 1; }
    let nStarts = 0, nEval = 0;
    const mark = t => { if (marked[t] !== gen) { marked[t] = gen; starts[nStarts++] = t; } };
    mark(0); mark(HALF - 1);
    for (const psi of psis) {
        const t = tOf(psi);
        for (let d = -1; d <= 1; d++) if (t + d >= 0 && t + d < HALF) mark(t + d);
    }
    // 2) coarse grid (the ground accel circle is big, and CPM air control curves back on
    //    itself, so they need finer ones)
    const step = p.ground ? 64 : p.control ? 256 : 1024;
    for (let t = 0; t < HALF; t += step) mark(t);

    // 3) bisect between neighbours whose outcomes differ, down to one short
    const at = t => {
        if (seen[t] === gen) return;
        seen[t] = gen; outcome(p, yawAt(t)); outX[t] = OX; outY[t] = OY; evaluated[nEval++] = t;
    };
    const same = (a, b) => outX[a] === outX[b] && outY[a] === outY[b];
    const split = (a, b) => {
        at(a); at(b);   // evaluate both ends first: they become zone edges
        if (same(a, b) || b - a <= 1) return;
        const m = (a + b) >> 1;
        split(a, m); split(m, b);
    };
    const sorted = starts.subarray(0, nStarts).sort();   // typed array: numeric sort, in place
    for (let i = 0; i + 1 < nStarts; i++) split(sorted[i], sorted[i + 1]);

    // 4) zones = runs of equal outcome; best score wins, ties go to the smaller turn.
    //    Answer the zone's middle short so float differences (JS vs C) can't flip it.
    const ordered = evaluated.subarray(0, nEval).sort();
    let bestFrom = 0, bestTo = 0, bestScore = -Infinity, from = ordered[0];
    for (let i = 0; i < nEval; i++) {
        const t = ordered[i];
        if (i + 1 < nEval && same(t, ordered[i + 1])) continue;
        const ox = outX[t], oy = outY[t], sp = Math.hypot(ox, oy);
        const sc = aim ? (1 - lambda) * sp + lambda * (ox * aim[0] + oy * aim[1]) : sp;
        if (sc > bestScore + 1e-9) { bestScore = sc; bestFrom = from; bestTo = t; }
        from = ordered[i + 1];
    }
    return { yawShort: yawAt((bestFrom + bestTo) >> 1), vel: [outX[bestTo], outY[bestTo]], evals: nEval };
}

// The continuous CGaz angle (ignores snapping) rounded to a short: +strafebot.
export function cgazYaw(state, keys, side) {
    const p = prepare(state.vel, state.mode, keys, state.cpm);
    const v = Math.hypot(p.vx, p.vy);
    if ((!keys.f && !keys.s) || v < 1) return null;
    const W = Math.min(Math.hypot(keys.f, keys.s) * p.scale, p.cap), A = p.accel * 0.008 * W;
    const d = v > W - A ? Math.acos((W - A) / v) : 0;   // max-accel angle between wish and velocity
    const yaw = Math.atan2(p.vy, p.vx) + side * d - Math.atan2(-keys.s, keys.f);
    const s = ((Math.round(yaw * SHORTS / (2 * Math.PI)) % SHORTS) + SHORTS) % SHORTS;
    outcome(p, s);
    return { yawShort: s, vel: [OX, OY] };
}
