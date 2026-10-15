# Building and Running

There are two build targets: the **WASM physics module** (only needs rebuilding when you
change C under `wwwroot/wasm/`) and the **.NET web app** (serves everything).

## 1. Build the WASM physics + collision module

**Prerequisite:** the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
must be installed and `emcc` on your `PATH`.

```powershell
cd Q3BeamSearch/wwwroot/wasm
./build.ps1
```

What the script does:
1. Compiles the oDFe movement sources (`src/odfe/*.c`) **and** the collision model
   (`src/cm/*.c`) with `emcc`.
2. Produces `output/q3physics.js` and `output/q3physics.wasm`.
3. Copies both into `../../wwwroot/js/` (i.e. `wwwroot/js/q3physics.js` / `.wasm`), which is
   what the viewer loads.

Key `emcc` settings (in `build.ps1`): `MODULARIZE=1`, `EXPORT_NAME=Q3PhysicsModule`,
`ENVIRONMENT=web,worker` (the optimizer runs it in Web Workers), `NO_FILESYSTEM=1`,
`ALLOW_MEMORY_GROWTH=1`, `TOTAL_MEMORY=268435456` (256 MB), `-O3 -msimd128`. **No
`-ffast-math`:** the physics and the yaw chooser must round exactly like the game's float math.

If you add a new exported C function, add its underscore-prefixed name to
`EXPORTED_FUNCTIONS` in `build.ps1` (e.g. `_LoadCollisionMap`).

The module also contains the route optimizer's yaw chooser, `src/odfe/cl_snapyaw.c` (export
`SnapYaw`). It is the C twin of `wwwroot/js/strafe.js` and a byte-identical copy of the oDFe
engine's `code/client/cl_snapyaw.c`: keep the two C copies identical.

### Node build and the chooser parity check

`./build.ps1 -NodeOut <dir>` builds the same sources for Node into `<dir>` (`q3physics.cjs` +
`.wasm`) and leaves `wwwroot` alone. Then:

```powershell
node tests/snapyaw-wasm.check.mjs <dir>/q3physics.cjs
```

It checks that the C chooser picks the same yaw short and velocity as `strafe.js` on 30,000
random frames (VQ3 + CPM, air / ground / jump, with and without aim). Without a Node build the
check skips. Run it after any change to `cl_snapyaw.c` or `strafe.js`.

### Validating C changes without emcc / a browser

If you don't have Emscripten handy, you can still catch the majority of porting/build
errors by compiling the collision subsystem natively with `gcc`/`clang` (it does not depend
on Emscripten headers — only `wrapper.c` includes `emscripten.h`). Compile
`src/cm/*.c` + `src/odfe/q_math.c` together with a small `main` that builds an in-memory BSP
and calls `CM_LoadWorldFromMemory` + `CM_BoxTrace`. This is exactly how the collision port
was verified; see [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md#verification-done-so-far).
Note native builds are 64-bit, so ensure real prototypes exist for any pointer-returning
engine shim (e.g. `Z_Malloc`) or the pointer will be truncated.

## 2. Run the web app

Standard ASP.NET Core:

```powershell
cd Q3BeamSearch
dotnet run
```

Then open the URL it prints (see `Properties/launchSettings.json` for the configured port).
`index.html` is the landing page; the current 3D viewer is at `html/viewer3d-v2.html`.

The server auto-converts any `.cfg` demos under `wwwroot/demos` to JSON on startup
(`CfgDemoService`).

## 3. The .NET console tool (optional, offline)

`Q3BeamSearch.Console` is the original route-search / TAS experiment and is independent of
the web app.

```powershell
cd Q3BeamSearch.Console
dotnet run
```

It exports Q3 `.cfg` scripts (`Export/Q3CfgExporter.cs`) that can then be dropped into
`wwwroot/demos` and viewed in the browser.

## Smoke test after a WASM rebuild

1. `dotnet run` the web project and open `html/viewer3d-v2.html`.
2. Open the browser console.
3. Load a map (`.bsp`/`.pk3`, or the "load from defrag.racing" box).
4. Confirm you see:
   - `[CM] world loaded: N brushes, … , M surfaces` (from the WASM module), and
   - `[v2] WASM collision model loaded ✓`.
5. Enter fly/edit mode and confirm the player collides with floors/walls and can stand and
   jump (i.e. is not permanently falling).
