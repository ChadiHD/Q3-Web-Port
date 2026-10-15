// wwwroot/js/pmove-runner.js
// Steps the real oDFe Pmove in q3physics.wasm one usercmd (8 msec, 125 fps) at a time.
// Shared by the route optimizer and the movement-script runner. cpm: CPM physics (DeFRaG df_promode 1).

import { bestYaw } from './strafe.js';

const DT = 0.008;
const SPAWN_UP = 9;   // the game spawns the player 9 units above the spawn point
const MODES = { air: 0, ground: 1, jump: 2 };   // cl_snapyaw.h snapMode_t

export class PmoveRunner {
    constructor(Q3, cpm = false) {
        this.Q3 = Q3;
        this.cpm = cpm;
        this.ptr = Q3._malloc(36);   // pos[3], vel[3], angles[3] for StepPhysics
        this.yawOut = Q3._malloc(8); // SnapYaw's snapped x/y velocity
    }

    // strafe.js bestYaw (same arguments and result), run by its C twin in the WASM
    // (cl_snapyaw.c, export SnapYaw: same picks, tests/snapyaw-wasm.check.mjs) when the build
    // has it, else by strafe.js.
    bestYaw(state, keys, side, { aim = null, lambda = 0 } = {}) {
        const Q3 = this.Q3;
        if (typeof Q3._SnapYaw !== 'function') return bestYaw(state, keys, side, { aim, lambda });
        const v = state.vel;
        const s = Q3._SnapYaw(v[0], v[1], v[2] ?? 0, MODES[state.mode], keys.f, keys.s, keys.u, side, state.cpm ? 1 : 0,
            aim?.[0] ?? 0, aim?.[1] ?? 0, lambda, aim ? 1 : 0, this.yawOut);
        if (s < 0) return null;
        const b = this.yawOut >> 2;
        return { yawShort: s, vel: [Q3.HEAP32[b], Q3.HEAP32[b + 1]] };
    }

    // Fresh Pmove state at rest at `start` ({pos, onGround}). InitPhysics clears the ground /
    // jump-held state the previous run left in the global playerState, so every run is
    // exactly reproducible.
    reset(start) {
        this.Q3._InitPhysics();
        this.Q3._SetPromode(this.cpm ? 1 : 0);
        const b = this.ptr >> 2;
        this.Q3.HEAPF32.set(start.pos, b);
        this.Q3.HEAPF32.fill(0, b + 3, b + 9);
        return { pos: [...start.pos], vel: [0, 0, 0], onGround: start.onGround, pmFlags: 0 };
    }

    // One usercmd: inp = {f, s, u, yaw}; yaw in degrees goes through ANGLE2SHORT like
    // cmd.angles. Updates st with the result (what the next cmd's snapshot holds).
    step(st, inp) {
        const Q3 = this.Q3, b = this.ptr >> 2;
        Q3.HEAPF32[b + 7] = inp.yaw;
        Q3._StepPhysics(this.ptr, this.ptr + 12, this.ptr + 24, inp.f, inp.s, inp.u, 0, DT);
        const h = Q3.HEAPF32;
        st.pos[0] = h[b]; st.pos[1] = h[b + 1]; st.pos[2] = h[b + 2];
        st.vel[0] = h[b + 3]; st.vel[1] = h[b + 4]; st.vel[2] = h[b + 5];
        st.onGround = Q3._IsPlayerOnGround() === 1;
        st.pmFlags = Q3._GetPmFlags();
    }

    // Spawn like the game (9 units up), then idle until landed and at rest: that is where a
    // script or route starts in game.
    settle(origin) {
        const st = this.reset({ pos: [origin[0], origin[1], origin[2] + SPAWN_UP], onGround: false });
        const idle = { f: 0, s: 0, u: 0, yaw: 0 };
        for (let i = 0; i < 500; i++) {   // ponytail: a sloped spawn may never come to rest; start where it is after 4 s
            this.step(st, idle);
            if (st.onGround && !st.vel[0] && !st.vel[1] && !st.vel[2]) break;
        }
        return { pos: [...st.pos], onGround: st.onGround };
    }
}
