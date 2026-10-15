// wwwroot/js/waypoint-optimizer.js
// VQ3 TAS route optimizer. Physics is the real oDFe Pmove in q3physics.wasm.
//
// Every frame a strafe controller holds forward + strafe and picks the yaw short whose
// ROUNDED velocity scores best (strafe.js: Pmove snaps velocity every frame, so this beats
// the continuous CGaz angle), steering toward the next waypoint and bunnyhopping on the
// first frame back on the ground (a frame-perfect jump skips ground friction). Jump frames
// send upmove 10, the least PM_CheckJump accepts, so PM_CmdScale barely lowers that
// frame's wishspeed (319.5 instead of 261.3 at upmove 127). A beam search over a few
// controller settings per waypoint picks the route by TAS criteria:
//   all waypoints reached > fewest frames > highest final speed > fewest jumps.
// The route starts where a script would in game: at the map spawn, landed and at rest.
// On a map with DeFRaG timer triggers it can finish in the stop trigger, and "frames" means
// race frames: from the last frame in the start trigger (frames spent there are free).
// CPM (DeFRaG df_promode 1, the WASM's pm_promode): ground accel 15, and in the air each frame
// also tries the strafe key alone (accel 70 up to 30: tight turns, and fast from low speed)
// and forward alone (air control), keeping whichever keys score best that frame.

import { shortToYaw } from './strafe.js';
import { PmoveRunner } from './pmove-runner.js';
import { touches, boxCenter, raceTime, PLAYER_MINS, PLAYER_MAXS } from './race-timer.js';

// VQ3 constants (bg_pmove.c, wrapper.c InitPhysics defaults)
const DT = 0.008;                      // 125 fps
const SPEED = 320;                     // ps.speed
const ACCEL = 10, AIR_ACCEL = 1;       // pm_accelerate, pm_airaccelerate
const CPM_ACCEL = 15;                  // CPM ground accel
const CPM_TURN = 70 * 30;              // CPM strafe key alone: accel × wishspeed, ups/s sideways
const FRICTION = 6, STOP_SPEED = 100;  // pm_friction, pm_stopspeed
const KEY = 127;                       // usercmd moves are signed chars
const JUMP_UP = 10;                    // jump-frame upmove: PM_CheckJump needs >= 10
const JUMP_WISH = SPEED * Math.hypot(KEY, KEY) / Math.hypot(KEY, KEY, JUMP_UP); // PM_CmdScale, ~319.5
const STAND = 24;                      // player origin height above the floor (bbox mins z)
const HALF_WIDTH = PLAYER_MAXS[0];     // 15: the hitbox reaches this far past the origin across

// Search space. Every combination is simulated, so nothing has to be chosen by hand.
//   turn:       λ in strafe.bestYaw's score (1-λ)·speed + λ·progress toward the waypoint;
//               0 = speed only, 1 = turn toward the waypoint as hard as pays off
//   groundTurn: skip the bunnyhop and turn on the ground while heading error exceeds this
//   cut:        aim this fraction of the radius toward the following waypoint (corner cutting)
//   prestrafe:  ground frames before the first jump (first leg only)
const TURNS = [0, 0.3, 1];
const GROUND_TURNS = [Math.PI / 3, (2 * Math.PI) / 3, Infinity];
const CUTS = [0, 0.8];
const combos = prestrafes => TURNS.flatMap(turn => GROUND_TURNS.flatMap(groundTurn =>
    CUTS.flatMap(cut => prestrafes.map(prestrafe => ({ turn, groundTurn, cut, prestrafe })))));
