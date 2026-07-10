# Architecture

## Solution layout

The repository root is `Q3WebPort/`. It contains two .NET projects plus the web assets.

```
Q3WebPort/
├─ docs/                        ← this folder
├─ Q3BeamSearch/                ← ASP.NET Core web project (serves the viewer)
│  ├─ Program.cs                ← minimal-API server: static files + a few endpoints
│  ├─ Services/
│  │  ├─ CfgDemoService.cs      ← converts Q3 .cfg demos → JSON frame data
│  │  └─ PhysicsService.cs
│  ├─ Models/FrameDto.cs        ← frame data shape sent to the browser
│  └─ wwwroot/                  ← ALL the browser code + the WASM build lives here
│     ├─ index.html             ← landing page: demo list, charts, 2D playback
│     ├─ html/viewer3d-v2.html  ← current 3D viewer page
│     ├─ html/viewer3d.html     ← legacy 3D viewer page
│     ├─ js/                    ← ES modules (see below)
│     ├─ css/
│     ├─ demos/                 ← sample demo data (.cfg / .json)
│     └─ wasm/                  ← Emscripten build of the Q3 physics + collision
│        ├─ build.ps1           ← the build script (runs emcc)
│        ├─ src/odfe/           ← oDFe (ioq3 fork) Pmove sources + browser stubs
│        ├─ src/cm/             ← ioq3 collision model, ported for the browser
│        └─ output/             ← build artifacts (q3physics.js/.wasm), copied to js/
└─ Q3BeamSearch.Console/        ← original C# route-search / TAS experiments
   ├─ Program.cs                ← beam-search / differential-evolution driver
   ├─ Algorithms/               ← search algorithms
   ├─ Core/ (Q3.cs, Vec3.cs)    ← C# physics + vector math
   ├─ TAS/FrameScript.cs        ← frame-script model
   ├─ Export/Q3CfgExporter.cs   ← writes Q3 .cfg scripts
   └─ References/ioq3-main/     ← FULL upstream ioq3 source (reference only)
```

> **Note on `References/ioq3-main/`**: this is the upstream Quake 3 source tree kept for
> reference. The WASM collision model under `wwwroot/wasm/src/cm/` was copied and adapted
> from `References/ioq3-main/code/qcommon/cm_*.c`. When you need to understand or re-port
> a collision function, that upstream copy is the source of truth.

## The three runtimes

1. **ASP.NET Core web server** (`Q3BeamSearch/Program.cs`)
   Serves `wwwroot/` as static files (with the correct `application/wasm` MIME type) and
   exposes a handful of minimal-API endpoints:
   - `GET /demos` — list demo files under `wwwroot/demos` (`.json` and `.cfg`).
   - `GET /demo/{fileName}` — return a demo's frames as JSON (converting `.cfg` on demand).
   - `GET /demo/{fileName}/stats` — summary stats for a demo.
   - `POST /convert-cfg` — force-convert a `.cfg` to `.json`.
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

The **.NET console** project is a separate, offline tool — the original beam-search and
differential-evolution route optimiser. Its algorithms were later re-implemented in JS
(`wwwroot/js/waypoint-optimizer.js`) so optimisation can run in the browser against the
WASM physics. The console app is not part of the web request path.

## Browser module map (`wwwroot/js/`)

| Module | Responsibility |
|--------|----------------|
| `viewer3d-v2.js` | **Current** viewer: app bootstrap, upload gate, camera/fly controls, frame editor, optimiser UI, and the physics/collision wiring. |
| `viewer3d.js` | Legacy monolithic viewer (v1). |
| `bsp-loader.js` | Parses `.bsp` / `.pk3` (via JSZip) into geometry + entities; extracts textures & skybox; also returns the **raw BSP bytes** (`rawBsp`) for the WASM collision model. |
| `collision-detection.js` | A pure-JS BSP box-trace (`BSPCollisionSystem`). Used for the demo-replay post-pass; superseded for live physics by the WASM collision model. |
| `slide-move.js` | Q3-style slide/clip-velocity helper used by the JS collision post-pass. |
| `waypoint-system.js` | Waypoint placement / import-export. |
| `waypoint-optimizer.js` | DE and A* route optimisers; call the WASM physics per candidate. |
| `scene-setup.js` | Three.js renderer/camera/lights bootstrap. |
| `map-render.js` | Builds the Three.js meshes from parsed BSP + categorises entities. |
| `frame-editor.js` | Frame-by-frame input editing. |
| `q3-math.js`, `viewer-state.js`, `ui-utils.js`, `tga-decoder.js` | Small shared helpers (coordinate conversion, global `V` state object, DOM helpers, TGA image decode). |

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
