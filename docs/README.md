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
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The pieces (web server, WASM physics, JS viewer, .NET console), how data flows, coordinate systems, and the folder map. |
| [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md) | How movement is simulated: the oDFe Pmove WASM module and the ioq3 collision model that was integrated so traces hit real geometry. Read this before touching anything under `wwwroot/wasm/`. |
| [BUILD.md](./BUILD.md) | How to build the WASM module and run the web app. |
| [AI_GUIDE.md](./AI_GUIDE.md) | Conventions, environment gotchas, and a task-oriented map of "where do I change X". **Read this first if you are an AI assistant working in this repo.** |
| [CHANGELOG.md](./CHANGELOG.md) | A dated record of notable work (code review findings, the collision-model port). |

## One-paragraph summary of the project

The user records or generates Quake 3 movement (strafe-jumping / Defrag runs) and wants
to inspect and optimise it frame-by-frame in a browser. Maps are parsed client-side; the
3D scene is built with Three.js; and player physics is the actual id/oDFe `Pmove` code
(not a re-implementation) running in WebAssembly so that acceleration, air control,
friction, and collision behave exactly like the game. A .NET console project contains the
original beam-search / route-optimisation experiments; an ASP.NET Core project serves the
static site and a few small demo/proxy endpoints.

## Two viewers

There are two generations of the 3D viewer, both present:

- **`wwwroot/js/viewer3d.js`** — the original, monolithic first version (v1).
- **`wwwroot/js/viewer3d-v2.js`** — the current, modular rewrite (v2). New work targets
  v2. It splits concerns across small ES modules (`bsp-loader.js`, `collision-detection.js`,
  `slide-move.js`, `waypoint-optimizer.js`, `scene-setup.js`, `map-render.js`, etc.).

Prefer **v2** unless you are specifically maintaining the legacy page.
