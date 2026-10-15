# Changelog / Work Log

A record of notable changes and the reasoning behind them, newest first. This is meant to
give future maintainers (human or AI) the *why*, not just the *what*.

---

## 2026-10-15 (later) — Repo clean-up; stats dashboard linked from the viewer

- **Removed: `Q3BeamSearch.Console`** (the original C# beam-search experiments).
  - The web project only used it for `Vec3` and its C# physics port, which simulated `.cfg` demos server-side.
    That port isn't the real Pmove, and it read `wait` differently from the game.
  - Also removed with it:
    - `CfgDemoService`, `FrameDto`, `PhysicsService` (fully commented out);
    - the `/demo/{file}`, `/demo/{file}/stats` and `/convert-cfg` endpoints. The two file endpoints had the path
      traversal noted in BOT_PLAN;
    - the startup `.cfg` conversion;
    - the CORS policy (any origin, with credentials; nothing cross-origin uses the server);
    - all NuGet packages (unused).
- **Removed, unused:**
  - `js/viewer3d.js`: the v1 3D viewer. Its page was already gone, and the dashboard's 3D View pointed at it.
  - `html/frame-editor.html`: an orphan fragment; v2 builds its own.
  - `wwwroot/cm_trace.c`: a stray copy.
  - `wwwroot/.github/prompts/…`: an old prompt, which was being served publicly.
  - `demos/movement.cfg`: needed the C# physics.
  - `wasm/output/` from git: build output, now ignored. `js/q3physics.*` is the shipped copy.
  - The nested `Q3BeamSearch.Web/Q3BeamSearch.Web.csproj`, `README_CFG_Integration.md`, a stray screenshot.
  - The solution's Console project and its link to a file in Downloads.
- **`main.pdf` out of git** ("Quake III DeFRaG Physics", cited in BOT_PLAN). It's downloaded from the web, so there's
  only a local copy in `docs/`.
- **Deleted locally (never in git):** `References/cl_tas.*`, `cl_input.c`, `bg_snapzones.*`, `q3physics_wrapper.c`
  (superseded by the oDFe work) and `erbot.7z`. The findings are in ERBOT_ANALYSIS.md. `References/` keeps `oDFe` and
  `defrag`.
- **`Q3BeamSearch.Web.csproj`** excludes `References/**` (the local engine trees) from the build.
- **Stats dashboard:** `index.html` → `stats.html`, kept.
  - The viewer's new **📊 Stats** button hands it the loaded run (`localStorage` `q3StatsRun`) and opens
    `stats.html?run=viewer`. Its new "Viewer run" button reloads that run.
  - Saved runs (`demos/*.json`) are fetched as static files, and the stats are computed in the page.
  - **3D View** opens the v2 viewer.
  - Its unused WASM load is gone: it never called the physics, only `SetPlayerSpeed` / `SetGravity`.
  - Chart.js is pinned to 4.4.1.

---

## 2026-10-15 — C chooser in the WASM, hitbox reach, waypoint editing, player hitbox

- **Yaw chooser in C.** The optimizer's per-frame chooser now runs `cl_snapyaw.c` inside `q3physics.wasm` (export
  `SnapYaw`, called through `PmoveRunner.bestYaw`). If the WASM predates the export, `strafe.js` runs it as before.
  - The C gained the optimizer's aim + λ score (`CL_SnapYawAim`); `CL_SnapYaw` is unchanged for the engine bots.
  - It is faster in two ways:
    - a once-built forward-vector table per short, since WebAssembly `sin`/`cos` are software;
    - bitsets walked in order instead of two `qsort`s, since musl's smoothsort was ~90% of its time.
  - It is identical to `strafe.js` on 30,000 frames (`tests/snapyaw-wasm.check.mjs`) and 4× faster in Node.
  - On dhoni (CPM, 6 waypoints) the routes are identical. Single-threaded: 1.34 s with the C chooser, 4.37 s with
    `strafe.js`. With the worker pool: 0.46 s.
  - The engine copy in `References/oDFe/code/client` is the same file (it compiles clean with gcc).
  - `build.ps1 -NodeOut <dir>` builds a Node copy for the check.