const FIRST_LEG = combos([0, 8, 16, 24]), LEG = combos([0]);
const BEAM = 4;  // ponytail: greedy per-leg beam; widen if routes with sharp turns come out poor

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));          // radians to (-pi, pi]
const toShort = rad => ((Math.round(rad * 65536 / (2 * Math.PI)) % 65536) + 65536) % 65536;
const hspeed = v => Math.hypot(v[0], v[1]);
// Does the player's hitbox (standing: mins -15 -15 -24, maxs 15 15 32 around the origin) touch
// a waypoint ball of radius r, with the origin (dx, dy, dz) from the ball's centre? True when
// the box's nearest point to the centre is within r: grazing the ball counts, the middle
// doesn't matter. Playback uses it too, so what's drawn is what's reached.
export function hitboxTouches(dx, dy, dz, r) {
    const near = (d, k) => { const lo = d + PLAYER_MINS[k], hi = d + PLAYER_MAXS[k]; return lo > 0 ? lo : hi < 0 ? hi : 0; };
    const x = near(dx, 0), y = near(dy, 1), z = near(dz, 2);
    return x * x + y * y + z * z <= r * r;
}
// A trigger target ({box}) is reached when the player touches it.
const reached = (pos, wp) => wp.box ? touches(wp.box, pos) : hitboxTouches(pos[0] - wp.x, pos[1] - wp.y, pos[2] - wp.z, wp.r);
// How far off a target's centre the origin can pass and still reach it (across, height aside)
const reachRadius = wp => wp.box ? 0 : wp.r + HALF_WIDTH;

// Frames that count: after the last frame in a start trigger, if one was touched.
const counted = node => (node.timerStart >= 0 ? node.inputs.length - 1 - node.timerStart : node.inputs.length);

// Beam order: frames so far + time to cover the rest of the route at the current speed.
// After the last waypoint this is just the frame count, i.e. the TAS order.
function estimate(node, wps, seg) {
    let rest = 0, x = node.pos[0], y = node.pos[1];
    for (let i = seg + 1; i < wps.length; i++) {
        rest += Math.hypot(wps[i].x - x, wps[i].y - y);
        x = wps[i].x; y = wps[i].y;
    }
    return counted(node) + rest / Math.max(hspeed(node.vel), SPEED) / DT;
}

export class WaypointOptimizer {
    constructor(Q3, cpm = false) {
        this.sim = new PmoveRunner(Q3, cpm);
        this.cpm = cpm;
        this._cancelled = false;
        // Runs one leg's candidates: (start, beam, jobs, wps, seg, progress) => Promise of the
        // children, in job order. null = this.runLeg (here, one after another); the optimizer
        // worker plugs in a pool of helper workers instead.
        this.legRunner = null;
    }

    cancel() { this._cancelled = true; }

    // One frame of input: forward + strafe, the yaw short strafe.bestYaw scores best
    // (speed, or speed blended with progress toward the aim point, per p.turn), and a jump
    // on the first ground frame. `margin`: how close to the aim point counts as inside.
    _control(st, aim, margin, p, frame) {
        const sp = hspeed(st.vel);
        const bearing = Math.atan2(aim[1] - st.pos[1], aim[0] - st.pos[0]);
        const velAng = sp < 1 ? bearing : Math.atan2(st.vel[1], st.vel[0]);
        const phi = wrap(bearing - velAng);
        const side = phi >= 0 ? 1 : -1;                  // +1 = turn left (counter-clockwise)

        // Would even a full-strength air turn (wish 90° off velocity) miss the waypoint?
        // That turn's radius is v²·dt / a = v² / 320 (CPM strafe key alone: v² / 2100); if the
        // aim point sits inside the circle by more than `margin`, slow down on the ground instead of hopping.
        const R = sp * sp / (this.cpm ? CPM_TURN : AIR_ACCEL * SPEED);
        const cx = st.pos[0] - side * Math.sin(velAng) * R, cy = st.pos[1] + side * Math.cos(velAng) * R;
        const brake = R - Math.hypot(aim[0] - cx, aim[1] - cy) > margin;
        const jump = st.onGround && frame >= p.prestrafe && Math.abs(phi) <= p.groundTurn && !brake;
        let keys = { f: KEY, s: -side * KEY, u: jump ? JUMP_UP : 0 };
        const mode = jump ? 'jump' : st.onGround ? 'ground' : 'air';

        let yawShort = null;
        if (!brake) {
            // Below the CGaz threshold every angle up to ~90° gets full accel, so
            // heading straight for the aim point costs no speed: score progress only.
            const wish = jump ? JUMP_WISH : SPEED, accel = mode === 'ground' ? (this.cpm ? CPM_ACCEL : ACCEL) : AIR_ACCEL;
            const vf = mode === 'ground' ? Math.max(0, sp - Math.max(sp, STOP_SPEED) * FRICTION * DT) : sp;
            const lambda = vf <= wish - accel * DT * wish ? 1 : p.turn;
            const aimDir = [Math.cos(bearing), Math.sin(bearing)];
            const score = o => (1 - lambda) * Math.hypot(o[0], o[1]) + lambda * (o[0] * aimDir[0] + o[1] * aimDir[1]);
            // CPM air (jump frames are AirMove too): strafe key alone, and forward alone when turning
            // counts (its air control turns without gaining, so on speed alone it can't beat forward + strafe)
            // ponytail: up to three chooser calls per CPM air frame (~7x the VQ3 search time); prune if long routes get slow
            const tries = !this.cpm || mode === 'ground' ? [keys]
                : lambda ? [keys, { ...keys, f: 0 }, { ...keys, s: 0 }] : [keys, { ...keys, f: 0 }];
            let best = -Infinity;
            for (const k of tries) {
                const r = this.sim.bestYaw({ vel: st.vel, mode, cpm: this.cpm }, k, side, { aim: aimDir, lambda });
                if (r && score(r.vel) > best + 1e-9) { best = score(r.vel); yawShort = r.yawShort; keys = k; }
            }
        }
        if (yawShort === null) {
            // Braking (ground: aim at it, friction tightens the turn; air: turn hardest),
            // or standing still: wish straight at the aim point.
            const want = Math.min(Math.abs(phi), Math.PI / 2);
            const d = brake && !st.onGround ? Math.PI / 2 : want;
            // Forward + left strafe puts the wish direction 45° left of the view, right strafe 45° right.
            yawShort = toShort(velAng + side * d - side * Math.PI / 4);
        }
        return { ...keys, yawShort, yaw: shortToYaw(yawShort) };
    }

