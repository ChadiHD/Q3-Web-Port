// Self-check for the DeFRaG race timer and the optimizer's finish in the stop trigger.
// Run: node tests/race-timer.check.mjs
import assert from 'node:assert/strict';
import { findTimerTriggers, touches, raceTime, formatMs } from '../Q3BeamSearch/wwwroot/js/race-timer.js';
import { WaypointOptimizer } from '../Q3BeamSearch/wwwroot/js/waypoint-optimizer.js';
import { flatFloorQ3 } from './flat-floor-q3.mjs';

// Triggers found through their target, with their brush model bounds (dhoni's layout)
const bsp = {
    models: [{ mins: [-9e3, -9e3, -9e3], maxs: [9e3, 9e3, 9e3] },
             { mins: [-100, 200, 0], maxs: [100, 208, 300] },        // *1 start: a thin wall at y = 200..208
             { mins: [900, -100, 0], maxs: [1000, 100, 300] },       // *2 checkpoint
             { mins: [1900, -200, 0], maxs: [2000, 200, 300] }],     // *3 stop
    entities: [
        { properties: { classname: 'target_startTimer', targetname: 't1' } },
        { properties: { classname: 'trigger_multiple', target: 't1', model: '*1' } },
        { properties: { classname: 'target_checkpoint', targetname: 't2' } },
        { properties: { classname: 'trigger_multiple', target: 't2', model: '*2' } },
        { properties: { classname: 'target_stopTimer', targetname: 't3' } },
        { properties: { classname: 'trigger_multiple', target: 't3', model: '*3' } },
        { properties: { classname: 'trigger_push', target: 'nowhere', model: '*0' } },
    ],
};
const t = findTimerTriggers(bsp);
assert.deepEqual([t.start.length, t.checkpoints.length, t.stop.length], [1, 1, 1]);

// The player box (±15, -24..+32) grown by 1 touches a box 16 units away, not 17
const box = { mins: [100, -10, 0], maxs: [110, 10, 100] };
assert.ok(touches(box, [84, 0, 50]) && !touches(box, [83, 0, 50]));

// From the first frame touching the start trigger (frames 1 and 2 touch it; the trigger's wait
// stops frame 2 restarting the timer) to the first in the stop trigger, 8 ms a frame
const path = [[0, 150], [0, 205], [0, 207], [0, 230], [500, 0], [950, 0], [1500, 0], [1950, 0], [2500, 0]].map(([x, y]) => [x, y, 24]);
const r = raceTime(path, t);
assert.deepEqual([r.start, r.stop, r.frames, r.ms], [1, 7, 6, 48]);
assert.deepEqual(r.splits, [32]);   // checkpoint at frame 5: 4 frames after the start
assert.equal(formatMs(65432), '1:05.432');
assert.equal(raceTime(path.slice(0, 5), t).ms, null, 'running: no stop yet');
// Staying in it restarts the timer once its wait is over: 0.5 s = 62.5 frames, so frame 63
const linger = [...Array(70).fill([0, 204, 24]), [0, 300, 24], [1950, 0, 24]];
assert.equal(raceTime(linger, t).start, 63);
// The wait key, default 0.5 s
const waited = findTimerTriggers({ ...bsp, entities: bsp.entities.map(e => e.properties.model === '*1' ? { properties: { ...e.properties, wait: '2' } } : e) });
assert.deepEqual([t.start[0].wait, waited.start[0].wait], [0.5, 2]);
console.log('ok triggers, touch, race time, splits, trigger wait');

// Optimizer: no waypoints, finish in the stop trigger, ranked by race time
const stop = { mins: [1980, -100, 0], maxs: [2020, 100, 200] };
const startBox = { mins: [-200, -200, 0], maxs: [200, 200, 200] };   // around the spawn: restarts the timer every 0.5 s in it
const route = await new WaypointOptimizer(flatFloorQ3())
    .optimizeRoute([], null, { origin: [0, 0, 24] }, { start: [startBox], checkpoints: [], stop: [stop], finish: true });
assert.equal(route.finish, true);
assert.equal(route.reached, 1);
assert.ok(touches(stop, route.replay.positions.at(-1)), 'ends touching the stop trigger');
assert.ok(route.race && route.race.ms > 0 && route.race.frames < route.inputs.length, 'race time excludes the start trigger frames');
console.log(`ok optimizer to the stop trigger: ${route.inputs.length} frames, race ${formatMs(route.race.ms)} (${route.race.frames} frames after the timer started)`);