- **Reach = the hitbox touching the ball.** A waypoint is reached when the player's standing hitbox (±15 across,
  −24..+32 around the origin) touches its ball. The optimizer and playback share the test (`hitboxTouches`).
  - Before, the optimizer tested the origin point against a ±96 cylinder for floor waypoints. That is why routes
    sometimes counted a waypoint the drawn path visibly hopped over.
  - Corner cutting aims within radius + 15, since grazing is enough.
- **Waypoint height is now the gap under the ball:** 0 = resting on the clicked surface (centre = surface + radius).
  Before, the centre sat on the surface, half sunk into the floor.
- **Edit a waypoint:**
  - Clicking a ball selects it (yellow outline), and Radius / Height then resize it live.
  - Clicking it again, clicking elsewhere, Esc, or leaving waypoint mode ends editing.
  - Ending an edit restores the inputs' values for the next new waypoint.
  - Redrawn markers free their GPU buffers.
- **Player = Q3 hitbox:** a see-through 30×30×56 box with coloured edges (centre 4 above the origin), replacing the
  sphere (`V.playerBox`).

---

## 2026-10-14 (later) — Playback direction, follow / first-person camera, raised waypoints

- **Playback direction.** ⏴ / ⏵ (and ← / →) set the direction. When paused they also step one frame; while playing
  they turn the playback around. The play button shows ▶ or ◀. Backwards stops at frame 0, and play there starts
  from the end.
- **Follow** (on by default): the orbit target stays on the player and keeps the user's angle and zoom.
- **1st Person:** the camera sits at the eye (origin + 26) and looks along the horizontal velocity (the view yaw
  under 10 ups). The player marker, arrows, ground disc and trail are hidden; the path stays. The orbit camera comes
  back on exit. Top / Side / Reset Cam, fly mode and a map load all leave first person.
- **Waypoint radius and height.** Height raises the ball above the clicked surface, with a stem drawn down to it,
  for spots the player only passes in the air. A raised waypoint is reached inside its ball (radius across, ±radius
  vertically). A floor waypoint keeps the old rule: within the radius, up to a full hop vertically. Playback now uses
  the same test as the optimizer (`insideWaypoint`); before, it used a plain sphere around the clicked point. Check:
  `tests/waypoint-system.check.mjs`.
- **Layout:**
  - Controls panel 360 px (it overflowed at five-digit frame numbers).
  - Frame Info a fixed 260 px wide; its width used to follow the coordinates' length.
  - Optimizer and frame editor moved left of Frame Info, so they no longer overlap it.

---

## 2026-10-14 — Fixed waypoint numbers; static files revalidate

- **Waypoint numbers stay fixed.** Deleting one no longer renumbers the rest. The panel's "Next #" chooses the next
  waypoint's number and defaults to the lowest free one, so a deleted waypoint can be put back. A duplicate number is
  refused. Gaps show "⚠ Missing waypoint …" in the panel and as a warning toast when the optimizer starts. The route
  (optimizer, playback check) follows number order. Check: `tests/waypoint-system.check.mjs`.
- **Removed** the waypoint Export/Import JSON buttons, and the Splits / Reached / Time readouts, which nothing ever
  filled. Race timing comes from the DeFRaG timer triggers.
- **Waypoint labels** sit above the ball. Where the map is in the way (low ceiling, wall), the label moves to the
  first clear side. Sky surfaces don't count, since they aren't drawn as surfaces. Labels are drawn without depth
  test, so walls never hide them.
- **Path line** is a 3 px `Line2`, dark blue `0x1565c0`, with tone mapping off. The old `THREE.Line` was always 1 px
  (WebGL ignores `linewidth`). Its geometry was updated in place without new bounds, so a stale bounding sphere got it
  frustum-culled at some camera angles. Each path update now builds a fresh `LineGeometry`: `Line2` keeps drawing
  the first geometry's segment count.
