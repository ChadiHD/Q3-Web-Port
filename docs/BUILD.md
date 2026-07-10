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
`ENVIRONMENT=web`, `NO_FILESYSTEM=1`, `ALLOW_MEMORY_GROWTH=1`, `TOTAL_MEMORY=268435456`
(256 MB), `-O3 -msimd128 -ffast-math`.

If you add a new exported C function, add its underscore-prefixed name to
`EXPORTED_FUNCTIONS` in `build.ps1` (e.g. `_LoadCollisionMap`).

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
