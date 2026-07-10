# Guide for AI Assistants (and new maintainers)

Read this first. It captures the conventions, environment quirks, and "where do I change X"
knowledge that isn't obvious from the code.

## Orientation in one minute

- This is a **browser Quake 3 movement/TAS viewer**. Maps render with Three.js; movement is
  the **real Q3 `Pmove` code compiled to WASM** (do not "helpfully" rewrite physics in JS).
- All browser code and the WASM build live under `Q3BeamSearch/wwwroot/`.
- **Work on the v2 viewer** (`js/viewer3d-v2.js` + `html/viewer3d-v2.html`), not the legacy
  `viewer3d.js`, unless explicitly asked.
- Read [ARCHITECTURE.md](./ARCHITECTURE.md) and [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md)
  before non-trivial changes.

## Where do I change…?

| Task | Files |
|------|-------|
| Map parsing / geometry / textures | `js/bsp-loader.js` |
| 3D scene, camera, lights | `js/scene-setup.js`, `js/map-render.js` |
| Viewer behaviour, UI, wiring | `js/viewer3d-v2.js` |
| Physics behaviour (accel, friction, jump) | `wasm/src/odfe/bg_pmove.c` (this is upstream Q3 — change with care) |
| Collision (traces hitting geometry) | `wasm/src/cm/` (ported ioq3 CM) |
| Engine services the CM needs | `wasm/src/cm/cm_bridge.c` + `wasm/src/cm/qcommon.h` shim |
| Exposed WASM functions | `wasm/src/wrapper.c` + `EXPORTED_FUNCTIONS` in `wasm/build.ps1` |
| Route optimisation | `js/waypoint-optimizer.js` |
| Server endpoints / demo conversion | `Q3BeamSearch/Program.cs`, `Services/CfgDemoService.cs` |

## Environment gotchas (these bit us; they'll bite you)

1. **The workspace is OneDrive-synced.** Files edited through the editor/file tools can lag
   behind what a shell (`bash`) sees for several seconds — the shell may read a stale or
   half-written copy. Symptoms: phantom syntax errors on a file you just edited, or a
   heredoc'd file "missing" content. **Mitigation:** don't trust an immediate shell read of
   a just-edited file; when you need a reliable native compile, copy sources into a
   shell-local temp dir (e.g. `/tmp`) and build there, decoupled from the sync.

2. **`emcc` may not be available in the automation environment.** Don't assume you can run
   the real WASM build. Validate C changes natively with `gcc`/`clang` instead (the CM code
   is Emscripten-independent; only `wrapper.c` needs `emscripten.h`). See
   [BUILD.md](./BUILD.md#validating-c-changes-without-emcc--a-browser).

3. **In-browser behaviour can't be verified headlessly.** Movement "feel", rendering, and
   patch-surface collision need a human to load a map in the browser. Be explicit in your
   summaries about what you did and did **not** verify.

## Conventions and invariants — do not break these

- **Coordinate discipline.** Q3 world (Z-up) ↔ Three.js (Y-up, `(x,z,-y)`) ↔ viewer frame
  (`x=Q3_X, y=-Q3_Y, z=Q3_Z`). Anything passed to WASM physics/collision must be **raw Q3
  coords**. See [ARCHITECTURE.md](./ARCHITECTURE.md#coordinate-systems-important-easy-to-get-wrong).

- **`trace_t` / `cplane_t` layout must match** between `bg_pmove.c` and `cm_*.c` — they're
  called across the `pm->trace` function pointer. This is why the CM code compiles against
  **oDFe's `q_shared.h`** (via `-I src/odfe`) and uses the local **`qcommon.h` shim**, not
  the full engine header. Don't "upgrade" the CM code to a different `q_shared.h`.

- **`CM_BoxTrace` argument order** is `(results, start, end, mins, maxs, model, mask,
  capsule)`, but `pm->trace`/`trap_Trace` passes `(results, start, mins, maxs, end, …)`.
  The reorder happens in `browser_stubs.c::trap_Trace`. Easy to get wrong.

- **`model 0` = world**, `capsule 0` = player box, when calling `CM_BoxTrace`.

- **Feed collision the raw BSP bytes**, not the parsed geometry. `bsp-loader.js` returns
  `rawBsp`; `viewer3d-v2.js::loadCollisionIntoWasm()` uploads it. Keep `rawBsp` populated if
  you add new load paths.

- **Don't reintroduce `-D MASK_PLAYERSOLID=…` or `-D ENTITYNUM_NONE=…`** in `build.ps1`. The
  headers define these; the `-D`s only cause redefinition warnings (and the `MASK` one was
  actively wrong).

- **Security:** the `/api/map-proxy` endpoint is host-locked to `defrag.racing` and
  filename-sanitised on purpose (anti-SSRF / traversal). Preserve that. The offline Python
  scripts (`wwwroot/python/*.py`) use `zipfile.extractall` on untrusted archives — a Zip
  Slip risk if ever run server-side; guard members before extracting if you touch them.
  (They are **not** used by the v2 viewer.)

## Good working pattern for physics/collision changes

1. Make the C change under `wasm/src/…`.
2. Native-compile the affected translation units with `gcc` to catch type/symbol errors.
3. If it touches loading or tracing, run (or extend) the synthetic-BSP smoke test.
4. Update `build.ps1` exports/includes if you added functions or files.
5. Tell the user to run `build.ps1` (emcc) and do the in-browser smoke test in
   [BUILD.md](./BUILD.md#smoke-test-after-a-wasm-rebuild), since you can't.
6. Update [CHANGELOG.md](./CHANGELOG.md).

## Things that look like bugs but aren't

- Two viewers exist (`viewer3d.js` v1, `viewer3d-v2.js` v2). This is intentional; v2 is
  current.
- The JS collision system (`collision-detection.js`, `slide-move.js`) coexists with the WASM
  collision model. Intentional — JS handles pre-recorded demo replay; WASM handles live
  physics. See the design note in
  [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md#design-note-the-js-collision-system-was-kept).
- `References/ioq3-main/` is a full upstream Q3 tree kept for reference; it is not built.
