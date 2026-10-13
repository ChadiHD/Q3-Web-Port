// Flat-floor stand-in for q3physics.wasm (floor at z = 0, no walls) for the self-checks.
// Horizontal velocity comes from strafe.js's one-frame model, which matches the real
// Pmove bit for bit (yaw shorts, friction, PM_CmdScale, accel, snapping); vertical is
// jump / gravity averaging / landing, also snapped.
import { simulate, rint } from '../Q3BeamSearch/wwwroot/js/strafe.js';

export function flatFloorQ3() {
    const h = new Float32Array(16);
    let ground = false, jumpHeld = false;
    return {
        HEAPF32: h,
        _malloc: () => 0,
        _InitPhysics() { ground = false; jumpHeld = false; },
        _IsPlayerOnGround: () => (ground ? 1 : 0),
        _GetPmFlags: () => (jumpHeld ? 2 : 0),   // PMF_JUMP_HELD
        _StepPhysics(pp, vp, ap, f, s, u, buttons, dt) {
            const p = pp >> 2, v = h.subarray(vp >> 2, (vp >> 2) + 3);
            const yawShort = Math.trunc(Math.fround(Math.fround(h[(ap >> 2) + 1]) * 65536) / 360) & 0xffff; // ANGLE2SHORT
            if (u < 10) jumpHeld = false;
            const walking = h[p + 2] <= 24.25 && v[2] <= 0;               // PM_GroundTrace before the move
            let mode = walking ? 'ground' : 'air';
            if (walking && u >= 10 && !jumpHeld) { mode = 'jump'; jumpHeld = true; }
            const [vx, vy] = simulate({ vel: [...v], mode }, { f, s, u }, yawShort);
            let vz = mode === 'jump' ? 270 : mode === 'ground' ? 0 : v[2];
            const end = mode === 'ground' ? 0 : vz - 800 * dt;
            h[p] += vx * dt; h[p + 1] += vy * dt; h[p + 2] += (vz + end) / 2 * dt;
            vz = rint(end);
            ground = h[p + 2] <= 24.25 && vz <= 0;                         // ground trace after the move
            if (h[p + 2] < 24) { h[p + 2] = 24; vz = 0; }
            if (ground) vz = 0;
            v[0] = vx; v[1] = vy; v[2] = vz;
        },
    };
}