    // Aim point: the waypoint centre, or `cut` of its reach (radius + the hitbox's half width:
    // the box only has to graze the ball) toward the following waypoint.
    _aim(wp, next, cut) {
        if (!next || !cut) return [wp.x, wp.y];
        const dx = next.x - wp.x, dy = next.y - wp.y, l = Math.hypot(dx, dy) || 1, R = reachRadius(wp);
        return [wp.x + dx / l * cut * R, wp.y + dy / l * cut * R];
    }

    // Replay `node` from the start, then drive the controller to waypoint `seg`.
    // Returns the extended node, or null if the waypoint isn't reached within the cap.
    _extend(start, node, wps, seg, p) {
        const st = this.sim.reset(start);
        for (const inp of node.inputs) this.sim.step(st, inp);
        const wp = wps[seg], aim = this._aim(wp, wps[seg + 1], p.cut);
        const inputs = node.inputs.slice();
        let jumps = node.jumps, timerStart = node.timerStart;
        // ponytail: cap = 2.5x the straight-line time at ground speed + 1 s; raise if long curving legs time out
        const cap = inputs.length + Math.ceil(2.5 * Math.hypot(wp.x - st.pos[0], wp.y - st.pos[1], wp.z - st.pos[2]) / SPEED / DT) + 125;
        const margin = (1 - p.cut) * reachRadius(wp);   // aim is cut·reach off centre, so this much slack still reaches it
        while (inputs.length < cap) {
            const inp = this._control(st, aim, margin, p, inputs.length);
            this.sim.step(st, inp);
            inputs.push(inp);
            if (inp.u) jumps++;
            if (this.startBoxes.some(b => touches(b, st.pos))) timerStart = inputs.length - 1;
            if (reached(st.pos, wp)) return { inputs, jumps, timerStart, pos: [...st.pos], vel: [...st.vel] };
        }
        return null;
    }

