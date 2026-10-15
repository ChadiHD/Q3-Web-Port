# Bot and scripting plan: snap-accurate VQ3 strafing, one cfg script language for the web tool and modified oDFe

This is the project's **own** design for the movement bot and the script workflow. It was written independently of
erbot. [ERBOT_ANALYSIS.md](./ERBOT_ANALYSIS.md) reverse-engineers that older bot and compares the two. The items it
suggests are listed under [Input from the erbot analysis](#input-from-the-erbot-analysis); none of them is a decision
yet.

## Context
User workflow: write a movement script, see the run in the web tool (WASM physics + collision), then `exec` the same
script in the modified oDFe.

- The client TAS (`References/cl_tas.c`, 14 `tas_script_*` commands) is too complicated and broken:
  `CL_TAS_OverrideCmd` is never called. So keys are never applied, the frame never advances, and frame 0's `yawDelta`
  re-applies every frame.
- `main.pdf` ("Quake III DeFRaG Physics"): the engine **rounds** velocity each frame. Optimal strafing = the snap zone
  with the most speed, not the continuous CGaz angle. Example at 600 ups: CGaz (601,2) = 601.0033 vs best snap (601,3)
  = 601.0075.
- The old engine bots (`References/cl_input.c` `+snapbot` / `+strafebot` / `+autojump`) misbehave, and the web tool must
  mirror whatever the engine does.

**Accuracy gaps** (the WASM is not yet the game):
1. `wasm/src/odfe/browser_stubs.c:19` truncates snapping. oDFe `Sys_SnapVector` (common.c:3545) rounds to
   nearest-even. Measured: jump-frame vz 263 (real 264).
2. `wrapper.c:70-77` `InitPhysics` leaves health 0, so `PM_UpdateViewAngles` (bg_pmove.c:1805) skips yaw quantization.
3. `build.ps1:50` `-ffast-math`.
4. Script jump encoding: `viewer3d-v2.js:397-398` and `:636` send upmove 200 (→ −56 crouch) + buttons 2
   (`BUTTON_TALK` freezes movement). `+movedown` (−200 → +56) jumps.
5. `loadFrames` (viewer3d-v2.js:469-487) JS re-clip overwrites WASM onGround/speed.

**Why a plain cfg isn't deterministic in oDFe yet:**
- One usercmd per frame and `wait N` = N cmds (cmd.c:51-59/261-264; common.c:4331-4417).
- But `cmd->serverTime` (cl_input.c `CL_FinishMove`) gets +1 / −2 ms nudges every snapshot from `CL_AdjustTimeDelta`
  (cl_cgame.c:1007-1015), even with `fixedtime`. So Pmove dt is sometimes 9 or 6 ms.
- `exec` loads the whole file into a 64 KB buffer (cmd.c:27 `MAX_CMD_BUFFER 65536`).

## Decisions (user)
- No `tas_play` file format: scripts run through the normal cfg `exec`. cl_tas stays untouched (superseded).
- User installs Emscripten. The assistant ships the C fixes and the build command.
- Engine bots: port the tool's snap chooser to C; merge `+strafebot` into `+snapbot`.

## Order of work
Steps 1–4 (tool) → Step 5 tool exports → Step 6 engine changes in a copy of the user's files placed into
`References/oDFe/code/client` (+ `qcommon/bg_snapzones.*`), built with msbuild. The user copies the exe / patched files
into their own tree.

## Status (2026-10-12)
- **Done:**
  - Step 1.
  - Step 2: `strafe.js` + `cgazYaw`, `tests/strafe.check.mjs`.
  - Step 6, done in `References/oDFe` directly:
    - `cl_snapyaw.c/h`;
    - `cl_input.c`: `+autojump`, `+snapbot` = best snap, `+strafebot` = CGaz, `setyaw`, `cl_scriptRun`;
    - no `cl_snapbot_mode` cvar;
    - built with MinGW (w64devkit), not msbuild: no MSVC C++ on this machine.
  - Step 3: optimizer uses `strafe.bestYaw`, starts at the settled spawn, jump frames send upmove 10.
  - erbot suggestion 1 (upmove 10) adopted: `+autojump` sends 10, `cl_scriptRun 1` caps `+moveup` to 10, and the
    optimizer jumps with 10.
  - Step 4:
    - `movement-script.js` runs scripts like the engine (see [SCRIPTING.md](./SCRIPTING.md));
    - `pmove-runner.js` is shared with the optimizer;
    - WASM `GetPmFlags` export;
    - engine script yaw for exact `+left` / `+right`.
  - Step 5: `cfg-export.js`:
    - as written and baked exports;
    - 60 KB parts chained with `exec`, downloaded as a zip;
    - buttons in the script editor, the optimizer and the frame editor (its old `exportToCfg` was replaced).
  - 2026-10-13, after the first in-game test didn't match:
    - `scriptplay` (a frame-exact cfg player, independent of how the engine counts `wait`) and `scriptpos`;
    - no `BUTTON_TALK` under `cl_scriptRun`;
    - exports for `scriptplay`, with a checkpoint every second (see CHANGELOG.md).
- **Next:**
  - In-game check by the user: `devmap`, `scriptplay` a baked route, read the checkpoint pairs in the console.

## Step 1 — WASM fidelity fixes (done)
- `browser_stubs.c`: `trap_SnapVector` → `rintf` (+ `<math.h>`).
- `wrapper.c` `InitPhysics`: `ps.stats[STAT_HEALTH] = 100`. Fix the stale comments (`0 or 200`, `BUTTON_JUMP = 2`).
- `build.ps1`:
  - drop `-ffast-math`;
  - `ENVIRONMENT=web` → `web,worker` (the optimizer now loads it in a Worker);
  - `Set-Location $PSScriptRoot` (relative paths work from any cwd);
  - `param([string]$Emsdk = $env:EMSDK)`: if `emcc` isn't on PATH, dot-source `$Emsdk\emsdk_env.ps1`; else fail with
    "pass -Emsdk <path> or run emsdk_env.ps1". emsdk is installed and activated at
    `...\Desktop\repos\emsdk` (`upstream\emscripten\emcc.exe`, `.emscripten` present).
- Run it in PowerShell 7: `./build.ps1 -Emsdk '<emsdk path>'`. Fix whatever the newer emcc complains about
  (e.g. `TOTAL_MEMORY` alias). Output is copied to `wwwroot/js/q3physics.{js,wasm}`.
- Verify:
  - scratch Node build (same sources, `ENVIRONMENT=node`, output outside the repo): air frame with vel
    (10.6, −10.6, 0.5) snaps to (11, −11, −6) (truncation gave (10, −10, −5)); yaw 45.001 comes back quantized to
    `SHORT2ANGLE(ANGLE2SHORT(45.001))`;
  - `node tests/waypoint-optimizer.check.mjs` still passes;
  - browser on `docs/dhoni.pk3`: page loads, optimizer runs in the worker, jump-frame vz = 264.

## Step 2 — `wwwroot/js/strafe.js`: snap-aware yaw chooser (done; pure, Node-testable)
`bestYaw(state {vel, onGround, jump}, keys {f,s,u}, side, score)` returns `{yawShort, vel}`.

**One-frame VQ3 model** (bg_pmove.c):
- Jump frame → AirMove: no friction, CmdScale incl. upmove (W+A+jump → 261.3).
- Ground → friction `max(v,100)*6*dt`, then accel 10.
- Air → accel 1.
- `PM_Accelerate` clamp, then round-half-even per axis.

**Enumerate outcomes in yaw shorts:**
- Seeds: accel-circle/grid-line (x/y = k+0.5) crossings, plus band edges `acos(W/v_f)` and `acos((W-a)/v_f)` (±1 short).
- Coarse grid: every 1024 shorts in the air, every 64 on the ground (the ground accel circle is ten times bigger).
- Bisect where neighbouring outcomes differ, down to one short.
- Validated in planning vs brute force (all 65,536 shorts): 0 of ~37k outcomes missed; 140–1,700 evals/frame.

**Selection:**
- Pick the **middle short** of the winning zone, so float ulp differences between JS and C can't flip it.
- Ties: score within 1e-9 → lowest short.
- `score`: `|v'|`, or for steering `(1-λ)|v'| + λ v'·û_aim`.
- Key offset (Q3 right = (sin, −cos)): wish = view + atan2(−smove, fmove), i.e. W+A +45°, W+D −45°.

## Step 3 — Optimizer uses the chooser (done)
`waypoint-optimizer.js` `_control`:
- Continuous `d` → `strafe.bestYaw`; `turn` grid → λ ∈ {0, 0.3, 1}. Keep side choice, braking, bhop, beam search and
  TAS ranking.
  - Below the CGaz threshold (`v_f ≤ W − a`) λ = 1: every angle up to ~90° gets full accel there, so heading at the
    waypoint costs nothing.
  - Braking and standing still keep the continuous angle, rounded to a short.
- Jump frames send upmove 10 (`JUMP_WISH` ≈ 319.5).
- Inputs are `{f, s, u, yawShort, yaw = shortToYaw(yawShort)}`.
- **Start = settled spawn**: spawn at the first `info_player_deathmatch` / `info_player_start` origin + 9, idle until
  landed and at rest (max 500 frames). Every waypoint is a target. No spawn → the old start, standing on waypoint 1.
- The viewer posts `spawn: {origin}` to the worker (`findFirstSpawn`, same as the script runner). The result carries
  `first` (the user waypoint number of the first target) and `start`.

## Step 4 — Script language = oDFe cfg + the engine commands (`wwwroot/js/movement-script.js`) (done)
As built (the reference is [SCRIPTING.md](./SCRIPTING.md)):
- **Exact turning.** The engine can't be repeated exactly through `cl.viewangles`, because it contains
  `delta_angles` (unknown to the tool) and float rounding differs with the base value. So with `cl_scriptRun 1`:
  - `CL_AdjustAngles` turns `cl_scriptYaw`, the server yaw with no delta;
  - each cmd sends `ANGLE2SHORT(cl_scriptYaw)` through the `setyaw` math;
  - the tool repeats the same float ops on the same value.
- **Bot state.** The bots need `PMF_JUMP_HELD` from the previous frame, so the WASM exports `GetPmFlags`.
- **Errors.** Commands the tool can't reproduce (other buttons, `exec`, a `fixedtime` other than 8, …) stop the run
  with a line number.

Original plan:
Move `parseMovementScript` (viewer3d-v2.js:361-464) into a module that uses the optimizer's `_reset/_step`
(raw `_StepPhysics`). Start = settled spawn. The tool **emulates the engine exactly**:
- Keys: `+/-forward`, `back`, `moveleft`, `moveright`, `moveup` (127), `movedown` (−127); buttons always 0.
  `+speed` / `cl_run` → movespeed 64/127 (cl_input.c:334-362).
- `wait [N]` = N frames (bare = 1, `wait 0` = 0).
- `+left/+right` + `cl_yawspeed` turn `0.008*cl_yawspeed`, float-exact (`Math.fround`).
- `+autojump`: on a ground frame with jump released, upmove 10.
- `cl_scriptRun 1` (set by the export header): upmove above 10 is capped to 10, so `+moveup` sends 10.
- `+snapbot`: yaw = `bestYaw` from the state after the previous frame, side from the strafe key. `+strafebot`: the same
  with the continuous CGaz angle. (The original plan had a `cl_snapbot_mode` cvar, 0 = CGaz, 1 = best snap; it was
  replaced by these two commands, as in the engine.)
  - If no strafe key is held, `+left` / `+right` pick the side and the matching A/D is added. So
    `+snapbot +forward +left` works as written.
- `setyaw <deg>`: absolute view yaw (new engine command, Step 6).
- `set` / `seta` of known cvars. `//` comments.
- Unknown command → error in `#scriptStatus` (the engine would print "Unknown command").

**Output and related changes:**
- `{inputs [{f,s,u,yawShort}], replay}`, mapped to frames by a shared helper (from viewer3d-v2.js:570-575).
- `loadFrames` gets a `simulated` flag that skips `applyCollisionsToFrames` for WASM frames.
- Frame-editor jump fix (viewer3d-v2.js:636).
- New placeholder example (viewer3d-v2.html:161-173).

## Step 5 — Export cfg for oDFe (done; reference: [SCRIPTING.md](./SCRIPTING.md#exporting-for-odfe-wwwrootjscfg-exportjs))
Differences from the original plan below:
- **Header** also sets `cl_run 1`, releases every key, and (as written only) sets `setyaw` to the spawn angle, so
  the in-game start yaw matches the tool's.
- **Baked lines** are run-length encoded: changes, then `wait N`.
- **Expected end** comes from replaying the export in the tool. A baked export must reproduce every usercmd, or the
  export fails.
- **Validity checks.** `movement-script.js` now only rejects a wrong `fixedtime` (or similar) when a frame runs under
  it, so the footer can restore normal play.

Original plan:
1. **As written**: the script text plus a generated header and footer.
2. **Baked (frame-exact)**: one line per frame, `setyaw <deg>;wait`, plus key toggles only when they change. Works for
   scripts, optimizer routes and editor runs, with no bot or float-turn dependence.
   - Split into ≤ 60 KB parts that chain with `exec <name>_2` etc.

**Header:**
```
// <map>: devmap <map>, don't touch the mouse, then exec <file>
set cl_scriptRun 1; set fixedtime 8; set com_maxfps 125
```

**Footer:**
- release all keys;
- `set cl_scriptRun 0; set fixedtime 0`;
- `echo "expected end: x y z / N ups / F frames"; viewpos`, so the user compares in game.

## Step 6 — Engine changes (`cl_input.c`, small; done)
**A. `cl_scriptRun 1`:**
- `CL_FinishMove`: `cmd->serverTime = lastCmdTime + 8`, resyncing with a warning if it drifts more than 50 ms from
  `cl.serverTime`.
- `CL_MouseMove`: return early (mouse ignored).
- `fixedtime 8` (header) keeps one server frame and one fresh snapshot per cmd, so `cl.snap.ps` is the state right
  before the cmd.

**B. `setyaw <deg>`:** `S = round(deg*65536/360)`, then
`cl.viewangles[YAW] = (S − cl.snap.ps.delta_angles[YAW] + 0.5)*360/65536`, so the server view yaw is exactly S.

**C. Old bots — why they failed** (verified numerically):
1. **Mirrored right vector** (−sin, cos), and view = wish − atan2(s,f) instead of + (`CL_BuildWishVel` 656-662; 1295;
   1394-1395; 1484). At 400 ups W+D the bots send yaw −82.5° → 398.0 ups; fixed 7.5° → 402.0.
2. **Strafebot tries yaw + k·90°** (1489-1493). Only 360° is equivalent, so it randomly cancels or doubles bug 1.
3. **Strafebot accel 5 / −1175** (1407-1408). VQ3 is 10 / 1.
4. **30-ups air cap on by default** (`cl_snapbot_aircap`). That's Q1, not VQ3.
5. **Forced 30°/45° fallback** below 5° (787-795). Below ~317 ups the optimum is 0°.
6. **No friction** on ground frames.
7. **Autojump decided after the angle** (1559-1567). Jump frames are AirMove with wishspeed 261.3.
8. **5°/frame step limit.**
9. **`dt = frame_msec`** jitter.
10. **Snapbot zone heuristic** never evaluates rounded outcomes.
11. **~300 lines of placeholder code** never change the cmd.

**C. Bots — fix:**
- C port `CL_SnapYaw` of `strafe.js` (identical seeds / bisection / middle-short / tie rule).
- Per frame: autojump (`in_autojump.active`, no `BUTTON_AUTOJUMP` bit — it's undefined in the added files, and every
  button bit up to 2048 is taken) → choose the angle with the matching frame model → exact yaw short via the `setyaw`
  math.
- `+strafebot` = continuous CGaz (instead of the planned `cl_snapbot_mode 0`). Remove the step limit, the cap and the
  placeholders. `bg_snapzones.*` is no longer needed by the bot.

**Limit:** online (remote servers) the live bot sees a lagged `cl.snap`. The baked export is always frame-exact.

## Tests (pattern: `tests/waypoint-optimizer.check.mjs` with a stub WASM)
- `tests/flat-floor-q3.mjs` (extracted stub + round-half-even + short-quantized yaw).
- `tests/strafe.check.mjs`: chooser vs brute force, seeded, for air / ground / jump; v=600 best snap > CGaz.
- `tests/movement-script.check.mjs`:
  - `+snapbot +forward +left; +autojump; wait 400` passes 500 ups and turns left;
  - `+moveup` jumps (127), `+movedown` doesn't;
  - `wait N` = N frames; an unknown command errors;
  - the baked export re-parses to identical inputs.
- Update the optimizer check for the spawn start.

## Verification
1. `node tests/*.check.mjs`.
2. Browser (static server + `docs/dhoni.pk3`):
   - a script shows rising speed and the turn;
   - the optimizer beats v2's 353 frames / 706 ups;
   - both exports download, and baked parts are ≤ 60 KB.
3. After the user's rebuild: jump-frame vz 264.
4. C parity: a harness runs `CL_SnapYaw` on the same seeded states as `tests/strafe.check.mjs`, and the yaw shorts
   match the JS. Then build the client (planned:
   `msbuild code\win32\msvc2017\quake3e.vcxproj -p:TargetName=oDFe,Configuration=Release,Platform=x64`; actually built
   with MinGW, see Status).
5. In game (user): `devmap dhoni`, `exec` the baked cfg. `viewpos` matches the echoed expectation; any gap =
   DeFRaG-qvm vs bg_pmove difference. The "as written" `+snapbot` script gives the same result locally.

## Docs
- `docs/PHYSICS_AND_COLLISION.md`: snapping, yaw, re-clip.
- `docs/ARCHITECTURE.md`: optimizer, scripts.
- New `docs/SCRIPTING.md`: commands, exports, oDFe steps (`cl_scriptRun`, `setyaw`, bots).

## Out of scope
- CPM (not in oDFe source). Done later (2026-10-13): see `docs/PHYSICS_AND_COLLISION.md` and the changelog.
- C# optimizer/exporter (kept).
- cl_tas (left as is, superseded).
- Path traversal in `/convert-cfg` and `/demo/{fileName}` (flag separately).

## Input from the erbot analysis
Suggestions from [ERBOT_ANALYSIS.md](./ERBOT_ANALYSIS.md):

1. **Jump-frame upmove 10 instead of 127. Adopted 2026-10-12** (see Status; numbers in CHANGELOG.md). `PM_CheckJump` only needs `upmove >= 10`, and the jump frame's
   `PM_CmdScale` counts upmove. So 10 keeps the jump and raises the jump-frame wishspeed from 261.3 to ~319.5, which
   is about +50% speed gain on that frame (+1.36 vs +0.91 ups at 600 ups). erbot does this with `er_upmove 1`, a clamp
   on every upmove.
   - Engine: `cl_input.c:649` `cmd->upmove = 127` → 10.
   - Tool: `+autojump` in Step 4; `waypoint-optimizer.js:17` `JUMP_WISH`. `strafe.js` already takes `keys.u`.
   - Plain cfg `+moveup` still sends 127, so a script-level option (cvar or clamp) would be needed for hand-written
     jumps.
2. **Key fractions are not a problem for cfg scripts.** cfg `+x` / `-x` carry no timestamp, so `CL_KeyState` returns
   exactly 0 or 1. erbot's `er_integer_keystate` only matters for real keybinds. No change needed.
3. **Exact angle shorts.** erbot's `er_angleshort` uses the same `(S − delta_angles)·360/65536` math as `setyaw`, but
   without the +0.5. Keep the +0.5.
4. **Not worth taking:** erbot's fixed bias values (0.01° / 0.08°), its fixed 125 fps snap-edge tables, and its
   friction without stopspeed. The rounded-outcome search in Step 2 replaces all three.
