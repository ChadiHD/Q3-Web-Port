# Architecture

## Solution layout

The repository root is `Q3WebPort/`. It contains one ASP.NET Core project (a static-file
server for the browser app), the browser code, the WASM build, the tests and these docs.

```
Q3WebPort/
├─ docs/                        ← this folder
├─ tests/                       ← Node self-checks (node tests/<name>.check.mjs)
└─ Q3BeamSearch/                ← ASP.NET Core web project (serves the app)
   ├─ Program.cs                ← minimal-API server: static files + two endpoints
   ├─ References/               ← local only, not in git: oDFe engine, Opensource Defrag
   └─ wwwroot/                  ← ALL the browser code + the WASM build lives here
      ├─ html/viewer3d-v2.html  ← the 3D viewer (the site opens here)
      ├─ stats.html             ← run statistics dashboard: speed / path / yaw / accel charts
      ├─ js/                    ← ES modules (see below)
      ├─ css/
      ├─ demos/                 ← saved runs (.json) the dashboard lists
      └─ wasm/                  ← Emscripten build of the Q3 physics + collision
         ├─ build.ps1           ← the build script (runs emcc)
         ├─ src/odfe/           ← oDFe (ioq3 fork) Pmove sources, the yaw chooser, browser stubs
         ├─ src/cm/             ← ioq3 collision model, ported for the browser
         └─ output/             ← build artifacts (not in git), copied to js/
```

> **Upstream sources**: the WASM collision model under `wwwroot/wasm/src/cm/` was adapted
> from ioq3's `code/qcommon/cm_*.c`; oDFe (`References/oDFe/code/qcommon`) has the same
> files. When you need to understand or re-port a collision function, those are the source
> of truth.

## The three runtimes

1. **ASP.NET Core web server** (`Q3BeamSearch/Program.cs`)
   Serves `wwwroot/` as static files (with the correct `application/wasm` MIME type, and
   `Cache-Control: no-cache` so edited ES modules are revalidated) and two endpoints:
   - `GET /demos` — list the saved runs (`.json`) under `wwwroot/demos` for the dashboard,
     which then fetches each one as a static file.
   - `GET /api/map-proxy?mapname=<name>.pk3` — server-side proxy that downloads a `.pk3`
     from **defrag.racing** and streams it to the browser. It is deliberately locked to
     that one host and sanitises the filename (`^[\w\-\.]+$`, path separators stripped) to
     prevent SSRF / path traversal. **Keep it that way** if you extend it.

2. **WebAssembly physics** (`wwwroot/wasm/` → `wwwroot/js/q3physics.js` + `.wasm`)
   The real Quake 3 movement code (oDFe, an ioq3 fork) plus the ioq3 collision model,
   compiled with Emscripten. This is what makes movement authentic. See
   [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md).

3. **Browser JS viewer** (`wwwroot/js/`)
   Parses maps, builds the Three.js scene, drives playback and the frame editor, and calls
   into the WASM module for physics.

The **statistics dashboard** (`stats.html`, the v1 page) charts a run frame by frame. The
viewer's **📊 Stats** button hands it the loaded run through `localStorage` (`q3StatsRun`)
and opens `stats.html?run=viewer`. The dashboard's **3D View** button goes the other way
(`q3DemoData`). The dashboard's analysis is computed from the positions (heuristic); it
doesn't run the physics.

The original C# console route optimiser was removed on 2026-10-15. Its search lives on,
rewritten, in `waypoint-optimizer.js` on the real WASM physics.

## Browser module map (`wwwroot/js/`)

