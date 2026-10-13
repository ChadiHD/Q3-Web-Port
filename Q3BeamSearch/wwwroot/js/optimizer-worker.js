// wwwroot/js/optimizer-worker.js
// Runs WaypointOptimizer off the main thread so long searches don't freeze the UI.
// Classic worker: q3physics.js is a classic script (importScripts), the optimizer
// is an ES module (dynamic import). Gets its own WASM instance, so the map's
// collision model has to be loaded into it too.
importScripts('q3physics.js');

let opt = null;
let cancelled = false;

self.onmessage = async ({ data }) => {
    if (data.type === 'cancel') { cancelled = true; opt?.cancel(); return; }
    if (data.type !== 'run') return;
    try {
        const { WaypointOptimizer } = await import('./waypoint-optimizer.js');
        const Q3 = await Q3PhysicsModule({
            locateFile: p => new URL(p, self.location.href).href,
            print: () => {},   // InitPhysics logs on every call; the optimizer calls it once per candidate
        });

        // Same graceful fallback as the main thread: no bytes or an old WASM
        // build without collision exports means optimizing without collision.
        if (data.rawBsp && typeof Q3._LoadCollisionMap === 'function') {
            const bytes = new Uint8Array(data.rawBsp);
            const ptr = Q3._malloc(bytes.length);
            if (ptr) {  // 0 = out of WASM memory; writing there would corrupt the heap
                Q3.HEAPU8.set(bytes, ptr);
                Q3.ccall('LoadCollisionMap', null, ['number', 'number'], [ptr, bytes.length]);
                Q3._free(ptr);
            }
        }

        // Cancelled while WASM was loading: nothing to return.
        if (cancelled) { self.postMessage({ type: 'done', inputs: [], cancelled: true }); return; }

        opt = new WaypointOptimizer(Q3);
        const route = await opt.optimizeRoute(data.waypoints, p => self.postMessage({ type: 'progress', ...p }), data.spawn, data.race);
        self.postMessage({ type: 'done', ...route });
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message });
    }
};
