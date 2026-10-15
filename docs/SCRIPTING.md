# Movement scripts

A movement script is a plain Quake 3 cfg. The web viewer's script editor runs it on the WASM Pmove, and the modified
oDFe (`Q3BeamSearch.Console/References/oDFe`) plays the same file with `scriptplay`. With `cl_scriptRun 1` both
produce the same usercmds frame for frame:
- `wwwroot/js/movement-script.js` emulates the engine's `cl_input.c`;
- `wwwroot/js/strafe.js` and oDFe `code/client/cl_snapyaw.c` are twin angle choosers that agree on every yaw short
  (checked on 20,000 states, half of them CPM).

Physics is VQ3 or CPM (DeFRaG `df_promode 1`), picked in the viewer's **Physics** menu. Scripts, the optimizer, the
frame editor and exports all use it. See [Physics: VQ3 and CPM](#physics-vq3-and-cpm).

## Running in oDFe

Exported files ([below](#exporting-for-odfe-wwwrootjscfg-exportjs)) set everything up themselves. Put the file in
`defrag/`, set `df_promode` to the export's physics (0 VQ3, 1 CPM), then `devmap <map>`, stand still at the spawn, and
run `scriptplay <name>`. A hand-written script needs:

```
df_promode 0                // 1 for CPM
devmap <map>
// stand still at the spawn, don't touch the mouse
set fixedtime 8; set com_maxfps 125; set cl_scriptRun 1
scriptplay <script>
```

**Why `scriptplay` and not `exec`.**
- `exec` puts the cfg into the console command buffer, and what one `wait` means there depends on the engine:
  - ioq3 and older engines count a wait down in every `Cbuf_Execute`, which runs twice a frame. That is the
    community's "wait 2 = one frame".
  - This oDFe counts it once a frame in `Cbuf_Wait` (`qcommon/cmd.c`, called at the end of `Com_Frame`).
  - Any `EXEC_NOW` command from the game or UI cancels a pending wait in either engine.
- `scriptplay` reads the cfg itself and runs it from `CL_CreateCmd`: the commands up to `wait N` run right before a
  usercmd, then N usercmds go out. So one usercmd is exactly `wait 1`, like the tool, in any build with these changes.
  (Its stepping was checked by compiling the real `scriptplay` code into a harness: 400/400 frames identical to the
  tool on a baked run, and identical on a cfg full of comments, quotes and `wait` forms.)
- `scriptstop` stops a playing script, and `scriptpos` prints the state the next usercmd starts from.
- `scriptphysics vq3|cpm` (exports start with it) checks the game's physics. DeFRaG flags CPM in the snapshot's
  `pm_flags`. On a mismatch it prints which `df_promode` to set and stops the script.
- On its first frame, `scriptplay` warns about anything the tool doesn't simulate:
  - `fixedtime`, `com_maxfps`, `cl_scriptRun`, `sv_fps`, `timescale`, `g_speed`, `g_gravity` with other values;
  - not running a local game.

**Notes:**
- `fixedtime 8` needs cheats, hence `devmap`. It makes every frame exactly 8 ms, so the local server runs one frame and
  sends one snapshot per usercmd (`sv_fps` is 125 by default). The bots then read the result of the previous cmd.
- **`cl_scriptRun 1`:**
  - each usercmd moves exactly 8 ms (no `CL_AdjustTimeDelta` nudges);
  - the mouse is ignored;
  - no `BUTTON_TALK` while the console is open. Normally an open console adds it to every usercmd, and Pmove then drops
    all movement, so a script started from the console wouldn't move until the console closed;
  - upmove is capped to 10;
  - `+left` / `+right` turn the *script yaw*.
- The script yaw is the server's view yaw in degrees, without `delta_angles`. That is what makes keyboard turns
  repeatable in the tool. Switching `cl_scriptRun` on starts it at the current view yaw.
- Online the snapshot lags, so the bots are approximate there. Scripts are meant for local runs.

## Language

Commands are separated by `;` or line breaks. `//` and `/* */` are comments, and `;` inside quotes doesn't split.
Names are case-insensitive.

| Command | Effect |
|---|---|
| `+forward` `+back` `+moveleft` `+moveright` | Movement keys: 127 each (64 when walking, see `+speed` / `cl_run`). |
| `+moveup` | Jump: sends upmove **10** under `cl_scriptRun`. `PM_CheckJump` only needs 10, and 10 keeps the wishspeed at 319.5 instead of 261.3 on jump frames and while jump is held. |
| `+movedown` | Crouch (upmove −127). |
| `+left` `+right` | Turn the script yaw by `0.008 × cl_yawspeed` degrees per frame (`× cl_anglespeedkey` with `+speed`). The float math is identical in the tool and the engine. |
| `+speed` `+strafe` | As in Q3: walk/run toggle with `cl_run`, and `+strafe` makes `+left` / `+right` strafe. |
| `+autojump` | Jumps (upmove 10) on every frame that starts on the ground with jump released: frame-perfect hops, no friction frame. |
| `+snapbot` | Each frame, the yaw whose **rounded** velocity is fastest (Pmove snaps velocity to integers every frame). |
| `+strafebot` | Each frame, the continuous CGaz angle `acos((W − a) / v)`, rounded to a yaw short. Slower than `+snapbot`, mostly at low speed: from a standstill, 747 ups after 400 frames against 804. |
| `wait N` | Run N frames (usercmds) with the current state. `wait` = 1 frame, `wait 0` = none, negative = 1. |
| `setyaw <deg>` | Set the view yaw exactly, rounded to the nearest of the 65536 yaw steps. |
| `scriptphysics vq3\|cpm` | The physics the script is for. The tool errors if it isn't the Physics menu's; the game stops the script if it isn't the game's. |
| `set` / `seta` / `sets` / `setu <cvar> <value>`, or `<cvar> <value>` | `cl_yawspeed` (140), `cl_anglespeedkey` (1.5), `cl_run` (1). |
| `echo`, `viewpos`, `scriptpos`, `centerview`, `clear` | No effect on movement. |

**Bot details:**
- The bots turn toward the strafe key's side: moveleft turns left. With no strafe key, `+left` / `+right` pick the side
  and press that strafe key, so `+snapbot; +forward; +left` curves left.
- Bots and autojump read the previous frame's result: velocity, ground state, and `PMF_JUMP_HELD`.
- In CPM the bots use CPM physics (in game they read `PMF_PROMODE` from the snapshot). A strafe key without `+forward`
  sidestrafes: `+snapbot; +moveleft` picks the best angle for accel 70 up to 30, a far tighter turn than W+A.

**Errors in the tool:**
- The tool stops at the first command it can't reproduce, shows the line, and keeps the frames before it:
  - unknown commands;
  - other `+`/`-` buttons (`+attack`, `+lookup`, …);
  - keys with arguments;
  - `exec`, `bind`, `vstr`;
  - `fixedtime` other than 8, `com_maxfps` other than 125, `sv_fps` other than 125, `g_speed` other than 320,
    `g_gravity` other than 800, `cl_scriptRun 0`;
  - `scriptphysics` for the other physics;
  - `df_promode`, which only changes with the map (use the Physics menu).
- A script may also run at most 10 minutes of frames.

**Where the run starts:**
- The tool starts at the map's first `info_player_deathmatch` / `info_player_start`: 9 units up, landed and at rest,
  facing the spawn angle.
- The engine starts wherever you stand. Put a `setyaw` first so the view yaw doesn't depend on where you looked.

## Example

```
setyaw 90
+forward; wait 24           // run straight
+snapbot; +autojump; +left  // strafe-jump, curving left
wait 300
-left; +right               // now curve right
wait 200
-snapbot; -autojump; -right; -forward
```

## Physics: VQ3 and CPM

The **Physics** menu (viewer controls) switches the WASM Pmove between VQ3 and CPM, DeFRaG's `df_promode 1`. The rules
and where they come from are in [PHYSICS_AND_COLLISION.md](./PHYSICS_AND_COLLISION.md#cpm-defrag-df_promode-1).

What changes for scripts:
- **Ground accel 15.** Prestrafes build up speed faster.
- **Strafe key alone in the air:** accel 70, wishspeed capped to 30. That is up to 16.8 ups a frame sideways: a
  ~1.6°-a-frame turn at 600 ups, and the fastest way to gain speed below ~30 ups.
- **Forward alone in the air:** air control turns the velocity toward the view without changing its speed.
- **Double jumps:** a jump within 400 ms of the jump that opened the window gets +100. Jumping while moving up adds to
  the vertical speed.

What changes for the optimizer: in the air, every frame it also tries the strafe key alone and (when turning counts)
forward alone, and keeps whichever scores best. On dhoni's first leg that gives 292 frames / 783 ups (VQ3: 322 / 749).
It searches about 7 times slower than VQ3.

Switching the physics drops the last optimizer route's export (it was made for the other physics). Re-run it.

## Exporting for oDFe (`wwwroot/js/cfg-export.js`)

| Button | What you get |
|---|---|
| Script editor → **Export .cfg** | The script **as written**, between a header and a footer. Bots run live in game. |
| Script editor → **Export baked** | The script's run **baked**: per frame, only what changed (`+key` / `-key`, `setyaw <exact short>`), then `wait N` for N identical frames. No bots or turn keys, so the game replays the same usercmds whatever its bots would decide. |
| Route optimizer → **Export .cfg** (after a run) | The route, baked. |
| Frame editor → **Export .cfg** | The editor's frames, baked. |

**Header:**
```
// <name>.cfg: VQ3 movement for <map>, made with Q3BeamSearch (docs/SCRIPTING.md)
// Needs the modified oDFe. Put it in defrag/, then: df_promode 0, devmap <map>, stand still at the spawn, scriptplay <name>
// scriptplay sends one usercmd per wait in any engine; exec only matches in builds that count wait once a frame.
set fixedtime 8; set com_maxfps 125; set cl_run 1; set cl_scriptRun 1
scriptphysics vq3                          // cpm for CPM exports
-forward; -back; ... ; -strafebot          // everything released
setyaw <spawn angle>                       // as written only; baked sets the yaw on frame 0
```

**Checkpoints (baked files):** every second (125 frames) a line prints what the tool expects, then the game's own
state:
```
echo expected after 125 frames: origin <x y z>, <N> ups, vz <vz>; scriptpos
```
In game that gives pairs like
`expected after 125 frames: origin …` / `scriptpos: after 125 frames: origin …`. The first pair that differs shows
when the game and the tool part ways.

**Footer:**
```
-forward; ... ; -strafebot
set cl_scriptRun 0; set fixedtime 0
echo expected end after <F> frames: origin <x y z>, <N> ups, vz <vz>; scriptpos
echo expected race time 0:04.328 (...)     // when the run crosses the map's start and stop triggers
```
The race time follows DeFRaG's timer triggers (`wwwroot/js/race-timer.js`): it runs from the last frame touching a
start trigger to the first frame touching a stop trigger, 8 ms a frame. Compare it with the time DeFRaG prints.

**How exports are built:**
- **Map name.** `<map>` is the BSP's own name inside the pk3 (`maps/<map>.bsp`), which is what `devmap` takes. dhoni.pk3
  holds `pornstar-dhoni`.
- **Expectations.** They come from running the export itself through the tool, from the landed spawn. A baked export is
  also checked to reproduce every usercmd of the run it came from; if it doesn't, the export fails instead of
  downloading.
- **Size.** Always one file: `scriptplay` reads any size. `exec` reads at most 64 KB (the command buffer), about
  2,000 baked changes.
- **Downloads.** The file goes to the browser's download folder. Copy it into your oDFe `defrag/` folder, or the
  `defrag/` under `fs_homepath`.
- **Moves keys can't make.** Baking needs moves that keys can produce: 0 / ±127 (±64 with `+speed`), and upmove 0, 10
  or negative. Anything else is refused.
- **Frame editor runs.** They start where the editor started, but their export replays from the landed spawn like the
  game. The echoed end is where the game will be.