- **Physics selector** (VQ3/CPM) moved from the waypoint panel to the top bar.
- **Optimizer speed.** A Firefox profile of a 112 s run showed WASM physics at ~2%. About 95% was JavaScript: the
  `strafe.js` chooser plus its per-call Map/Set, two comparator sorts, per-eval `sin`/`cos`, and GC.
  - **Chooser:** reusable typed arrays with numeric sorts, outcomes returned through module variables, and a
    once-built forward-vector table per yaw short. Bit-identical to the old version on 20,000 random VQ3/CPM frames
    (yaw, velocity, eval count), and 2.6× faster in Node.
  - **Worker pool:** `optimizer-worker.js` runs each leg's candidates on helper workers (`legRunner`). The route is
    identical to the single-threaded run (dhoni, VQ3 and CPM). CPM run: 1.24 s against 4.86 s single-threaded.
    `tests/waypoint-optimizer.check.mjs` checks that out-of-order completion gives the same route.
- **`Program.cs`** sends `Cache-Control: no-cache` on static files. Before this, browsers kept a July `map-render.js`
  next to a new `viewer3d-v2.js` (`t is null` in `transitionToViewer`, blank timer). See `AI_GUIDE.md` gotcha 4.

---

## 2026-10-13 — CPM physics (DeFRaG `df_promode 1`)

- **Sources.** DeFRaG is closed source. CPM follows Opensource Defrag (`References/defrag`, `phy/q3a.c`, a 1:1 remake)
  and the proxymod HUD constants reverse engineered from DeFRaG. They disagree on three points (air stop accel, float
  order in air control, the double-jump window); the choices are listed in `PHYSICS_AND_COLLISION.md`.
- **WASM (`bg_pmove.c`, `bg_slidemove.c`, `wrapper.c`).**
  - `SetPromode` sets `pm_promode`.
  - CPM rules: ground accel 15; strafe key alone in the air gets accel 70 with the wishspeed capped to 30; accelerating
    against the velocity uses 2.5; forward or back alone gets air control; ramp jumps; double jump +100 within 400 ms;
    step-ups while rising inside the window.
  - Checked on dhoni: double jump 364 inside the window, 264 outside, ramp add 269.
- **Chooser.**
  - `strafe.js` (`state.cpm`) and oDFe `cl_snapyaw.c` (`cpm` argument) model all of it.
  - JS = WASM bit for bit on 140k frames. Chooser = brute force on 192 frames. C = JS on 20k cases, 10k of them CPM.
  - Extra seeds for the 2.5 circle, and a finer grid (256) for air control, whose outcome curves back on itself.
- **Optimizer.**
  - CPM ground accel; turn radius v² / 2100.
  - In the air it also tries the strafe key alone and, when turning counts (λ > 0), forward alone.
  - dhoni first leg: 292 frames / 783 ups (VQ3 unchanged at 322 / 749). The flat-floor 90° turn: 327 frames (VQ3 474).
  - About 7× slower than VQ3.
- **Scripts and exports.**
  - `runScript(..., cpm)`. The new `scriptphysics vq3|cpm` errors if it doesn't match the Physics menu; `df_promode` in
    a script is an error.
  - Exports name the physics, tell you which `df_promode` to set, and start with `scriptphysics`.
- **oDFe (`cl_input.c`).**
  - The bots read `PMF_PROMODE` (`pm_flags` 0x8000, like the proxymod HUD and erbot) and pass it to the chooser.
  - `scriptphysics` stops a playing script when the game runs the other physics.
  - `df_promode` is no longer a warned-about setting.
  - Rebuilt with MinGW.
- **Viewer.**
  - Physics menu in the controls panel, used by scripts, the optimizer worker, the frame editor (shared WASM) and
    exports.
  - Switching the physics drops the last route's export.
- **Not checked in game.**

---

## 2026-10-13 — Vectors, camera, DeFRaG race timer

- **Vectors (`viewer3d-v2.js`).**
  - The wish arrow was velocity + 30° whatever the keys. It is now the frame's real wish direction:
    view + atan2(−rightmove, forwardmove), hidden with no move keys.
  - The yaw arrow and the spawn arrows were mirrored. `q3YawToThree` negated a Q3 yaw, but `rotation.y` already equals
    Q3 yaw for these +X markers. It was removed (`q3-math.js` deleted).
  - The velocity arrow was right by a double negation. It now uses the real Pmove velocity (`vx` / `vy` on WASM
    frames), falling back to position deltas.
  - The ground disc sat 14 units above the floor; it is now at the feet.
  - The info panel showed Y negated (frame convention); it now shows Q3 coordinates like `viewpos` / `scriptpos`. The
    yaw is normalised to ±180°.
  - Checked in the browser: W+A at yaw 90 gives yaw arrow 90°, wish 135°, velocity 135°.
