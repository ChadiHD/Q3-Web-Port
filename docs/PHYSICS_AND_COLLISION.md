# Physics and Collision

This is the most subtle part of the project. Read it fully before changing anything under
`wwwroot/wasm/`.

## What runs the movement

Player movement is **not** re-implemented in JavaScript. It is the real Quake 3 movement
code from **oDFe** (an ioq3 fork), compiled to WebAssembly with Emscripten. The relevant
upstream file is `bg_pmove.c` — the shared "player move" (`Pmove`) routine used by both the
client and server in the actual game. Running the genuine code means acceleration, air
control, friction, strafe-jump behaviour, and ground/step handling match the game exactly.

### WASM source layout (`wwwroot/wasm/src/`)

```
odfe/                 oDFe game-movement sources + browser glue
  bg_pmove.c          the real Pmove
  bg_slidemove.c      slide/step movement
  bg_misc.c, bg_lib.c, q_math.c
  q_shared.h, bg_public.h, surfaceflags.h    game headers (types shared with cm/)
  browser_stubs.c     implementations of engine "trap_*" callbacks for the browser
cm/                   ioq3 collision model, ported for the browser (added later)
  cm_load.c           BSP → collision structures (+ CM_LoadWorldFromMemory, appended)
  cm_trace.c          box/capsule tracing through the BSP tree and brushes
  cm_test.c           point contents / position tests
  cm_patch.c          curved-surface (patch) collision
  cm_polylib.c        polygon/winding helpers used by patch generation
  cm_local.h, cm_patch.h, cm_polylib.h, cm_public.h, qfiles.h   (from ioq3)
  qcommon.h           SHIM (not the real engine header) — see below
  cm_bridge.c         engine-service shims (allocator, cvars, checksum, zone, stubs)
wrapper.c             Emscripten entry points (StepPhysics, LoadCollisionMap, ...)
```

## The exported WASM API (`wrapper.c`)

| Export | Purpose |
|--------|---------|
| `InitPhysics()` | Zero state, set defaults (gravity 800, speed 320), wire trace callbacks. |
| `StepPhysics(pos, vel, angles, fwd, str, up, buttons, dt)` | Advance one frame of Pmove. In/out arrays are Q3 coords. |
| `SimulateFrames(...)` | Batch simulate for the optimiser. |
| `IsPlayerOnGround()`, `GetHorizontalSpeed()`, `GetPlayer*()` | Read state. |
| `SetPlayerSpeed()`, `SetGravity()` | Tune parameters. |
| `LoadCollisionMap(dataPtr, length)` | **Load a raw BSP buffer into the collision model.** |
| `HasCollisionMap()` | Returns 1 once a world is loaded. |

JS-side runtime methods exported: `ccall`, `cwrap`, `getValue`, `setValue`, `HEAPF32`,
`HEAP32`, `HEAPU8`, plus `_malloc`/`_free`.

## The bug that was fixed (why collision "didn't work")

Originally, `browser_stubs.c` provided a **stub** trace:

```c
void trap_Trace(trace_t *results, ...) {
    results->fraction = 1.0f;          // always "nothing hit"
    results->entityNum = ENTITYNUM_NONE;
}
int trap_PointContents(...) { return 0; }   // always "air"
```

`Pmove` asks the engine to trace the player box through the world via `pm->trace`
(→ `trap_Trace`). With the stub, **the world did not exist inside the physics**:

- No walls or floors — the player never collided during `StepPhysics`.
- `PM_GroundTrace` casts a short downward trace; it always missed, so `groundEntityNum`
  stayed `ENTITYNUM_NONE` and the player was treated as permanently airborne. That breaks
  ground friction, normal jumping, and ramp handling.

Meanwhile a separate **pure-JS** collision system (`collision-detection.js` +
`slide-move.js`) only ran as a *post-process* over already-computed frames — it could nudge
positions off walls but could never feed back into the velocity/ground state the integrator
used. Two disagreeing sources of truth. And the good collision code that existed
(`cm_trace.c`) was **not even compiled** into the module.

## The fix: real collision inside Pmove

We ported ioq3's collision model (`cm_*`) into the WASM build and pointed the physics trace
at it, so collision now happens **inside** each `Pmove` step exactly like the engine.

### How the headers are kept compatible

`bg_pmove.c` and the `cm_*.c` files must agree on the memory layout of `trace_t`,
`cplane_t`, and `vec3_t`, because `Pmove` calls collision across a C function pointer
(`pm->trace`). To guarantee this:

- The `cm_*.c` files include `cm_local.h`, which includes `q_shared.h` and `qcommon.h`.
- We resolve `q_shared.h` to **oDFe's** copy (via `-I src/odfe`), the same header
  `bg_pmove.c` uses. So the shared structs are byte-identical (verified: the `cplane_t` and
  `trace_t` blocks are identical between oDFe and ioq3).
- `qcommon.h` is a **minimal shim** we wrote (`src/cm/qcommon.h`), NOT the real engine
  header. The real one drags in the entire engine (filesystem, network, VM…). The shim only
  declares the few services CM actually needs and includes `qfiles.h` for the BSP on-disk
  structs.

### Engine services provided (`cm_bridge.c`)

The CM code expects a handful of engine functions. `cm_bridge.c` provides small,
self-contained versions:

- `Hunk_Alloc` — a bump allocator over a single 64 MB buffer, reset per map (`CM_HunkReset`).
- `Cvar_Get` — returns entries from a tiny static pool, parsing the default value. CM only
  reads `cm_noAreas`, `cm_noCurves`, `cm_playerCurveClip`.
