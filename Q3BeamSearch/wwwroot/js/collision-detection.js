const SURFACE_CLIP_EPSILON = 0.125;
const CONTENTS_SOLID = 0x1;

const ZERO_VEC = [0, 0, 0];

function vecFrom(input) {
    if (!input) return [...ZERO_VEC];
    if (Array.isArray(input)) {
        return [input[0] ?? 0, input[1] ?? 0, input[2] ?? 0];
    }
    return [input.x ?? 0, input.y ?? 0, input.z ?? 0];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function lerpVec(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
    ];
}

export const PLAYER_PHYSICS_BOUNDS = {
    mins: [-15, -15, -24],
    maxs: [15, 15, 32]
};

export class BSPCollisionSystem {
    constructor() {
        this.reset();
    }

    reset() {
        this.bsp = null;
        this.enabled = false;
        this.traceStamp = 1;
    }

    loadFromBSP(bsp) {
        const hasData = bsp && bsp.nodes && bsp.planes && bsp.leafs && bsp.leafBrushes && bsp.brushes && bsp.brushSides;
        if (!hasData) {
            this.reset();
            return false;
        }
        this.bsp = bsp;
        this.enabled = true;
        this.traceStamp = 1;
        if (Array.isArray(this.bsp.brushes)) {
            this.bsp.brushes.forEach(brush => {
                brush._lastTraceId = 0;
            });
        }
        return true;
    }

    isReady() {
        return this.enabled && !!this.bsp;
    }

    traceBox(startInput, endInput, minsInput, maxsInput, options = {}) {
        if (!this.isReady()) {
            return this._emptyTrace(startInput);
        }
        const start = vecFrom(startInput);
        const end = vecFrom(endInput);
        const mins = vecFrom(minsInput);
        const maxs = vecFrom(maxsInput);
        const tw = this._prepareTrace(start, end, mins, maxs, options);
        this._traceThroughTree(tw, 0, 0, 1, tw.start, tw.end);
        const hitPoint = [
            tw.start[0] + (tw.end[0] - tw.start[0]) * tw.trace.fraction,
            tw.start[1] + (tw.end[1] - tw.start[1]) * tw.trace.fraction,
            tw.start[2] + (tw.end[2] - tw.start[2]) * tw.trace.fraction
        ];
        return {
            hit: tw.trace.fraction < 1 || tw.trace.startSolid,
            fraction: tw.trace.fraction,
            startSolid: tw.trace.startSolid,
            allSolid: tw.trace.allSolid,
            plane: tw.trace.plane ? { normal: [...tw.trace.plane.normal], dist: tw.trace.plane.dist } : null,
            contents: tw.trace.contents ?? 0,
            surfaceFlags: tw.trace.surfaceFlags ?? 0,
            endPos: { x: hitPoint[0], y: hitPoint[1], z: hitPoint[2] }
        };
    }

    _emptyTrace(startInput) {
        const pos = vecFrom(startInput);
        return {
            hit: false,
            fraction: 1,
            startSolid: false,
            allSolid: false,
            plane: null,
            contents: 0,
            surfaceFlags: 0,
            endPos: { x: pos[0], y: pos[1], z: pos[2] }
        };
    }

    _prepareTrace(start, end, mins, maxs, options) {
        const tw = {
            start,
            end,
            mins,
            maxs,
            extents: [0, 0, 0],
            offsets: new Array(8).fill(0).map(() => [0, 0, 0]),
            bounds: [
                [0, 0, 0],
                [0, 0, 0]
            ],
            contentsMask: options.contents ?? CONTENTS_SOLID,
            trace: {
                fraction: 1,
                startSolid: false,
                allSolid: false,
                plane: null,
                contents: 0,
                surfaceFlags: 0
            },
            isPoint: false,
            stamp: this.traceStamp++
        };

        for (let i = 0; i < 3; i++) {
            if (mins[i] >= 0) tw.extents[i] = maxs[i];
            else if (maxs[i] <= 0) tw.extents[i] = -mins[i];
            else tw.extents[i] = Math.max(-mins[i], maxs[i]);
        }
        tw.isPoint = tw.extents[0] === 0 && tw.extents[1] === 0 && tw.extents[2] === 0;
        this._buildBoxOffsets(tw);
        this._buildBounds(tw);
        return tw;
    }

    _buildBoxOffsets(tw) {
        const { mins, maxs } = tw;
        tw.offsets[0] = [mins[0], mins[1], mins[2]];
        tw.offsets[1] = [maxs[0], mins[1], mins[2]];
        tw.offsets[2] = [mins[0], maxs[1], mins[2]];
        tw.offsets[3] = [maxs[0], maxs[1], mins[2]];
        tw.offsets[4] = [mins[0], mins[1], maxs[2]];
        tw.offsets[5] = [maxs[0], mins[1], maxs[2]];
        tw.offsets[6] = [mins[0], maxs[1], maxs[2]];
        tw.offsets[7] = [maxs[0], maxs[1], maxs[2]];
    }

    _buildBounds(tw) {
        for (let i = 0; i < 3; i++) {
            const startMin = tw.start[i] + tw.mins[i];
            const startMax = tw.start[i] + tw.maxs[i];
            const endMin = tw.end[i] + tw.mins[i];
            const endMax = tw.end[i] + tw.maxs[i];
            tw.bounds[0][i] = Math.min(startMin, startMax, endMin, endMax);
            tw.bounds[1][i] = Math.max(startMin, startMax, endMin, endMax);
        }
    }