- **Camera.** Optimizer, script and editor runs keep the camera (`loadFrames(..., { keepCamera: true })`). Loading a
  demo still jumps to its first frame.
- **Triggers (`map-render.js`).** Brush triggers have no origin, so they were all drawn as 32-unit cubes at (0,0,0).
  They are now drawn at their brush model's bounds, timer triggers coloured: start green, stop red, checkpoint blue.
- **Race timer (`race-timer.js`).**
  - `findTimerTriggers`: triggers whose target is a `target_startTimer` / `target_checkpoint` / `target_stopTimer`.
  - `raceTime`: from the last frame touching a start trigger to the first frame touching a stop trigger, 8 ms a frame
    (player box ±15 / −24..+32, grown by 1 like `SV_LinkEntity`), with checkpoint splits.
  - Assumes box brushes and triggers that retrigger every frame.
  - The info panel has a running Timer; script and optimizer summaries show the time or what's missing; cfg footers
    echo the expected race time.
- **Optimizer.**
  - With a start trigger it ranks by race frames, so frames inside the start trigger are free.
  - The optional "Finish in the stop trigger" (off by default) adds the stop trigger nearest the last waypoint as the
    final target, reached on touch. With it, zero waypoints are allowed.
  - dhoni: the route through the start trigger times from frame 86. The stop trigger needs waypoints leading to it;
    otherwise the leg fails after a long search.
- **Tests:** `tests/race-timer.check.mjs` covers trigger linking, the touch margin, race time and splits, and the
  optimizer finishing in a stop trigger with race time below the total frames.

---

## 2026-10-13 — In-game mismatch: scriptplay; viewer fixes

User report: exported scripts made totally different movement in oDFe, and "a frame is actually wait 2" (scripting
community). There is no Quake 3 on the dev machine, so the causes were found by reading the engine source.

- **`wait` depends on the engine.**
  - ioq3 and older builds decrement `cmd_wait` in every `Cbuf_Execute`, which runs twice a frame, so there `wait 2`
    = 1 frame.
  - This oDFe decrements once a frame in `Cbuf_Wait` (`cmd.c:359`, `common.c:4417`).
  - Any `EXEC_NOW` cancels a pending wait (`cmd.c:228`). The game VM can send one (`sv_game.c:421`).
- **`BUTTON_TALK`.** With the console open, `CL_CmdButtons` adds `BUTTON_TALK` to every usercmd, and Pmove then drops
  all movement. A script typed into the console didn't move until the console closed.

**Fix (oDFe `cl_input.c`):**
- `scriptplay <file>` plays a cfg itself, from `CL_CreateCmd`: commands up to `wait N`, then N usercmds. One usercmd
  is one wait in any build, independent of the command buffer, with no 64 KB limit.
- `scriptstop`.
- `scriptpos` prints `cl.snap.ps` (frame count, origin, speed, vz).
- On the first frame, warnings for settings the tool doesn't simulate:
  - `fixedtime`, `com_maxfps`, `cl_scriptRun`, `sv_fps`, `timescale`, `g_speed`, `g_gravity`;
  - `df_promode`;
  - a non-local game.
- No `BUTTON_TALK` under `cl_scriptRun`.
- The real `scriptplay` code, compiled into a stub harness, steps identically to the tool: 400/400 baked frames, plus a
  cfg full of comment, quote and `wait` forms.

**Exports:**
- Always one file, to be run with `scriptplay` (no parts, no zip).
- Baked files print a checkpoint every 125 frames, the tool's expected state then `scriptpos`, so the first divergence
  is visible in the console.
- The footer prints the expected end next to `scriptpos`.

**Viewer:**
- `/` redirects to `/html/viewer3d-v2.html` (`Program.cs`; the old page stays at `/index.html`).
- Playback runs in real time, 125 game frames per second × speed (`requestAnimationFrame`, time-based). The old
  `setInterval` had a 16 ms floor, so it ran at about 62 frames/s. The speed is read every tick, so x1 / x2 apply
  immediately. Measured: 125.5 / 249.5 / 63.0 frames/s at 1x / 2x / 0.5x.
