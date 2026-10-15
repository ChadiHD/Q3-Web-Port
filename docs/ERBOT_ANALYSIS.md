# erbot ("Edge Runner") — reverse-engineering notes

`erbot.7z` held `erbot.exe`, a closed-source Quake 3 movement bot that DeFRaG players rate highly. These notes record
how it works so our own bot (see [BOT_PLAN.md](./BOT_PLAN.md)) can learn from it. Analysed 2026-10-12 with static
analysis only: the exe was never run. The archive was deleted from the machine on 2026-10-15. To repeat the analysis,
get it again (SHA-256 below) and follow "How the analysis was done".

The full decompiled output stayed out of the repo. In the bot's about text the authors say they don't want to distribute
the program, and they ask that it not be used to cheat. What's here is a description of the algorithms, the constants
and the addresses, which is enough to check any claim again.

## What it is

| | |
|---|---|
| Name | "Edge Runner — a Quake 3 movement bot", developers listed as q3a, dqopb, lama3oid, "November 2012" |
| Thanks | Setup ("dehax", which the bot's state reading comes from), Nt.run (snapping HUD), [GT]Goodini (beta testing) |
| Binary | `erbot.exe`, PE32 x86 GUI, MSVC 2008 (linker 9.0), PE timestamp 2013-06-01, 1,248,256 bytes, not packed |
| SHA-256 | `fa1b9ffe7dcc5109db437166fe3a3a085e8f1456b8a1220b98dcbfa5953914bc` |
| Base | A modified **dfengine 1.08** client. PDB path `\erbot_safe_dfengine_1.08_src\code\Release\quake3.pdb` |

It is **not** a separate program attached to the game. It is a whole engine with the bot built into `cl_input.c`. The bot
never touches Pmove. Each frame, it rewrites `cl.viewangles` and the usercmd move values just before the cmd is sent.
The about text calls it a tool for "scripted and boted DeFRaG" and asks that demos made with it be marked as boted.

## Where the bot runs

`CL_CreateCmd` @ `0x40c4e0` runs these steps in order:

| Order | Address | Step |
|---|---|---|
| 1 | `0x409790` | `CL_AdjustAngles` (+left/+right/+lookup) |
| 2 | `0x40c420` | `CL_CmdButtons` |
| 3 | `0x409860` | `CL_KeyMove` + **automation** (fm/rm/um cvars, autojump, autohob, autouob, autozwob, upmove clamp) |
| 4 | `0x40c1f0` | `CL_MouseMove` |
| 5 | `0x40c110` | `CL_JoystickMove` |
| 6 | `0x40a140` | **strafebot** |
| 7 | `0x40bad0` | **slippyboost** |
| 8 | `0x40b880` | **aimstick** |
| 9 | `0x40a830` | **snapbot** |
| 10 | — | pitch clamp to ±90° from the previous frame |
| 11 | `0x40c480` | `CL_FinishMove` |

Bots run after the mouse. Each one sets yaw relative to the last predicted view yaw, so mouse input from this frame
carries through as an offset.

## Where it reads player state

The bot reads the cgame QVM's **predicted** `playerState_t` straight out of VM memory:
`vm->dataBase + er_qvm_offsets` (default `957380`, the offset of `cg.predictedPlayerState` in the DeFRaG cgame it was
built for). This is the "dehax" technique. With `g_synchronousClients 1` it reads `cl.snap.ps` instead.

Fields it reads (offsets inside `playerState_t`):
- `0x0c` `pm_flags`: bit `0x8000` = CPM / promode. `er_promode 1` forces this.
- `0x14` `origin`
- `0x20` `velocity`
- `0x38` `delta_angles`
- `0x44` `groundEntityNum`: `0x3ff` = in the air
- `0x98` `viewangles`
- `0x144` `powerups[PW_HASTE]`, read from the `cl.snap.ps` copy

## Strafebot (`+strafebot`, `0x40a140`): one closed-form formula per frame

There is no simulation and no search. All the constants below were confirmed from the x87 disassembly (Ghidra's
decompiler drops the FPU stack arguments, so they had to be read from the asm).

```c
speed  = sqrt(vx*vx + vy*vy);                if (speed < 1) return;
velYaw = atan2(vy, vx) * 180/pi;
if (onGround && upmove == 0) {               // walking frame (sb_oldmode 1: ignore upmove here)
    accel = cpm ? 15 : 10;
    speed -= 6 * speed / 125;                // friction applied first; ignores stopspeed 100
    coef   = sb_anglescoef_ground;           // default 0.08 deg
} else {                                     // air, or the jump frame (PM_CheckJump -> AirMove, no friction)
    accel = 1;
    coef   = sb_anglescoef_air;              // default 0.01 deg
}
opt = acos((320 - accel*2.56) * (haste ? 1.3 : 1) / speed) * 180/pi;   // (wishspeed - accelspeed) / speed
opt = AngleNormalize180(opt);                // through ANGLE2SHORT, so quantised to shorts

// W+A: wishdir = view + 45, so set the view so that wishdir = velYaw + opt (+coef)
yaw += -AngleSubtract(psYaw + 45, velYaw + opt) + coef;
// W+D: -45 / -opt / -coef
```

`yaw` is `cl.viewangles[YAW]`. `psYaw` is the predicted `viewangles[YAW]`. `AngleSubtract` @ `0x430810` and
`AngleNormalize180` @ `0x4307c0` both go through `ANGLE2SHORT`. The frametime is hardcoded to 125 fps: the `2.56` is
`320 × 0.008`, and the friction term divides by `125`.

These variants apply in the air only:
- **W only** (`sb_fkey_enable`, default 1): wishdir = view. Target = `velYaw + sb_fkey_enable·opt`, so the value's sign
  picks the turn side.
- **A/D only with CPM:** offset ±90°, plus an extra turn of `sb_cpmturnspeed × 0.0001 × speed`, capped at 0.59°.
- **`sb_backstrafe 1`:** backwards strafing with an offset of ±135°.

The bias values (0.01° in the air, 0.08° on the ground) are empirical tuning. They push the wishdir slightly past the
continuous optimum.

## Snapbot (`+snapbot`, `0x40a830`): hardcoded snap-zone tables

Two tables of 24 floats each hold the world angles where `rint(a·cos θ)` or `rint(a·sin θ)` changes value:

| Table | When | Values (deg) |
|---|---|---|
| `0x52c028` | normal, a = 2.56 | `11.27 12.43 35.87 54.13 77.57 78.73`, repeated +90 / +180 / +270 |
| `0x52c088` | haste, a = 2.56×1.3 = 3.328 | `8.65 26.78 41.30 48.70 63.22 81.35` and the same values negated |

For example, `asin(0.5/2.56) = 11.27`, `acos(2.5/2.56) = 12.43` and `asin(1.5/2.56) = 35.87`.

Per frame in the air:
1. Compute `opt` as strafebot does. The target wishdir is `velYaw ± opt`.
2. Over the 24 edges, pick the one closest to the target **on the inner side**, between `opt − 90°` and `opt`.
3. Put the wishdir exactly on that edge. For odd table indexes, add 1 short (`0x5025d8` = 0.005493° = 360/65536) so
   that `ANGLE2SHORT` truncation lands inside the better zone.

On the ground snapbot does the same as strafebot. It never checks which rounded velocity actually wins. It assumes the
inner edge is best, and it only works for 2.56 / 3.328, so at 125 fps.

## Automation (`0x409860`) and other commands

- **`+autojump`:** on a ground frame it sends the jump upmove. The next frame it forces upmove 0 for one frame, so
  `PMF_JUMP_HELD` clears and the next landing can jump again.
- **`+autohob`:** waits one ground frame, then jumps on the second.
- **`er_upmove 1`: clamps every upmove to at most 10, including a manual `+moveup` (`0x42ff00`).** `PM_CheckJump` only
  needs `upmove >= 10`, so the jump still happens. But the jump frame's `PM_AirMove` runs `PM_CmdScale` with upmove
  included:
  - W+A+jump at 127: wishspeed = 320·√(2/3) = **261.3**, accelspeed 2.09
  - W+A+jump at 10: wishspeed ≈ **319.5**, accelspeed 2.56

  At the optimum the speed gain is about `(2aw − a²) / 2v`. At 600 ups that gives +1.36 ups instead of +0.91 on every
  jump frame. Jump height doesn't change (`JUMP_VELOCITY` is a fixed value).
- **`+autouob`:** picks forward/side keys against the horizontal velocity to bring it to 0 (127, or 40 VQ3 / 20 CPM
  once a component is under 5 ups), presumably to set up vertical overbounces.
- **`+autozwob`:** on ground frames with no forward key, sends `forwardmove = (int)m_forward`; in the air it sends 0.
  The purpose is unclear (likely an overbounce helper).
- **`+slippyboost`:** strafebot with no friction and no bias, for slick ground.
- **`+aimstick` + `er_stickpoint "x y z"`:** turns yaw and pitch to face a world point.
- **`fm` / `rm` / `um`:** when non-zero, these cvars replace forwardmove / rightmove / upmove.
- **`er_integer_keystate 1`:** `CL_KeyState` returns 1 for any non-zero fraction, so a bound key gives the full 127 on
  its press frame. cfg-issued `+x` / `-x` don't need this: they carry no timestamp, so stock `CL_KeyState` already gives
  0 or 1 (oDFe `cl_input.c:142-143`, `156-163`, `207-208`).
- **`er_angleshort <pitch> <yaw>`:** sets the view to exact angle shorts:
  `cl.viewangles = (S − delta_angles) × 360/65536`. `pyr` does the same for pitch, yaw and roll. `er_setview`,
  `er_setroll` and `er_calculate_angle` (degrees to short) are helpers. Our planned `setyaw` adds +0.5 short before
  converting, so float error can't truncate to S−1.
- **HUD and other:**
  - `scr_hud_snap_*`: snap-zone HUD
  - `scr_hud_pitch_*`
  - `df_promode`
  - map autodownload from `ws.q3df.org` (`dl_*`)

Cvar defaults: `sb_anglescoef_air 0.01`, `sb_anglescoef_ground 0.08`, `sb_fkey_enable 1`, `sb_cpmturnspeed 1` (clamped
0–10), `sb_backstrafe 0` (0–1), `sb_oldmode 0`, `er_upmove 0` (0–1), `er_promode 0`, `er_integer_keystate 0`,
`er_qvm_offsets 957380`, `er_stickpoint "0 0 0"`, `fm`/`rm`/`um` 0.

## Comparison with our approach

| | erbot | ours ([BOT_PLAN.md](./BOT_PLAN.md)) |
|---|---|---|
| State | Predicted ps read from QVM memory (works online, tied to one cgame build) | `cl.snap.ps` with `fixedtime 8` (exact locally, lagged online) |
| Angle | CGaz formula + empirical bias | One-frame float32 Pmove model; searches the yaw shorts for the best **rounded** velocity |
| Snapping | Fixed edge tables, 125 fps only, never scored | Rounded outcome scored for every zone; any speed / accel |
| Friction | `speed·(1−6/125)`, no stopspeed | `max(v,100)·6·dt` like `PM_Friction` |
| Jump frame | AirMove model, **upmove 10** | AirMove model, upmove 10 (adopted 2026-10-12; was 127) |
| Output | Yaw float through `AngleSubtract` | Exact yaw short via the `setyaw` math |

**Worth adopting:**
1. **Jump-frame upmove 10.** *(Adopted 2026-10-12: autojump and the optimizer send 10, and `cl_scriptRun` caps
   `+moveup` to 10. With velocity rounding the gain is smaller at high speed than the continuous estimate below; see
   CHANGELOG.md.)* Our autojump sent 127 (oDFe `cl_input.c:649`), and the tool's model assumes it
   (`waypoint-optimizer.js:17` `JUMP_WISH = SPEED*sqrt(2/3)`). Sending 10 keeps the jump and restores the full 2.56
   accel on that frame. `strafe.js` already passes `keys.u` into `PM_CmdScale`, so the chooser handles 10 as it is.
   Plain cfg `+moveup` always sends 127 (or 64 when walking), so scripts would need an engine-side clamp like erbot's
   `er_upmove`, or the autojump bot.
2. **One-frame jump release** after each jump. This already matches the plan's autojump ("ground frame with jump
   released").
3. **Exact angle shorts** for scripted views (`er_angleshort`). This matches the plan's `setyaw`.

**Not worth adopting:** the bias values, the fixed tables and the hardcoded 125 fps. The plan's rounded-outcome search
replaces all three.

## How the analysis was done (to repeat it)

**rea.** The [rea](https://github.com/morluto/rea) CLI (`npx rea-agents@latest`, v6.4.0) installs and `rea doctor`
passes once `GHIDRA_INSTALL_DIR` points at Ghidra 12.1.x. But on Windows its bridge fails every time with
`GhidraLaunchError: Ghidra headless launch failed` (its README calls Windows Ghidra support experimental). `rea setup`
was not run, because it edits the MCP configs of every installed agent.

**Ghidra headless directly** (Temurin JDK 21 + Ghidra 12.1.4, both portable zips). Python isn't needed; Java
postScripts compile on the fly:

```powershell
$env:JAVA_HOME = '<jdk-21>'; $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$G = '<ghidra_12.1.4_PUBLIC>\support\analyzeHeadless.bat'
& $G <projDir> erbot -import erbot.exe -overwrite                      # auto-analysis, ~90 s
& $G <projDir> erbot -process erbot.exe -noanalysis -readOnly -scriptPath <scripts> `
     -postScript DecompRange.java 0x408000 0x40d400 out.c              # bot code is in this range
```

```java
// DecompRange.java: decompile every function starting in [start, end)
import ghidra.app.script.GhidraScript; import ghidra.app.decompiler.*; import ghidra.program.model.listing.*; import java.io.*;
public class DecompRange extends GhidraScript { public void run() throws Exception {
  String[] a = getScriptArgs(); long s = Long.decode(a[0]), e = Long.decode(a[1]);
  PrintWriter out = new PrintWriter(new FileWriter(a[2]));
  DecompInterface di = new DecompInterface(); di.openProgram(currentProgram);
  for (Function f : currentProgram.getFunctionManager().getFunctions(toAddr(s), true)) {
    if (f.getEntryPoint().getOffset() >= e) break;
    DecompileResults r = di.decompileFunction(f, 120, monitor);
    out.println("// ===== " + f.getName() + " @ " + f.getEntryPoint());
    out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// FAILED " + r.getErrorMessage());
  }
  out.close(); } }
```

For the x87 math, list the instructions instead: `disassemble(addr)`, then iterate
`currentProgram.getListing().getInstructions(new AddressSet(s, e), true)`. To find a cvar's code, look for
`push <string VA>` in `.text`: `Cvar_Get` is `0x4266b0`, `Cmd_AddCommand` is `0x421860`, and `CL_InitInput` @
`0x40cb30` registers every bot command and cvar.

## Address map

| Address | What |
|---|---|
| `0x40c4e0` | `CL_CreateCmd` |
| `0x40cb30` | `CL_InitInput` (registers commands and cvars) |
| `0x408fa0` | `CL_KeyState` (+ `er_integer_keystate`) |
| `0x409860` | `CL_KeyMove` + automation |
| `0x40a140` / `0x40a830` / `0x40bad0` / `0x40b880` | strafebot / snapbot / slippyboost / aimstick |
| `0x409400`–`0x4094f0` | +/- handlers. Flags: `0x82fa8c` autojump, `…90` autohob, `…94` strafebot, `…98` snapbot, `…a0` slippyboost, `…a4` aimstick, `…a8` autouob, `…ac` autozwob |
| `0x4095e0` / `0x409670` | `er_angleshort` / `pyr` |
| `0x42fee0` / `0x42ff00` | `ClampChar` / upmove clamp (`er_upmove`) |
| `0x430810` / `0x4307c0` | `AngleSubtract` / `AngleNormalize180` |
| `0x4d6ff0` / `0x4d70ba` / `0x4d7ae0` / `0x4d7330` | `sqrt` / `atan2` / `acos` / `_ftol` |
| `0x52c028` / `0x52c088` | snap-edge tables (normal / haste) |
| `0xcba178` / `0xcba17c` | `cl.viewangles[PITCH]` / `[YAW]` |
| `0xcb4900` | `cl.snap.ps` |
| `0x82fa88` | QVM offset parsed from `er_qvm_offsets` |
