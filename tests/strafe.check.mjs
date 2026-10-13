// Self-check for the snap-aware yaw chooser. Run: node tests/strafe.check.mjs
// The one-frame model itself was checked bit-exact against q3physics.wasm
// (60k random air / ground / jump frames); this checks the search.
import assert from 'node:assert/strict';
import { bestYaw, simulate, rint } from '../Q3BeamSearch/wwwroot/js/strafe.js';

assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, -2.6].map(rint), [0, 2, 2, 0, -2, 2, -3]);
assert.equal(bestYaw({ vel: [0, 0, 0], mode: 'ground' }, { f: 127, s: -127, u: 0 }, 1), null, 'standing still: keep the view');
assert.equal(bestYaw({ vel: [400, 0, 0], mode: 'air' }, { f: 0, s: 0, u: 0 }, 1), null, 'no keys: yaw does not matter');

let rng = 4242;
const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const SH = 2 * Math.PI / 65536;

// Brute force over all 65536 shorts on the requested side, 2 shorts in from the
// half-plane edges (the chooser rounds its own edges; only the interior must agree).
function brute(state, keys, side, score) {
    const va = Math.atan2(state.vel[1], state.vel[0]), offset = Math.atan2(-keys.s, keys.f);
    let best = -Infinity;
    for (let s = 0; s < 65536; s++) {
        const d = side * wrap(s * SH + offset - va);
        if (d < 2 * SH || d > Math.PI - 2 * SH) continue;
        best = Math.max(best, score(simulate(state, keys, s)));
    }
    return best;
}

const KEYS = [{ f: 127, s: -127 }, { f: 127, s: 127 }, { f: 127, s: 0 }, { f: 0, s: -127 }];
let cases = 0, evals = 0;
for (const [mode, vmax, u] of [['air', 1400, 0], ['air', 900, 127], ['jump', 900, 127], ['ground', 450, 0]]) {
    for (let i = 0; i < 24; i++) {
        const sp = 20 + rand() * vmax, th = rand() * 2 * Math.PI;   // below ~5 ups ground friction stops you: null
        const state = { vel: [Math.round(sp * Math.cos(th)), Math.round(sp * Math.sin(th)), 0], mode };
        const keys = { ...KEYS[i % KEYS.length], u }, side = i % 2 ? 1 : -1;
        const a = rand() * 2 * Math.PI, aim = [Math.cos(a), Math.sin(a)], lambda = [0, 0.3, 1][i % 3];
        const score = o => (1 - lambda) * Math.hypot(o[0], o[1]) + lambda * (o[0] * aim[0] + o[1] * aim[1]);

        const r = bestYaw(state, keys, side, { aim, lambda });
        assert.deepEqual(simulate(state, keys, r.yawShort), r.vel, 'reported velocity is what the chosen yaw gives');
        const d = side * wrap(r.yawShort * SH + Math.atan2(-keys.s, keys.f) - Math.atan2(state.vel[1], state.vel[0]));
        assert.ok(d >= -SH && d <= Math.PI + SH, `${mode}: chose the wrong side (δ=${d})`);
        const want = brute(state, keys, side, score);
        assert.ok(score(r.vel) >= want - 1e-9,
            `${mode} vel=${state.vel} keys=${JSON.stringify(keys)} side=${side} λ=${lambda}: chooser ${score(r.vel)} < brute ${want}`);
        cases++; evals += r.evals;
    }
}
console.log(`ok chooser = brute force on ${cases} frames, ${Math.round(evals / cases)} evals/frame (brute 32768)`);

// main.pdf example: at 600 ups the CGaz angle rounds to (601, 2) = 601.0033,
// the best snap zone gives (601, 3) = 601.0075.
const state = { vel: [600, 0, 0], mode: 'air' }, keys = { f: 127, s: -127, u: 0 };
const cgaz = Math.acos((320 - 2.56) / 600) - Math.PI / 4;   // W+A: wish is 45° left of the view
const cg = simulate(state, keys, Math.round(cgaz / SH) & 0xffff), snap = bestYaw(state, keys, 1).vel;
assert.ok(Math.hypot(...snap) > Math.hypot(...cg), `best snap ${snap} should beat CGaz ${cg}`);
console.log(`ok 600 ups: CGaz ${cg} = ${Math.hypot(...cg).toFixed(4)}, best snap ${snap} = ${Math.hypot(...snap).toFixed(4)}`);