- **Waypoints:**
  - a left click places a waypoint only when it is quick and doesn't move (under 300 ms, under 5 px), so dragging the
    camera doesn't drop waypoints;
  - a middle click deletes the waypoint under the cursor;
  - the panel's Total count now updates;
  - markers update their matrices when placed, so they can be picked before the next render.

---

## 2026-10-12 — cfg export for oDFe (Step 5)

- **`wwwroot/js/cfg-export.js`:**
  - `exportScript`: the script as written.
  - `exportBaked`: frame-exact, per change `+key` / `-key` / `setyaw <exact short>` then `wait N`, no bots.
  - Both get a header (`fixedtime 8`, `com_maxfps 125`, `cl_run 1`, `cl_scriptRun 1`, keys released, the start yaw)
    and a footer (keys released, normal play restored, `echo` of the expected end, `viewpos`).
  - The expected end comes from replaying the export in the tool, and a baked export must reproduce every usercmd or
    it fails.
  - Over 60 KB it splits into parts chained with `exec` (oDFe's command buffer is 64 KB), downloaded as a zip.
- **Viewer buttons:**
  - script editor: Export .cfg (as written) and Export baked;
  - optimizer: Export .cfg after a route;
  - frame editor: Export .cfg is now baked.
- **The frame editor's old `exportToCfg` was broken.** It wrote `+forward 127` (a key number, not a move), a
  nonexistent `viewangles` command, and `wait 2` per frame. It is now a wrapper over `exportBaked`, kept because the v1
  viewer calls it. New `toInputs()`.
- **`bsp-loader.js`** returns `mapName`, the BSP's own name for `devmap`: dhoni.pk3 holds `pornstar-dhoni`.
- **`movement-script.js`** only rejects a wrong `fixedtime` / `cl_scriptRun` / … when a frame runs under it, so
  footers can restore them.
- **Tests:** `tests/cfg-export.check.mjs` checks that baked scripts and optimizer routes replay to identical usercmds,
  the part split and chaining, as-written equivalence, and the refusal of moves keys can't make.
- **Browser check (dhoni):**
  - the route export replays to the optimizer's 322 frames / 749 ups;
  - the script exports (as written and baked) and the editor export download;
  - an unsupported command is refused with its line.

---

## 2026-10-12 — Movement scripts run like the modified oDFe (Step 4)

- **`wwwroot/js/movement-script.js`** replaces the viewer's old `parseMovementScript`. That parser:
  - sent upmove 200, which wraps to −56, a crouch, plus `BUTTON_TALK`, which froze movement;
  - turned with doubles;
  - split commands only on lines.

  The new runner follows `cl_input.c` step by step:
  - Cbuf `wait` semantics (oDFe `Cbuf_Wait` counts once per frame);
  - `CL_AdjustAngles` on the script yaw, then `CL_KeyMove`, the upmove 10 cap and `CL_MoveBots`, then `ANGLE2SHORT`;
  - the run starts at the landed spawn.
  - Errors stop with a line number; the viewer shows them in red.
- **`wwwroot/js/pmove-runner.js`:** WASM stepping shared by the optimizer and scripts (`reset` / `step` / `settle`).
- **WASM:** `GetPmFlags` export, so the bots see `PMF_JUMP_HELD` like `cl.snap.ps`.
- **oDFe:** with `cl_scriptRun 1`, `+left` / `+right` turn `cl_scriptYaw`, the server yaw without `delta_angles`, and
  the cmd yaw comes from it. Before, the turned value included `delta_angles`, so float rounding could differ from the
  tool by a yaw short. `setyaw` and the bots set the script yaw too, and switching `cl_scriptRun` on starts it at the
  current yaw.
- **Viewer:**
  - `framesFromRun` is shared by scripts and the optimizer;
  - the frame editor's jump sends upmove 10, not 200 + `BUTTON_TALK`;
  - editor frames skip the JS re-clip;
  - new example script.
- **Measured:**
  - `tests/movement-script.check.mjs` covers wait, comments, turning float for float, `setyaw`, the upmove cap, errors
    and the bots.
  - From a standstill (flat floor, 400 frames): `+snapbot` reaches 804 ups, `+strafebot` (CGaz) 747. The gap opens at
    low speed, where every angle gets full accel and the snap bot picks directions that round up (+3.4 against +3.1
    ups/frame).
  - The example script on dhoni (real WASM) runs 524 frames in 84 ms. The viewer shows the same.

---

## 2026-10-12 — Optimizer uses the snap chooser; jump frames send upmove 10

- **Upmove 10 adopted** (erbot suggestion 1 in [BOT_PLAN.md](./BOT_PLAN.md)). `PM_CheckJump` only needs `upmove >= 10`,
  and the jump frame's `PM_CmdScale` counts upmove, so 10 keeps wishspeed 319.5 instead of 261.3. Measured with the
  bit-exact `strafe.js` model, best snap, velocity rounding included:

  | speed | jump-frame gain, upmove 127 | upmove 10 (= a normal air frame) |
  |---|---|---|
  | 320 | +2.002 | +3.002 |
  | 400 | +1.005 | +2.005 |
  | 600 | +1.003 | +1.007 |
  | 900 | +1.002 | +1.005 |

  The continuous estimate (+0.91 → +1.36 at 600 ups) mostly vanishes into rounding at high speed. At low speed it is a
  whole extra ups per jump. Never worse.
  - oDFe `cl_input.c`: `+autojump` sends 10. With `cl_scriptRun 1`, any upmove above 10 (a scripted `+moveup`) is
    capped to 10, which also keeps wishspeed near 320 while jump is held in the air.
  - `waypoint-optimizer.js`: jump frames send `u = 10`.
- **Optimizer (Step 3):**
  - Each frame's yaw is `strafe.bestYaw`, with λ ∈ {0, 0.3, 1} blending speed and progress toward the waypoint.
  - Inputs carry an exact `yawShort`.
  - Routes start at the map's first spawn, landed (+9 spawn height, idle until at rest). Every clicked waypoint is now
    a target, so one waypoint is enough. Maps without a spawn still start on waypoint 1.
- **Viewer:** `loadFrames(frames, { simulated: true })` skips the JS re-clip for WASM frames. It used to overwrite their
  speed (with 3D speed from positions) and ground state.
- **Tests:** `tests/flat-floor-q3.mjs`, a stub that uses `strafe.js`'s model, so it snaps and quantises yaw like Pmove.
  The optimizer check covers upmove 10 and the spawn start.
- **Measured** (real WASM, dhoni, 1500 units +Y from the spawn floor):
  - from waypoint 1: 342 frames / 740 ups (342 / 739 before);
  - from the settled spawn: 322 frames / 749 ups;
  - browser worker run: 1.45 s.

---

## 2026-10-12 — Bot plan documented; erbot reverse-engineered

- **[BOT_PLAN.md](./BOT_PLAN.md):** the plan for our own bot and script workflow, now in the repo with its status. Done:
  WASM fidelity fixes, `strafe.js` chooser, oDFe `cl_snapyaw` / `+snapbot` / `+strafebot` / `+autojump` / `setyaw` /
  `cl_scriptRun`. Next: optimizer uses the chooser, `movement-script.js`, cfg exports.
- **[ERBOT_ANALYSIS.md](./ERBOT_ANALYSIS.md):** static analysis of `References/erbot.7z` with Ghidra 12.1.4 headless. erbot
  is a dfengine 1.08 fork.
  - It reads the predicted playerState from QVM memory.
  - It strafes with a CGaz formula plus bias values.
  - It snaps with fixed 125 fps edge tables.
  - It jumps with upmove 10, which keeps the full 320 wishspeed on the jump frame.

  The upmove 10 trick is the main thing worth taking; it is listed as an open suggestion in the plan.
- Decision: the decompiled output is **not** committed (the authors ask that the bot not be distributed). The doc has
  the algorithms, the constants, the addresses and a script to regenerate it.
- Tooling note: the rea MCP/CLI's Ghidra bridge fails on Windows ("Ghidra headless launch failed"); use
  `analyzeHeadless.bat` + JDK 21 directly.

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
