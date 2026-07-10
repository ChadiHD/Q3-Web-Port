# Changelog / Work Log

A record of notable changes and the reasoning behind them, newest first. This is meant to
give future maintainers (human or AI) the *why*, not just the *what*.

---

## 2026-07-09 — Real world collision in the WASM physics

### Problem
Collision "wasn't working" in the v2 viewer: the player clipped through geometry, floated,
and never properly stood on the ground. Root cause: `wwwroot/wasm/src/odfe/browser_stubs.c`
stubbed `trap_Trace`/`trap_PointContents` to always return "nothing hit / air", so the real
Q3 `Pmove` code had **no world to collide with**. Ground detection therefore always failed
(player treated as airborne). A separate pure-JS collision system existed but only ran as a
post-pass over recorded frames and couldn't influence the physics integrator. The real
collision code (`cm_trace.c`) wasn't even compiled into the module.

### Fix (Option A: bring ioq3's collision model into the WASM build)
Ported ioq3's collision model from `Q3BeamSearch.Console/References/ioq3-main/code/qcommon`
into `wwwroot/wasm/src/cm/` and wired the physics trace to it, so collision now happens
inside every `Pmove` step — brushes **and** curved patch surfaces.

Changes:
- **New `wwwroot/wasm/src/cm/`**: copied `cm_load.c`, `cm_trace.c`, `cm_test.c`,
  `cm_patch.c`, `cm_polylib.c` (+ headers, `qfiles.h`) from ioq3.
- **`cm/qcommon.h`** — a minimal shim (not the full engine header) so the CM code compiles
  against oDFe's `q_shared.h`, guaranteeing `trace_t`/`cplane_t` match `bg_pmove.c` across
  the `pm->trace` function pointer.
- **`cm/cm_bridge.c`** — engine-service shims: bump `Hunk_Alloc`, `Cvar_Get` pool,
  `Com_DPrintf`, `Com_BlockChecksum`, `Q_strncpyz`, `Z_Malloc`/`Z_Free`,
  `BotDrawDebugPolygons` and `FS_*` stubs.
- **`cm_load.c`** — appended `CM_LoadWorldFromMemory()` to load collision from an in-memory
  BSP buffer (no filesystem).
- **`odfe/browser_stubs.c`** — `trap_Trace`/`trap_PointContents` now call
  `CM_BoxTrace`/`CM_PointContents` when a world is loaded (with correct argument reordering
  and `entityNum` handling).
- **`wrapper.c`** — added exports `LoadCollisionMap` / `HasCollisionMap`.
- **`build.ps1`** — added the CM sources, `-I src/cm`, the two exports; raised memory to
  256 MB (CM reserves a 64 MB hunk); removed stale `-D MASK_PLAYERSOLID=1` and
  `-D ENTITYNUM_NONE=1023` (headers define these; the old defines were redundant, and the
  MASK one was wrong).
- **`js/bsp-loader.js`** — returns the raw `.bsp` bytes as `rawBsp`.
- **`js/viewer3d-v2.js`** — `loadCollisionIntoWasm()` uploads `rawBsp` into the WASM heap and
  calls `LoadCollisionMap` on each map load (retried after physics init).

### Verification
Emscripten/browser were unavailable here, so the port was validated **natively with gcc**:
the CM subsystem compiles/links clean and a synthetic single-brush BSP passes a load +
box-trace + point-contents smoke test (trace stops on the floor with normal (0,0,1); side
trace misses; inside reports SOLID). **Still to do by a human:** run `build.ps1` (emcc), and
an in-browser smoke test including a Defrag map with curved surfaces to exercise patches.
See [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md).

### Decision log
- Kept the pure-JS collision (`collision-detection.js`/`slide-move.js`) for pre-recorded demo
  replay; live physics now uses the WASM CM. The two don't conflict.
- Chose to port the full CM (with patches) rather than brushes-only, for accuracy on Defrag
  maps that rely on curved geometry.

---

## 2026-07-09 — Code review of `wwwroot`

A security/correctness review of the browser and tooling code. Key findings:

- **Zip Slip** in `wwwroot/python/parse_bsp_to_json.py` and `export_textures.py`
  (`zipfile.extractall` on untrusted PK3s). Offline tools, not used by the v2 viewer, but
  should be guarded if ever run server-side. *(Open.)*
- Minor: an `innerHTML` sink in `index.html` interpolates a server-provided `stats.error`
  string (use `textContent`); a potential WASM-heap leak in `waypoint-optimizer.js`
  `simulateRoute` if `ccall` throws (wrap in `try/finally`); a recursion guard would harden
  the JS BSP tree trace against malformed input. *(Open, low priority.)*
- Confirmed **not** vulnerable: `/api/map-proxy` is host-locked to defrag.racing and
  filename-sanitised; demo dropdown uses `createElement`/`textContent`; `localStorage`
  parsing is wrapped in `try/catch`.

The collision fix above followed directly from this review.