    _traceThroughTree(tw, nodeIndex, p1f, p2f, p1, p2) {
        if (tw.trace.fraction <= p1f) {
            return;
        }
        if (nodeIndex < 0) {
            const leafIndex = -1 - nodeIndex;
            const leaf = this.bsp.leafs[leafIndex];
            if (leaf) {
                this._traceThroughLeaf(tw, leaf);
            }
            return;
        }
        const node = this.bsp.nodes[nodeIndex];
        if (!node) return;
        const plane = this.bsp.planes[node.plane];
        if (!plane) return;
        let t1, t2, offset;
        if (plane.type <= 2) {
            t1 = p1[plane.type] - plane.dist;
            t2 = p2[plane.type] - plane.dist;
            offset = tw.extents[plane.type];
        } else {
            t1 = dot(plane.normal, p1) - plane.dist;
            t2 = dot(plane.normal, p2) - plane.dist;
            offset = tw.isPoint ? 0 : 2048;
        }
        if (t1 >= offset + 1 && t2 >= offset + 1) {
            this._traceThroughTree(tw, node.children[0], p1f, p2f, p1, p2);
            return;
        }
        if (t1 <= -offset - 1 && t2 <= -offset - 1) {
            this._traceThroughTree(tw, node.children[1], p1f, p2f, p1, p2);
            return;
        }
        let side;
        let frac;
        let frac2;
        let idist;
        if (t1 < t2) {
            side = 1;
            idist = 1.0 / (t1 - t2);
            frac2 = (t1 + offset + SURFACE_CLIP_EPSILON) * idist;
            frac = (t1 - offset + SURFACE_CLIP_EPSILON) * idist;
        } else if (t1 > t2) {
            side = 0;
            idist = 1.0 / (t1 - t2);
            frac2 = (t1 - offset - SURFACE_CLIP_EPSILON) * idist;
            frac = (t1 + offset + SURFACE_CLIP_EPSILON) * idist;
        } else {
            side = 0;
            frac = 1;
            frac2 = 0;
        }
        frac = clamp(frac, 0, 1);
        const midFrac = p1f + (p2f - p1f) * frac;
        const mid = lerpVec(p1, p2, frac);
        const frontChild = node.children[side];
        if (typeof frontChild === 'number') {
            this._traceThroughTree(tw, frontChild, p1f, midFrac, p1, mid);
        }
        frac2 = clamp(frac2, 0, 1);
        const midFrac2 = p1f + (p2f - p1f) * frac2;
        const mid2 = lerpVec(p1, p2, frac2);
        const backChild = node.children[side ^ 1];
        if (typeof backChild === 'number') {
            this._traceThroughTree(tw, backChild, midFrac2, p2f, mid2, p2);
        }
    }

    _traceThroughLeaf(tw, leaf) {
        const { firstLeafBrush, numLeafBrushes } = leaf;
        if (!numLeafBrushes || firstLeafBrush < 0) {
            return;
        }
        for (let i = 0; i < numLeafBrushes; i++) {
            const brushIndex = this.bsp.leafBrushes[firstLeafBrush + i];
            if (brushIndex === undefined) continue;
            const brush = this.bsp.brushes[brushIndex];
            if (!brush || !brush.numSides) continue;
            if (!(brush.contents & tw.contentsMask)) continue;
            if (brush._lastTraceId === tw.stamp) continue;
            brush._lastTraceId = tw.stamp;
            this._traceThroughBrush(tw, brush);
            if (tw.trace.fraction === 0) return;
        }
    }

    _traceThroughBrush(tw, brush) {
        if (brush.firstSide < 0) {
            return;
        }
        let enterFrac = -Infinity;
        let leaveFrac = 1;
        let clipPlane = null;
        let clipSurfaceFlags = 0;
        let startOut = false;
        let getOut = false;
        for (let i = 0; i < brush.numSides; i++) {
            const side = this.bsp.brushSides[brush.firstSide + i];
            if (!side) continue;
            const plane = this.bsp.planes[side.planeIndex];
            if (!plane) continue;
            const offsetVec = tw.offsets[plane.signBits ?? 0];
            const dist = plane.dist - dot(offsetVec, plane.normal);
            const d1 = dot(tw.start, plane.normal) - dist;
            const d2 = dot(tw.end, plane.normal) - dist;
            if (d2 > 0) getOut = true;
            if (d1 > 0) startOut = true;
            if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) {
                return;
            }
            if (d1 <= 0 && d2 <= 0) {
                continue;
            }
            if (d1 > d2) {
                let frac = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2);
                if (frac < 0) frac = 0;
                if (frac > enterFrac) {
                    enterFrac = frac;
                    clipPlane = plane;
                    clipSurfaceFlags = side.surfaceFlags;
                }
            } else {
                let frac = (d1 + SURFACE_CLIP_EPSILON) / (d1 - d2);
                if (frac > 1) frac = 1;
                if (frac < leaveFrac) {
                    leaveFrac = frac;
                }
            }
        }
        if (!startOut) {
            tw.trace.startSolid = true;
            if (!getOut) {
                tw.trace.allSolid = true;
                tw.trace.fraction = 0;
                tw.trace.contents = brush.contents;
            }
            return;
        }
        if (enterFrac < leaveFrac) {
            if (enterFrac > -1 && enterFrac < tw.trace.fraction) {
                if (enterFrac < 0) {
                    enterFrac = 0;
                }
                tw.trace.fraction = enterFrac;
                if (clipPlane) {
                    tw.trace.plane = clipPlane;
                }
                tw.trace.surfaceFlags = clipSurfaceFlags;
                tw.trace.contents = brush.contents;
            }
        }
    }
}
