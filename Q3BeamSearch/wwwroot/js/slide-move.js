// wwwroot/js/slide-move.js
// Q3-style slide movement: when hitting a wall, clip the remaining velocity
// against the surface normal and continue moving.
// Pure helpers — the collision system and player bounds are passed in.

export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Clip a velocity vector against a plane normal (Q3 PM_ClipVelocity)
export function clipVelocity(vel, normal, overbounce) {
    const backoff = dot3(vel, normal) * overbounce;
    const out = [
        vel[0] - normal[0] * backoff,
        vel[1] - normal[1] * backoff,
        vel[2] - normal[2] * backoff
    ];
    // Tiny residual correction
    for (let i = 0; i < 3; i++) {
        if (Math.abs(out[i]) < 1e-6) out[i] = 0;
    }
    return out;
}

// Perform a slide-move from start along moveVec, bouncing off up to 4 planes.
// collisionSystem must expose traceBox(start, end, mins, maxs); bounds is
// { mins, maxs } for the player's physics box.
export function slideMove(start, moveVec, collisionSystem, bounds) {
    const MAX_CLIP_PLANES = 4;
    let pos = [...start];
    let remaining = [...moveVec];
    const planes = [];

    for (let bump = 0; bump < MAX_CLIP_PLANES; bump++) {
        const end = [pos[0] + remaining[0], pos[1] + remaining[1], pos[2] + remaining[2]];

        const trace = collisionSystem.traceBox(
            pos, end,
            bounds.mins,
            bounds.maxs
        );

        if (trace.fraction > 0) {
            pos = [trace.endPos.x, trace.endPos.y, trace.endPos.z];
        }

        // No collision — full movement completed
        if (trace.fraction >= 1.0) break;

        // Started inside solid — nudge out slightly and stop
        if (trace.startSolid || trace.allSolid) break;

        // Reduce remaining movement by fraction used
        const usedFrac = trace.fraction;
        remaining = [
            remaining[0] * (1 - usedFrac),
            remaining[1] * (1 - usedFrac),
            remaining[2] * (1 - usedFrac)
        ];

        // Clip remaining movement against the hit plane
        const normal = trace.plane.normal;
        planes.push(normal);
        remaining = clipVelocity(remaining, normal, 1.001);

        // If clipped into a previous plane, try to slide along the crease
        let blocked = false;
        for (let j = 0; j < planes.length - 1; j++) {
            if (dot3(remaining, planes[j]) < 0) {
                // Clip against that plane too
                remaining = clipVelocity(remaining, planes[j], 1.001);
                // If that pushes us back into the current plane, find crease direction
                if (dot3(remaining, normal) < 0) {
                    // Cross product of the two normals gives the crease direction
                    const crease = [
                        planes[j][1] * normal[2] - planes[j][2] * normal[1],
                        planes[j][2] * normal[0] - planes[j][0] * normal[2],
                        planes[j][0] * normal[1] - planes[j][1] * normal[0]
                    ];
                    const len = Math.sqrt(crease[0]*crease[0] + crease[1]*crease[1] + crease[2]*crease[2]);
                    if (len < 1e-6) {
                        // Stuck in a corner — stop
                        remaining = [0, 0, 0];
                        blocked = true;
                        break;
                    }
                    // Project remaining onto crease direction
                    const d = dot3(remaining, crease) / len;
                    remaining = [crease[0]/len * d, crease[1]/len * d, crease[2]/len * d];
                }
                break;
            }
        }
        if (blocked) break;

        // If remaining movement is negligible, stop
        const remLen = Math.sqrt(remaining[0]*remaining[0] + remaining[1]*remaining[1] + remaining[2]*remaining[2]);
        if (remLen < 0.01) break;
    }

    return { pos, onGround: false, hitPlane: planes.length > 0 ? planes[0] : null };
}
