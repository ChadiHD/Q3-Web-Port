// Parity check: the WASM yaw chooser (wasm/src/odfe/cl_snapyaw.c, export SnapYaw) must pick the
// same yaw short and snapped velocity as strafe.js bestYaw, VQ3 and CPM, with and without aim.
// Needs a Node build of the WASM:
//   wasm/build.ps1 -NodeOut <dir>
//   node tests/snapyaw-wasm.check.mjs <dir>/q3physics.cjs      (or Q3PHYSICS_NODE=<path>)
// Without one it skips, so `node tests/*.check.mjs` still runs anywhere.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { bestYaw } from '../Q3BeamSearch/wwwroot/js/strafe.js';

const path = process.argv[2] ?? process.env.Q3PHYSICS_NODE;
if (!path || !existsSync(path)) {
    console.log('skip: no Node build of q3physics (wasm/build.ps1 -NodeOut <dir>, then pass <dir>/q3physics.cjs)');
    process.exit(0);
}
const Q3 = await createRequire(import.meta.url)(path)();
const out = Q3._malloc(8), MODES = { air: 0, ground: 1, jump: 2 };
const wasmYaw = (state, keys, side, aim, lambda) => {
    const v = state.vel;
    const s = Q3._SnapYaw(v[0], v[1], v[2], MODES[state.mode], keys.f, keys.s, keys.u, side, state.cpm ? 1 : 0,
        aim?.[0] ?? 0, aim?.[1] ?? 0, lambda, aim ? 1 : 0, out);
    return s < 0 ? null : { yawShort: s, vel: [Q3.HEAP32[out >> 2], Q3.HEAP32[(out >> 2) + 1]] };
};

let rng = 9001;
const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
const KEYS = [{ f: 127, s: -127 }, { f: 127, s: 127 }, { f: 127, s: 0 }, { f: 0, s: -127 }, { f: 0, s: 127 }, { f: 64, s: -64 }];
let n = 0, nulls = 0, tJs = 0, tWasm = 0;
for (let i = 0; i < 30000; i++) {
    const cpm = i % 2 === 1, mode = ['air', 'ground', 'jump'][(i >> 1) % 3];
    const sp = rand() * (mode === 'ground' ? 500 : 1500), th = rand() * 2 * Math.PI;
    // velocities as the WASM hands them over: float32, z included
    const vel = [Math.fround(sp * Math.cos(th)), Math.fround(sp * Math.sin(th)), Math.fround(rand() * 600 - 300)];
    const keys = { ...KEYS[i % KEYS.length], u: mode === 'jump' ? 10 : i % 7 === 0 ? 127 : 0 };
    const side = i % 3 ? 1 : -1, a = rand() * 2 * Math.PI;
    const aim = i % 4 ? [Math.cos(a), Math.sin(a)] : null, lambda = aim ? [0, 0.3, 1][i % 3] : 0;
    const state = { vel, mode, cpm };
    let t = performance.now();
    const js = bestYaw(state, keys, side, aim ? { aim, lambda } : undefined);
    tJs += performance.now() - t; t = performance.now();
    const w = wasmYaw(state, keys, side, aim, lambda);
    tWasm += performance.now() - t;
    if (!js) nulls++;
    assert.deepEqual(w, js && { yawShort: js.yawShort, vel: js.vel },
        `case ${i}: ${JSON.stringify({ state, keys, side, aim, lambda })}: wasm ${JSON.stringify(w)} js ${JSON.stringify(js)}`);
    n++;
}
console.log(`ok wasm chooser = strafe.js on ${n} frames (${nulls} null), VQ3 + CPM, air / ground / jump, with and without aim`);
console.log(`   time: strafe.js ${tJs.toFixed(0)} ms, wasm ${tWasm.toFixed(0)} ms (${(tJs / tWasm).toFixed(1)}x)`);