- `Com_DPrintf` (silent), `Com_BlockChecksum` (cheap FNV-1a — nothing validates it),
  `Q_strncpyz`, and optional `Com_Memcpy`/`Com_Memset` (only when they aren't macros).
- `Z_Malloc`/`Z_Free` — for `cm_polylib` patch windings (transient; malloc/free).
- `BotDrawDebugPolygons` — stub; only referenced by an unused debug path.
- `FS_ReadFile`/`FS_FreeFile` — stubs; the browser never uses the filesystem.

`Com_Printf`/`Com_Error` come from `browser_stubs.c` (they forward to the JS console via
`printf`). `SetPlaneSignbits`, `AngleVectors`, bounds helpers, etc. come from oDFe's
`q_math.c`.

### Loading a map without a filesystem

The engine's `CM_LoadMap` reads the BSP via `FS_ReadFile`. The browser has no filesystem, so
we appended **`CM_LoadWorldFromMemory(void *data, int length)`** to `cm_load.c`. It mirrors
`CM_LoadMap` but takes an in-memory buffer: reset state, byte-swap the header, verify
`BSP_VERSION` (46), then call the same internal `CMod_Load*` functions for shaders, planes,
nodes, leafs, brushes, brush-sides, submodels, entity string, visibility, and **patches**,
followed by `CM_InitBoxHull` and `CM_FloodAreaConnections`. It sets `cm_worldLoaded = 1`.

### Trace wiring (`browser_stubs.c`)

```c
extern int cm_worldLoaded;
void trap_Trace(trace_t *results, const vec3_t start, const vec3_t mins,
                const vec3_t maxs, const vec3_t end, int passEntityNum, int contentmask) {
    if (cm_worldLoaded) {
        // NB argument order differs: pm->trace gives (start, mins, maxs, end);
        // CM_BoxTrace wants (start, end, mins, maxs).
        CM_BoxTrace(results, start, end, (float*)mins, (float*)maxs, 0, contentmask, 0);
        results->entityNum = (results->fraction != 1.0f) ? ENTITYNUM_WORLD : ENTITYNUM_NONE;
        return;
    }
    /* fall back to open space until a map is loaded */
}
```

`model 0` = the world BSP tree; `capsule 0` = the axis-aligned player box. CM does not set
`entityNum`, but Pmove's ground logic needs a non-`NONE` value on a hit, so we set
`ENTITYNUM_WORLD`.

### JS side (`viewer3d-v2.js` + `bsp-loader.js`)

- `bsp-loader.js` now returns `rawBsp` (the untouched `.bsp` `ArrayBuffer`) from both the
  `.bsp` and `.pk3` paths.
- `loadCollisionIntoWasm(mapData)` copies those bytes into the WASM heap
  (`_malloc` → `HEAPU8.set`) and calls `LoadCollisionMap`, then checks `HasCollisionMap`.
  It is called after every map upload, and retried once at the end of `initQ3Physics()` in
  case a map was loaded before the module finished initialising. It is a no-op (safe) if
  physics isn't ready or `rawBsp` is missing.

### Build changes (`build.ps1`)

- Added `src/cm/*.c` to the source list and `-I src/cm` to the includes.
- Added `_LoadCollisionMap` and `_HasCollisionMap` to `EXPORTED_FUNCTIONS`.
- Raised `TOTAL_MEMORY` to 256 MB (the CM hunk reserves 64 MB) with memory growth on.
- Removed the stale `-D MASK_PLAYERSOLID=1` and `-D ENTITYNUM_NONE=1023` overrides — the
  headers define these correctly (`bg_public.h` and `q_shared.h`), and the old `-D`s only
  produced macro-redefinition warnings (the headers won regardless).

## Verification done so far

The emscripten toolchain was **not** available in the environment where this was written,
and no `.bsp` was present, so verification was done **natively with gcc**:

- The whole CM subsystem (`cm_load/trace/test/patch/polylib/bridge`) + `q_math.c` compiles
  and links clean.
- A synthetic single-brush BSP was loaded via `CM_LoadWorldFromMemory`, and:
  - a downward box-trace stopped at fraction ≈ 0.28 with surface normal (0,0,1), resting a
    24-unit-tall player box exactly on a z=64 floor;
  - a side trace missed (fraction 1.0);
  - point-contents inside the brush reported `CONTENTS_SOLID`.
- The edited `browser_stubs.c` compiles.

### Not yet verified (do this next)

- **The actual Emscripten build** — run `wasm/build.ps1` (needs `emcc`). See [BUILD.md](./BUILD.md).
- **In-browser behaviour** — load a real map and confirm the console logs
  `[CM] world loaded: N brushes …` and `[v2] WASM collision model loaded ✓`, then check
  that movement collides and the player can stand/jump.
- **Patch (curved-surface) collision** — the patch code compiles and links but the synthetic
  test had no curves. Test a Defrag map with pipes / rounded ramps.

## Design note: the JS collision system was kept

`collision-detection.js` / `slide-move.js` were intentionally **not** deleted. Live physics
(frame editor, optimiser) now collides inside the WASM Pmove. But pre-recorded demo playback
(frames loaded from `localStorage`) are fixed position tracks that are never re-simulated;
the JS post-pass (`applyCollisionsToFrames`) is still what clips those to the world. The two
paths don't conflict. If demo playback is ever changed to re-simulate through Pmove, the JS
post-pass can be retired.
