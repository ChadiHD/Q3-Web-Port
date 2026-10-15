// wwwroot/js/optimizer-worker.js
// Runs WaypointOptimizer off the main thread so long searches don't freeze the UI.
// Classic worker: q3physics.js is a classic script (importScripts), the optimizer
// is an ES module (dynamic import). Every worker gets its own WASM instance, so the
// map's collision model has to be loaded into each one.
//
// Two roles, same script:
//   'run'          coordinator: the beam search (waypoint-optimizer.js), plus a pool of helper
//                  workers that simulate each leg's candidates in parallel. The candidates are
//                  independent and merged in job order, so the route is the same as one by one.
//   'init' / 'leg' / 'extend'   helper: simulates candidates (WaypointOptimizer._extend).
importScripts('q3physics.js');

const loadOptimizer = async (rawBsp, cpm) => {
    const { WaypointOptimizer } = await import('./waypoint-optimizer.js');
    const Q3 = await Q3PhysicsModule({
        locateFile: p => new URL(p, self.location.href).href,
        print: () => {},   // InitPhysics logs on every call; the optimizer calls it once per candidate
    });
    // Same graceful fallback as the main thread: no bytes or an old WASM
    // build without collision exports means optimizing without collision.
    if (rawBsp && typeof Q3._LoadCollisionMap === 'function') {
        const bytes = new Uint8Array(rawBsp);
        const ptr = Q3._malloc(bytes.length);
        if (ptr) {  // 0 = out of WASM memory; writing there would corrupt the heap
            Q3.HEAPU8.set(bytes, ptr);
            Q3.ccall('LoadCollisionMap', null, ['number', 'number'], [ptr, bytes.length]);
            Q3._free(ptr);
        }
    }
    return new WaypointOptimizer(Q3, cpm);
};

// ── coordinator ─────────────────────────────────────────────────────────
let opt = null;
let cancelled = false;

// Leave one core for the page. ponytail: capped at 16 (each helper holds a WASM instance and a
// copy of the map); raise if machines with more cores show idle cores.
const POOL_SIZE = Math.max(1, Math.min(16, (self.navigator?.hardwareConcurrency ?? 2) - 1));

// Start the helpers and load the map into each. Resolves to the workers, or [] if they can't
// start (no nested workers): the search then runs here, one candidate after another.
async function startPool(init) {
    let helpers = [];
    try {
        helpers = Array.from({ length: POOL_SIZE }, () => new Worker(self.location.href));
        await Promise.all(helpers.map(w => new Promise((resolve, reject) => {
            w.onmessage = ({ data }) => (data.type === 'ready' ? resolve() : reject(new Error(data.message)));
            w.onerror = e => reject(new Error(e.message || 'helper worker failed to load'));
            w.postMessage({ type: 'init', ...init });
        })));
        return helpers;
    } catch (e) {
        console.warn('[optimizer] helper workers unavailable, running single-threaded:', e.message);
        helpers.forEach(w => w.terminate());
        return [];
    }
}

// A leg on the pool: each helper takes the next job as soon as it's free. Children come back
// in job order; after a cancel no new jobs start, and the ones not run stay null.
const poolLegRunner = helpers => (start, beam, jobs, wps, seg, progress) => new Promise((resolve, reject) => {
    const children = new Array(jobs.length).fill(null);
    let next = 0, busy = 0, done = 0;
    const leg = { type: 'leg', start, wps, seg, beam: beam.map(({ inputs, jumps, timerStart }) => ({ inputs, jumps, timerStart })) };
    const feed = w => {
        if (next < jobs.length && !cancelled) {
            const i = next++;
            busy++;
            w.postMessage({ type: 'extend', i, node: jobs[i].node, p: jobs[i].p });
        } else if (!busy) resolve(children);
    };
    for (const w of helpers) {
        w.onerror = e => reject(new Error(e.message || 'helper worker crashed'));
        w.onmessage = ({ data }) => {
            if (data.type === 'error') { reject(new Error(data.message)); return; }
            const { i, child } = data;
            if (child) {   // helpers send only the inputs they added; the prefix is the beam node's
                const { tail, ...rest } = child;
                children[i] = { ...rest, inputs: beam[jobs[i].node].inputs.concat(tail) };
            }
            busy--;
            progress(++done);
            feed(w);
        };
        w.postMessage(leg);
    }
    helpers.forEach(feed);
});

async function run(data) {
    let helpers = [];
    try {
        const init = { rawBsp: data.rawBsp, cpm: !!data.cpm, startBoxes: data.race?.start ?? [] };
        [opt, helpers] = await Promise.all([loadOptimizer(data.rawBsp, !!data.cpm), startPool(init)]);

        // Cancelled while WASM was loading: nothing to return.
        if (cancelled) { self.postMessage({ type: 'done', inputs: [], cancelled: true }); return; }

        if (helpers.length) opt.legRunner = poolLegRunner(helpers);
        if (cancelled) opt.cancel();
        const route = await opt.optimizeRoute(data.waypoints, p => self.postMessage({ type: 'progress', ...p, workers: helpers.length || 1 }), data.spawn, data.race);
        self.postMessage({ type: 'done', ...route });
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message });
    } finally {
        helpers.forEach(w => w.terminate());
    }
}

// ── helper ──────────────────────────────────────────────────────────────
let leg = null;

self.onmessage = async ({ data }) => {
    switch (data.type) {
        case 'run': run(data); return;
        case 'cancel': cancelled = true; opt?.cancel(); return;
        case 'init':
            try {
                opt = await loadOptimizer(data.rawBsp, data.cpm);
                opt.startBoxes = data.startBoxes;
                self.postMessage({ type: 'ready' });
            } catch (e) { self.postMessage({ type: 'error', message: e.message }); }
            return;
        case 'leg': leg = data; return;
        case 'extend':
            try {
                const node = leg.beam[data.node];
                const c = opt._extend(leg.start, node, leg.wps, leg.seg, data.p);
                self.postMessage({ type: 'result', i: data.i, child: c && { tail: c.inputs.slice(node.inputs.length), jumps: c.jumps, timerStart: c.timerStart, pos: c.pos, vel: c.vel } });
            } catch (e) { self.postMessage({ type: 'error', message: e.message }); }
    }
};