| Module | Responsibility |
|--------|----------------|
| `viewer3d-v2.js` | **Current** viewer: app bootstrap, upload gate, camera/fly controls, frame editor, optimiser UI, and the physics/collision wiring. |
| `bsp-loader.js` | Parses `.bsp` / `.pk3` (via JSZip) into geometry + entities; extracts textures & skybox; also returns the **raw BSP bytes** (`rawBsp`) for the WASM collision model. |
| `collision-detection.js` | A pure-JS BSP box-trace (`BSPCollisionSystem`). Used for the demo-replay post-pass; superseded for live physics by the WASM collision model. |
| `slide-move.js` | Q3-style slide/clip-velocity helper used by the JS collision post-pass. |
| `waypoint-system.js` | Waypoints: numbered balls (radius, height); place / select-and-resize (left click), delete (middle click); hitbox reach check in playback. |
| `waypoint-optimizer.js` | VQ3 / CPM route optimiser: a strafe controller plus a beam search, on the WASM physics. It runs in `optimizer-worker.js`, which also starts a pool of helper workers (one per core minus one, up to 16), each with its own WASM instance and map. They simulate each leg's candidates in parallel, and the results are merged in job order, so the route is the same as single-threaded. With DeFRaG timer triggers it can finish in the stop trigger and ranks by race time. In CPM it also tries one-key air frames (sidestrafe, air control). |
| `strafe.js` | Snap-aware yaw chooser: a bit-exact one-frame Pmove model (VQ3 and CPM), searched over yaw shorts. Its C twin is `cl_snapyaw.c` (one file, in oDFe and in the WASM as `SnapYaw`); the optimizer runs the C one through `PmoveRunner.bestYaw`, the script runner and tests use this one, and `tests/snapyaw-wasm.check.mjs` keeps them picking alike. |
| `pmove-runner.js` | Steps the WASM Pmove one usercmd at a time (`reset`, `step`, `settle` at the spawn), VQ3 or CPM (`SetPromode`). |
| `movement-script.js` | Runs cfg movement scripts exactly like the modified oDFe (`docs/SCRIPTING.md`). |
| `cfg-export.js` | cfg exports for oDFe: as written, or baked per frame with checkpoints. |
| `race-timer.js` | DeFRaG start / checkpoint / stop triggers (brush bounds) and the race time of a run. |
| `scene-setup.js` | Three.js renderer/camera/lights bootstrap. |
| `map-render.js` | Builds the Three.js meshes from parsed BSP and the entity markers; triggers at their brush bounds, timer triggers coloured. |
| `frame-editor.js` | Frame-by-frame input editing. |
| `viewer-state.js`, `ui-utils.js`, `tga-decoder.js` | Small shared helpers: the global `V` state object, DOM helpers, TGA image decode. |

Directions: a marker or arrow that points along +X with `rotation.y = θ` points at Q3 yaw θ, because Three's Z is −Q3 Y
(Q3 → Three: (x, z, −y)). Viewer frames store y as −Q3 y. `vx` / `vy`, when present, are the Q3 Pmove velocity.

## Data flow (v2, loading a map and moving)

```
user picks .bsp/.pk3
      │
      ▼
bsp-loader.js  ──► { bsp (parsed geometry/entities), textures, skyTexture, rawBsp }
      │                                   │
      │ build Three.js scene              │ raw bytes
      ▼                                   ▼
map-render.js                     viewer3d-v2.js: loadCollisionIntoWasm()
                                          │  _malloc + HEAPU8.set + LoadCollisionMap
                                          ▼
                                  WASM collision model (cm) now holds the world
      ┌───────────────────────────────────┘
      ▼
frame editor / optimiser ──► StepPhysics/SimulateFrames (WASM Pmove)
                              └─ Pmove calls trap_Trace ──► CM_BoxTrace (real geometry)
      │
      ▼
positions/velocities ──► Three.js path + HUD
```

## Coordinate systems (important, easy to get wrong)

There are three conventions in play. Mixing them is the most common source of "the dots
are in the wrong place" bugs.

| Space | Axes | Where |
|-------|------|-------|
| **Quake 3 world** | Z is up; right-handed | Inside the BSP file and inside all WASM physics (`StepPhysics`, `CM_BoxTrace`). |
| **Three.js scene** | Y is up | The rendered 3D scene. Conversion from Q3 is `(x, z, -y)`. |
| **Viewer "frame" convention** | stored per playback frame | `frame.x = Q3_X`, `frame.y = -Q3_Y`, `frame.z = Q3_Z`. |

Rules of thumb:
- Geometry built for Three.js maps Q3 `(x,y,z)` → scene `(x, z, -y)` (see
  `bsp-loader.buildMapGroup`).
- Anything handed to the **WASM physics or collision** must be in **raw Q3 coordinates**.
  The optimiser converts viewer→Q3 (`Q3_Y = -viewer.y`) before simulating; keep that
  discipline for any new physics call site.
