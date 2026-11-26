// Self-check for the .dm_68 reader against a DeFRaG demo whose name carries its time
// (…[df.cpm]00.14.744(player).dm_68). Run: node tests/dm68.check.mjs <file.dm_68>, or with no
// argument it takes the first .dm_68 in docs/. Demos aren't in git, so without one it skips.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parseDemo, demoFrames } from '../Q3BeamSearch/wwwroot/js/dm68.js';
import { analyseRun, summarise } from '../Q3BeamSearch/wwwroot/js/run-analysis.js';

const docs = new URL('../docs/', import.meta.url);
const file = process.argv[2] ?? (existsSync(docs) && readdirSync(docs).find(n => n.endsWith('.dm_68')) ? new URL(readdirSync(docs).find(n => n.endsWith('.dm_68')), docs) : null);
if (!file || !existsSync(file)) {
    console.log('skip: no .dm_68 demo (pass one, or put one in docs/)');
    process.exit(0);
}

const demo = parseDemo(readFileSync(file));
assert.equal(demo.info.protocol, '68');
assert.ok(demo.info.mapname, 'server info has the map');
const frames = demoFrames(demo);
assert.ok(frames.length > 100, `only ${frames.length} frames`);

// DeFRaG's own timer (ps.stats[8]) ends on the time in the file name
const named = String(file).match(/(\d+)\.(\d\d)\.(\d{3})/);
const end = frames.at(-1).timerMs;
if (named) assert.equal(end, (+named[1] * 60 + +named[2]) * 1000 + +named[3], `timer ends at ${end} ms`);

// The one-frame Pmove reproduces most frames from the recorded velocity, keys and yaw only if
// all three were read right (and the physics is the demo's)
const cpm = demo.info.df_promode === '1';
const s = summarise(analyseRun(frames, cpm));
assert.ok(s.modelled > 0.9, `${(s.modelled * 100).toFixed(1)}% of frames reproduced in ${cpm ? 'CPM' : 'VQ3'}`);
console.log(`ok ${demo.info.mapname}: ${frames.length} frames, ${cpm ? 'CPM' : 'VQ3'}, timer ${end} ms, ` +
    `${(s.modelled * 100).toFixed(1)}% reproduced, strafe efficiency ${s.efficiency.toFixed(1)}%`);