    // Every candidate of a leg (jobs: {node: index into beam, p}), here, one after another.
    // Returns the children in job order (null = waypoint not reached); stops early on cancel.
    async runLeg(start, beam, jobs, wps, seg, progress) {
        const children = [];
        for (let i = 0; i < jobs.length && !this._cancelled; i++) {
            children.push(this._extend(start, beam[jobs[i].node], wps, seg, jobs[i].p));
            if ((i + 1) % 8 === 0) {   // report, and let a 'cancel' message in
                progress(i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return children;
    }

    // One continuous run of the chosen inputs: the exact path to display.
    _replay(start, inputs) {
        const st = this.sim.reset(start);
        const positions = [], velocities = [], onGround = [];
        for (const inp of inputs) {
            this.sim.step(st, inp);
            positions.push({ x: st.pos[0], y: st.pos[1], z: st.pos[2] });
            velocities.push({ x: st.vel[0], y: st.vel[1], z: st.vel[2] });
            onGround.push(st.onGround);
        }
        return { positions, velocities, onGround };
    }

    // Waypoints in viewer convention (y = -Q3_Y), clicked on the floor. With `spawn`
    // ({origin: Q3 [x, y, z]}) the route starts at that spawn, landed, and every waypoint is
    // a target; without one it starts standing on waypoint 1. `race` ({start, stop} trigger
    // boxes from race-timer.js, finish: bool) ranks by race frames and, with finish, ends the
    // route in the stop trigger nearest the last waypoint. Cancel stops after the current
    // candidate and returns the best route so far.
    async optimizeRoute(waypoints, onProgress, spawn = null, race = null) {
        this._cancelled = false;
        this.startBoxes = race?.start ?? [];
        // z = the ball centre: on the clicked floor, raised by the waypoint's height (the gap under the ball)
        const all = waypoints.map(w => ({ x: w.position.x, y: -w.position.y, z: w.position.z + w.radius + (w.height ?? 0), floor: w.position.z, r: w.radius }));
        const start = spawn ? this.sim.settle(spawn.origin) : { pos: [all[0].x, all[0].y, all[0].floor + STAND], onGround: false };
        // wps[0] is the start; legs go to wps[1..]
        const wps = spawn ? [{ x: start.pos[0], y: start.pos[1], z: start.pos[2] - STAND, r: 0 }, ...all] : all;
        if (race?.finish && race.stop?.length) {
            const last = wps.at(-1), d = b => { const c = boxCenter(b); return Math.hypot(c[0] - last.x, c[1] - last.y, c[2] - last.z); };
            const box = race.stop.reduce((a, b) => (d(b) < d(a) ? b : a));
            const [x, y, z] = boxCenter(box);
            wps.push({ x, y, z, r: 0, box });
        }
        const first = spawn ? 1 : 2;            // user waypoint number of the first target
        const totalSeg = wps.length - 1;
        let beam = [{ inputs: [], jumps: 0, timerStart: -1, pos: start.pos, vel: [0, 0, 0] }];
        let done = 0;

        const runLeg = this.legRunner ?? ((...a) => this.runLeg(...a));
        for (let seg = 1; seg <= totalSeg; seg++) {
            const grid = seg === 1 ? FIRST_LEG : LEG;
            const jobs = beam.flatMap((_, node) => grid.map(p => ({ node, p })));
            const progress = step => onProgress?.({ seg: seg - 1, totalSeg, wp: wps[seg].box ? 'finish' : first + seg - 1, step, total: jobs.length });
            const children = await runLeg(start, beam, jobs, wps, seg, progress);
            // Merged in job order, so a pool's result is the same as running them one by one.
            const seen = new Map();   // identical routes from different settings collapse here
            for (const child of children)
                if (child) seen.set(`${child.inputs.length}|${child.pos.map(c => c.toFixed(2))}`, child);
            if (seen.size) {
                const est = new Map([...seen.values()].map(n => [n, estimate(n, wps, seg)]));
                beam = [...seen.values()]
                    .sort((a, b) => est.get(a) - est.get(b) || hspeed(b.vel) - hspeed(a.vel) || a.jumps - b.jumps)
                    .slice(0, BEAM);
                done = seg;
            }
            if (!seen.size || this._cancelled) break;
        }

        const best = beam[0], replay = this._replay(start, best.inputs);
        return { inputs: best.inputs, jumps: best.jumps, reached: done, totalSeg, first,
                 finish: !!wps.at(-1).box, start: start.pos, cancelled: this._cancelled, replay,
                 race: race ? raceTime(replay.positions, race) : null };
    }
}
