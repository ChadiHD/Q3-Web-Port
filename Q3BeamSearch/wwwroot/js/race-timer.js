// wwwroot/js/race-timer.js
// DeFRaG's race timer. Trigger brushes (trigger_multiple, ...) whose target is a
// target_startTimer / target_checkpoint / target_stopTimer. The game touches triggers after
// every usercmd's Pmove (G_TouchTriggers: the player box against the trigger brush, the box
// grown by 1 unit like SV_LinkEntity's absmin/absmax). Touching a start trigger restarts the
// timer, so it runs from the last frame in the start trigger to the first frame touching a stop
// trigger: (stop - start) × 8 ms.
// Assumes box-shaped trigger brushes (their model bounds) and timer triggers that retrigger
// every frame.

const PLAYER_MINS = [-15, -15, -24], PLAYER_MAXS = [15, 15, 32];   // standing (crouched maxs z is 16)
export const FRAME_MS = 8;

// {start, checkpoints, stop}: arrays of {mins, maxs} boxes (Q3 coords), from the BSP's entities
// and brush models (bsp-loader.js parseBSP output).
export function findTimerTriggers(bsp) {
    const ents = bsp?.entities ?? [];
    const byName = new Map(ents.filter(e => e.properties.targetname).map(e => [e.properties.targetname, e.properties.classname]));
    const out = { start: [], checkpoints: [], stop: [] };
    for (const e of ents) {
        const { classname = '', target, model } = e.properties;
        if (!classname.startsWith('trigger_') || !target || !model?.startsWith('*')) continue;
        const m = bsp.models?.[parseInt(model.slice(1), 10)];
        if (!m) continue;
        const box = { mins: [...m.mins], maxs: [...m.maxs] };
        const kind = byName.get(target);
        if (kind === 'target_startTimer') out.start.push(box);
        else if (kind === 'target_stopTimer') out.stop.push(box);
        else if (kind === 'target_checkpoint') out.checkpoints.push(box);
    }
    return out;
}

// Does the player at origin pos ({x, y, z} or [x, y, z], Q3) touch box?
export function touches(box, pos) {
    const o = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    for (let k = 0; k < 3; k++)
        if (o[k] + PLAYER_MINS[k] - 1 > box.maxs[k] || o[k] + PLAYER_MAXS[k] + 1 < box.mins[k]) return false;
    return true;
}

export const boxCenter = box => box.mins.map((v, k) => (v + box.maxs[k]) / 2);

// The race over a run's positions (Q3, one per usercmd): {start, stop, frames, ms, splits: [ms]}
// with start = the last frame in a start trigger before the stop, stop = the first stop-trigger
// frame after it, splits = time at each checkpoint first touched in between. Without a start
// trigger the timer runs from frame 0 (frames before it = -1). stop is null while still running.
export function raceTime(positions, triggers) {
    const { start: starts = [], stop: stops = [], checkpoints = [] } = triggers ?? {};
    if (!starts.length && !stops.length) return null;
    let start = starts.length ? null : -1, stop = null;
    for (let i = 0; i < positions.length && stop === null; i++) {
        if (starts.some(b => touches(b, positions[i]))) start = i;
        else if (start !== null && stops.some(b => touches(b, positions[i]))) stop = i;
    }
    if (start === null) return null;
    const splits = [], passed = new Set();
    for (let i = start + 1; i < (stop ?? positions.length); i++)
        checkpoints.forEach((b, k) => {
            if (!passed.has(k) && touches(b, positions[i])) { passed.add(k); splits.push((i - start) * FRAME_MS); }
        });
    const frames = stop === null ? null : stop - start;
    return { start, stop, frames, ms: frames === null ? null : frames * FRAME_MS, splits };
}

export const formatMs = ms => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
