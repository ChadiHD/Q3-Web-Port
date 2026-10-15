# Q3WebPort — Documentation

A browser-based Quake 3 / Defrag movement viewer and Tool-Assisted-Speedrun (TAS)
workbench. It loads Q3 maps (`.bsp` / `.pk3`) and demo/config files, renders them in
3D with Three.js, and simulates player movement using the **real Quake 3 physics
engine** compiled to WebAssembly.

This `docs/` folder explains how the repo is put together and records the reasoning
behind the significant changes, primarily for future maintainers and AI assistants.

## Start here

| Document | What it covers |
|----------|----------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The pieces (web server, WASM physics, JS viewer, stats dashboard), how data flows, coordinate systems, and the folder map. |
| [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md) | How movement is simulated: the oDFe Pmove WASM module and the ioq3 collision model that was integrated so traces hit real geometry. Read this before touching anything under `wwwroot/wasm/`. |
| [BUILD.md](./BUILD.md) | How to build the WASM module and run the web app. |
| [AI_GUIDE.md](./AI_GUIDE.md) | Conventions, environment gotchas, and a task-oriented map of "where do I change X". **Read this first if you are an AI assistant working in this repo.** |
| [CHANGELOG.md](./CHANGELOG.md) | A dated record of notable work (code review findings, the collision-model port). |
| [SCRIPTING.md](./SCRIPTING.md) | The movement-script language shared by the viewer's script editor and the modified oDFe (`exec`), its bots (`+snapbot`, `+strafebot`, `+autojump`), `setyaw` and `cl_scriptRun`. |
| [BOT_PLAN.md](./BOT_PLAN.md) | The project's own bot and script plan: snap-accurate VQ3 strafing, cfg scripts shared by the web tool and modified oDFe, with status and the old bots' bugs. |
| [ERBOT_ANALYSIS.md](./ERBOT_ANALYSIS.md) | Reverse-engineering notes on erbot ("Edge Runner"), an older closed-source bot: its formulas, snap tables and tricks, compared with our plan, and how to repeat the analysis. |

## One-paragraph summary of the project

The user records or generates Quake 3 movement (strafe-jumping / Defrag runs) and wants
to inspect and optimise it frame-by-frame in a browser. Maps are parsed client-side; the
3D scene is built with Three.js; and player physics is the actual id/oDFe `Pmove` code
(not a re-implementation) running in WebAssembly so that acceleration, air control,
friction, and collision behave exactly like the game. An ASP.NET Core project serves the
static site plus a run list and a map-download proxy.

## Two pages

- **`html/viewer3d-v2.html`** (`wwwroot/js/viewer3d-v2.js` and its ES modules) — the 3D
  viewer and TAS workbench: scripts, the route optimizer, the frame editor, waypoints. The
  site opens here.
- **`stats.html`** — the run statistics dashboard (the original v1 page): speed, path,
  yaw, velocity, acceleration and strafe-efficiency charts, frame by frame. The viewer's
  **📊 Stats** button opens the loaded run in it.
