// wwwroot/js/bsp-loader.js
// BSP loader (same proven parser from v1, cleaned up).
// Self-contained: no shared viewer state — only THREE, JSZip and the TGA decoder.

import * as THREE from 'three';
import JSZip from 'jszip';
import { decodeTGA, imageDataToCanvas } from './tga-decoder.js';

export const bspLoader = {
    async loadMapFromFile(file) {
        const fn = file.name.toLowerCase();
        if (fn.endsWith('.pk3')) return this.loadPK3(file);
        if (fn.endsWith('.bsp')) return this.loadBSP(file);
        throw new Error('Unsupported format — need .bsp or .pk3');
    },

    async loadPK3(file) {
        const zip = await JSZip.loadAsync(file);
        let bspEntry = null;
        zip.forEach((path, entry) => {
            if (!bspEntry && path.toLowerCase().startsWith('maps/') && path.toLowerCase().endsWith('.bsp'))
                bspEntry = entry;
        });
        if (!bspEntry) throw new Error('No .bsp found inside PK3');
        const buf = await bspEntry.async('arraybuffer');
        const bsp = this.parseBSP(buf);
        const textures = await this.loadTexturesFromPK3(zip);

        // Prefer the worldspawn 'sky' key — it gives the exact env-map base name
        // (e.g. "ominous6") rather than the shader path (e.g. "textures/skies/ominous6").
        const worldspawn = bsp.entities?.find(e => e.properties?.classname === 'worldspawn');
        const wsSky = worldspawn?.properties?.sky ?? null;
        const skyBspEntry = bsp.textures.find(t => t.isSky);
        const skySearchName = wsSky ?? skyBspEntry?.name ?? null;
        console.log(`[skybox] worldspawn sky='${wsSky}', BSP sky entry='${skyBspEntry?.name}'`);
        const skyTexture = skySearchName ? await this.loadSkyboxFromPK3(zip, skySearchName) : null;
        // rawBsp: the untouched .bsp bytes, forwarded to the WASM collision model.
        return { type: 'pk3', bsp, textures, skyTexture, rawBsp: buf };
    },

    async loadBSP(file) {
        const buf = await file.arrayBuffer();
        // rawBsp: the untouched .bsp bytes, forwarded to the WASM collision model.
        return { type: 'bsp', bsp: this.parseBSP(buf), textures: new Map(), rawBsp: buf };
    },

    async loadTexturesFromPK3(zip) {
        const textures = new Map();
        const promises = [];
        zip.forEach((path, entry) => {
            const lower = path.toLowerCase();
            const isTGA = lower.endsWith('.tga');
            if (lower.startsWith('textures/') && /\.(jpg|jpeg|png|tga)$/i.test(lower)) {
                // Key by full path without extension so textures/a/wall1 and textures/b/wall1 don't collide.
                const name = lower.replace(/\.[^.]+$/, '');
                const p = isTGA
                    ? entry.async('arraybuffer').then(buf => {
                        const imgData = decodeTGA(buf);
                        if (!imgData) return;
                        const t = new THREE.CanvasTexture(imageDataToCanvas(imgData));
                        t.wrapS = t.wrapT = THREE.RepeatWrapping;
                        textures.set(name, t);
                    }).catch(() => {})
                    : entry.async('blob').then(blob => new Promise(res => {
                        const url = URL.createObjectURL(blob);
                        const img = new Image();
                        img.onload = () => {
                            const t = new THREE.Texture(img);
                            t.needsUpdate = true;
                            t.wrapS = t.wrapT = THREE.RepeatWrapping;
                            textures.set(name, t);
                            res();
                        };
                        img.onerror = () => { URL.revokeObjectURL(url); res(); };
                        img.src = url;
                    })).catch(() => {});
                promises.push(p);
            }
        });
        await Promise.all(promises);
        return textures;
    },

    // Loads the 6 sky cube-map faces from a PK3 zip.
    // skyTextureName may be the worldspawn 'sky' value (e.g. "ominous6") or a BSP
    // shader path (e.g. "textures/skies/ominous6") — the basename is extracted either way.
    // Search order:
    //   1. Known path patterns (env/<n>/<n><face>, flat env/, textures/skies/, …)
    //   2. Full zip scan — finds any file whose basename matches <skyname><face> or <skyname>_<face>,
    //      regardless of directory. Catches non-standard custom map layouts.
    async loadSkyboxFromPK3(zip, skyTextureName) {
        const baseName = skyTextureName.split('/').pop().toLowerCase().replace(/\s+/g, '');
        const faces    = ['rt', 'lf', 'up', 'dn', 'bk', 'ft'];
        const exts     = ['.tga', '.jpg', '.jpeg', '.png'];
        const lookup   = new Map();
        zip.forEach((p, e) => lookup.set(p.toLowerCase(), e));

        console.log(`[skybox] searching for sky='${baseName}' in ${lookup.size} zip entries`);

        // Helper: decode an entry to a drawable element (canvas or img)
        const entryToCanvas = async (entry, ext) => {
            const buf = await entry.async('arraybuffer');
            if (ext === '.tga') {
                const id = decodeTGA(buf);
                return id ? imageDataToCanvas(id) : null;
            }
            const url = URL.createObjectURL(new Blob([buf]));
            const el = await new Promise(res => {
                const img = new Image();
                img.onload  = () => res(img);
                img.onerror = () => res(null);
                img.src = url;
            });
            URL.revokeObjectURL(url);
            return el;
        };

        const canvases = [];
        for (const face of faces) {
            let canvas = null;

            // ── Strategy 1: known path patterns (fast) ────────────────
            const candidates = [
                `env/${baseName}/${baseName}${face}`,
                `env/${baseName}/${baseName}_${face}`,
                `env/${baseName}${face}`,
                `env/${baseName}_${face}`,
                `textures/skies/${baseName}${face}`,
                `textures/skies/${baseName}_${face}`,
                `textures/${baseName}${face}`,
                `textures/${baseName}_${face}`,
            ];
            outer: for (const prefix of candidates) {
                for (const ext of exts) {
                    const entry = lookup.get(prefix + ext);
                    if (!entry) continue;
                    try {
                        canvas = await entryToCanvas(entry, ext);
                        if (canvas) { console.log(`[skybox] ${face} → ${prefix}${ext}`); break outer; }
                    } catch { /* try next */ }
                }
            }

            // ── Strategy 2: full-zip filename scan (catches any layout) ───
            if (!canvas) {
                for (const [p, entry] of lookup) {
                    const ext = exts.find(e => p.endsWith(e));
                    if (!ext) continue;
                    const stem = p.slice(0, -ext.length).split('/').pop();
                    if (stem === `${baseName}${face}` || stem === `${baseName}_${face}`) {
                        try {
                            canvas = await entryToCanvas(entry, ext);
                            if (canvas) { console.log(`[skybox] ${face} via scan → ${p}`); break; }
                        } catch { /* try next */ }
                    }
                }
            }

            canvases.push(canvas);
        }

        const found = canvases.filter(Boolean).length;
        console.log(`[skybox] ${found}/6 faces found for '${baseName}'`);
        if (found < 4) return null;

        // Fill any missing face with a plain sky-blue canvas
        const first = canvases.find(Boolean);
        const sz = first ? (first.naturalWidth || first.width || 256) : 256;
        for (let i = 0; i < 6; i++) {
            if (!canvases[i]) {
                const c = document.createElement('canvas'); c.width = c.height = sz;
                c.getContext('2d').fillStyle = '#87CEEB';
                c.getContext('2d').fillRect(0, 0, sz, sz);
                canvases[i] = c;
            }
        }
        const ct = new THREE.CubeTexture(canvases);
        ct.colorSpace = THREE.SRGBColorSpace;
        ct.needsUpdate = true;
        return ct;
    },

    // ── BSP binary parser ──────────────────────────────────────────────
    parseBSP(buf) {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x50534249) throw new Error('Invalid BSP magic');
        const lumps = [];
        for (let i = 0; i < 17; i++) lumps.push({ offset: dv.getUint32(8 + i*8, true), length: dv.getUint32(12 + i*8, true) });

        const textures   = this._parseTextures(buf, lumps[1]);
        const vertices   = this._parseVertices(buf, lumps[10]);
        const faces      = this._parseFaces(buf, lumps[13]);
        const meshVerts  = this._parseMeshVerts(buf, lumps[11]);
        const entities   = this._parseEntities(buf, lumps[0]);
        const planes     = this._parsePlanes(buf, lumps[2]);
        const nodes      = this._parseNodes(buf, lumps[3]);
        const leafs      = this._parseLeafs(buf, lumps[4]);
        const leafBrushes= this._parseLeafBrushes(buf, lumps[6]);
        const models     = this._parseModels(buf, lumps[7]);
        const brushes    = this._parseBrushes(buf, lumps[8], textures);
        const brushSides = this._parseBrushSides(buf, lumps[9], textures);
        return { vertices, faces, meshVerts, textures, entities, planes, nodes, leafs, leafBrushes, models, brushes, brushSides, lumps };
    },

    _parseTextures(buf, l) {
        const list = [], dv = new DataView(buf, l.offset, l.length), n = l.length / 72;
        for (let i = 0; i < n; i++) {
            const o = i * 72;
            const bytes = new Uint8Array(buf, l.offset + o, 64);
            let name = ''; for (let j = 0; j < 64 && bytes[j]; j++) name += String.fromCharCode(bytes[j]);
            const lower = name.toLowerCase();
            // Mirror Python export_textures.py classification rules
            const isInvisible = ['clip','trigger','hint','caulk'].some(k => lower.includes(k));
            const bspFlags = dv.getUint32(o+64,true);
            // SURF_SKY = 0x4 is the canonical Q3 surface flag; name check catches edge cases
            const isSky = (bspFlags & 0x4) !== 0 || lower.includes('sky') || lower.includes('skies/');
            list.push({ name, flags: bspFlags, contents: dv.getUint32(o+68,true), isInvisible, isSky });
        }
        return list;
    },
    _parseVertices(buf, l) {
        const out = [], dv = new DataView(buf, l.offset, l.length), n = l.length / 44;
        for (let i = 0; i < n; i++) {
            const o = i * 44;
            out.push({
                position: [dv.getFloat32(o,true), dv.getFloat32(o+4,true), dv.getFloat32(o+8,true)],
                texCoord: [dv.getFloat32(o+12,true), dv.getFloat32(o+16,true)],
                normal:   [dv.getFloat32(o+28,true), dv.getFloat32(o+32,true), dv.getFloat32(o+36,true)],
                color:    [dv.getUint8(o+40), dv.getUint8(o+41), dv.getUint8(o+42), dv.getUint8(o+43)]
            });
        }
        return out;
    },
    _parseFaces(buf, l) {
        const out = [], dv = new DataView(buf, l.offset, l.length), n = l.length / 104;
        for (let i = 0; i < n; i++) {
            const o = i * 104;
            out.push({ texture: dv.getInt32(o,true), type: dv.getInt32(o+8,true),
                vertex: dv.getInt32(o+12,true), numVerts: dv.getInt32(o+16,true),
                meshVert: dv.getInt32(o+20,true), numMeshVerts: dv.getInt32(o+24,true) });
        }
        return out;
    },
    _parseMeshVerts(buf, l) {
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 4; i++) out.push(dv.getInt32(i*4,true));
        return out;
    },
    _parseEntities(buf, l) {
        if (!l.length) return [];
        const str = new TextDecoder().decode(new Uint8Array(buf, l.offset, l.length));
        const entities = []; let cur = null, depth = 0;
        for (let ln of str.split('\n')) {
            ln = ln.trim(); if (!ln || ln.startsWith('//')) continue;
            if (ln === '{' ) { depth++; if (depth === 1) cur = { properties: {} }; }
            else if (ln === '}') { depth--; if (depth === 0 && cur) { entities.push(cur); cur = null; } }
            else if (cur && depth === 1) { const m = ln.match(/^"([^"]+)"\s+"([^"]*)"$/); if (m) cur.properties[m[1]] = m[2]; }
        }
        return entities;
    },
    _parsePlanes(buf, l) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 16; i++) {
            const o = i*16;
            const normal = [dv.getFloat32(o,true), dv.getFloat32(o+4,true), dv.getFloat32(o+8,true)];
            const dist = dv.getFloat32(o+12,true);
            const type = (Math.abs(Math.abs(normal[0])-1)<1e-4 && Math.abs(normal[1])<1e-4 && Math.abs(normal[2])<1e-4) ? 0 :
                         (Math.abs(Math.abs(normal[1])-1)<1e-4 && Math.abs(normal[0])<1e-4 && Math.abs(normal[2])<1e-4) ? 1 :
                         (Math.abs(Math.abs(normal[2])-1)<1e-4 && Math.abs(normal[0])<1e-4 && Math.abs(normal[1])<1e-4) ? 2 : 3;
            const signBits = (normal[0]<0?1:0)|(normal[1]<0?2:0)|(normal[2]<0?4:0);
            out.push({ normal, dist, type, signBits });
        }
        return out;
    },
    _parseNodes(buf, l) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 36; i++) {
            const o = i*36;
            out.push({ plane: dv.getInt32(o,true), children: [dv.getInt32(o+4,true), dv.getInt32(o+8,true)],
                mins: [dv.getInt32(o+12,true), dv.getInt32(o+16,true), dv.getInt32(o+20,true)],
                maxs: [dv.getInt32(o+24,true), dv.getInt32(o+28,true), dv.getInt32(o+32,true)] });
        }
        return out;
    },
    _parseLeafs(buf, l) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 48; i++) {
            const o = i*48;
            out.push({ cluster: dv.getInt32(o,true), area: dv.getInt32(o+4,true),
                mins: [dv.getInt32(o+8,true), dv.getInt32(o+12,true), dv.getInt32(o+16,true)],
                maxs: [dv.getInt32(o+20,true), dv.getInt32(o+24,true), dv.getInt32(o+28,true)],
                firstLeafSurface: dv.getInt32(o+32,true), numLeafSurfaces: dv.getInt32(o+36,true),
                firstLeafBrush: dv.getInt32(o+40,true), numLeafBrushes: dv.getInt32(o+44,true) });
        }
        return out;
    },
    _parseLeafBrushes(buf, l) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length/4; i++) out.push(dv.getInt32(i*4,true));
        return out;
    },
    _parseModels(buf, l) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 40; i++) {
            const o = i*40;
            out.push({
                mins: [dv.getFloat32(o,true), dv.getFloat32(o+4,true), dv.getFloat32(o+8,true)],
                maxs: [dv.getFloat32(o+12,true), dv.getFloat32(o+16,true), dv.getFloat32(o+20,true)],
                firstSurface: dv.getInt32(o+24,true), numSurfaces: dv.getInt32(o+28,true),
                firstBrush: dv.getInt32(o+32,true), numBrushes: dv.getInt32(o+36,true) });
        }
        return out;
    },
    _parseBrushes(buf, l, textures) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 12; i++) {
            const o = i*12, ti = dv.getInt32(o+8,true), sh = textures[ti] || { contents:0, flags:0 };
            out.push({ firstSide: dv.getInt32(o,true), numSides: dv.getInt32(o+4,true), textureIndex: ti,
                contents: sh.contents ?? 0, surfaceFlags: sh.flags ?? 0, _lastTraceId: 0 });
        }
        return out;
    },
    _parseBrushSides(buf, l, textures) {
        if (!l.length) return [];
        const out = [], dv = new DataView(buf, l.offset, l.length);
        for (let i = 0; i < l.length / 8; i++) {
            const o = i*8, ti = dv.getInt32(o+4,true), sh = textures[ti] || { contents:0, flags:0 };
            out.push({ planeIndex: dv.getInt32(o,true), textureIndex: ti, surfaceFlags: sh.flags ?? 0, contents: sh.contents ?? 0 });
        }
        return out;
    },

    // ── Geometry builder ───────────────────────────────────────────────
    // Builds a THREE.Group with one Mesh per texture bucket.
    // Invisible surfaces (clip/trigger/hint/caulk) are skipped.
    // Sky surfaces are added but hidden; use userData.isSky to manage them.
    // Ported from python/parse_bsp_to_json.py + html/test-map-viewer.html logic.
    buildMapGroup(mapData, wireframe = false) {
        const group = new THREE.Group();
        group.name = 'BSP_Map';

        // Build texIndex → THREE.Texture lookup from PK3-extracted textures.
        // Match by full BSP texture path (lowercased, no extension) to avoid basename collisions.
        const texByIndex = new Map();
        for (let i = 0; i < mapData.bsp.textures.length; i++) {
            const bspTexName = mapData.bsp.textures[i].name.toLowerCase();
            const tex = mapData.textures.get(bspTexName);
            if (tex) texByIndex.set(i, tex);
        }

        // Group faces by texture index, skipping invisible surfaces
        const facesByTex = new Map();
        for (const face of mapData.bsp.faces) {
            if (face.type !== 1 && face.type !== 3) continue;
            const bspTex = mapData.bsp.textures[face.texture];
            if (bspTex?.isInvisible) continue;
            if (!facesByTex.has(face.texture)) facesByTex.set(face.texture, []);
            facesByTex.get(face.texture).push(face);
        }

        for (const [tidx, faces] of facesByTex) {
            const bspTex = mapData.bsp.textures[tidx];
            const isSky = bspTex?.isSky ?? false;
            const pos = [], norm = [], uv = [], col = [];

            for (const face of faces) {
                for (let i = 0; i < face.numMeshVerts; i += 3) {
                    const verts = [];
                    for (let j = 0; j < 3; j++) {
                        const mvIdx = face.meshVert + i + j;
                        if (mvIdx >= mapData.bsp.meshVerts.length) continue;
                        const v = mapData.bsp.vertices[face.vertex + mapData.bsp.meshVerts[mvIdx]];
                        if (v) verts.push(v);
                    }
                    if (verts.length !== 3) continue;

                    // Compute per-triangle surface normal (Q3 space → Three.js)
                    const p0 = verts[0].position, p1 = verts[1].position, p2 = verts[2].position;
                    const e1x = p1[0]-p0[0], e1y = p1[1]-p0[1], e1z = p1[2]-p0[2];
                    const e2x = p2[0]-p0[0], e2y = p2[1]-p0[1], e2z = p2[2]-p0[2];
                    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
                    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
                    nx /= nl; ny /= nl; nz /= nl;
                    // Q3→Three.js coord transform: (X, Z, -Y)
                    const tnx = nx, tny = nz, tnz = -ny;

                    for (const v of verts) {
                        pos.push(v.position[0], v.position[2], -v.position[1]);
                        norm.push(tnx, tny, tnz);
                        uv.push(v.texCoord[0], v.texCoord[1]);
                        col.push(v.color[0]/255, v.color[1]/255, v.color[2]/255);
                    }
                }
            }

            if (pos.length === 0) continue;

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geom.setAttribute('normal',   new THREE.Float32BufferAttribute(norm, 3));
            geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
            geom.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));

            let mat;
            if (wireframe) {
                mat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true, transparent: true, opacity: 0.4 });
            } else if (isSky) {
                mat = new THREE.MeshBasicMaterial({
                    color: 0x87CEEB,
                    side: THREE.BackSide,
                    depthWrite: false
                });
            } else if (texByIndex.has(tidx)) {
                // Q3 is pre-lit — use unlit material so the baked texture colours are not
                // darkened/washed by Three.js scene lights.
                mat = new THREE.MeshBasicMaterial({ map: texByIndex.get(tidx), side: THREE.DoubleSide });
            } else {
                // No texture found; neutral grey so geometry stays visible.
                mat = new THREE.MeshBasicMaterial({ color: 0x888888, side: THREE.DoubleSide });
            }

            const mesh = new THREE.Mesh(geom, mat);
            mesh.userData = { texIndex: tidx, isSky, textureName: bspTex?.name ?? '' };
            // Sky faces are opaque placeholders in the BSP; the actual sky is rendered via
            // scene.background (cube map or flat colour). Hide the geometry so it doesn't
            // block the background with a solid cyan surface.
            if (isSky) mesh.visible = false;
            group.add(mesh);
        }

        return group;
    },

    // Legacy single-geometry builder kept for compatibility; prefer buildMapGroup.
    createGeometry(mapData) {
        const geom = new THREE.BufferGeometry();
        const pos = [], norm = [], uv = [], col = [];
        for (const face of mapData.bsp.faces) {
            if (face.type !== 1 && face.type !== 3) continue;
            for (let i = 0; i < face.numMeshVerts; i += 3) {
                for (let j = 0; j < 3; j++) {
                    const mv = face.meshVert + i + j;
                    if (mv >= mapData.bsp.meshVerts.length) continue;
                    const v = mapData.bsp.vertices[face.vertex + mapData.bsp.meshVerts[mv]];
                    if (!v) continue;
                    pos.push(v.position[0], v.position[2], -v.position[1]);
                    norm.push(v.normal[0], v.normal[2], -v.normal[1]);
                    uv.push(...v.texCoord);
                    col.push(v.color[0]/255, v.color[1]/255, v.color[2]/255);
                }
            }
        }
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geom.computeBoundingBox();
        return geom;
    },

    createMaterial(mapData, wireframe = false) {
        if (mapData.textures?.size > 0) {
            const first = mapData.textures.values().next().value;
            return new THREE.MeshLambertMaterial({ map: first, transparent: true, opacity: wireframe ? 0.3 : 0.8, wireframe, side: THREE.DoubleSide });
        }
        return new THREE.MeshLambertMaterial({ vertexColors: true, wireframe, transparent: true, opacity: wireframe ? 0.5 : 0.7, side: THREE.DoubleSide });
    },

    parseOrigin(o) { if (!o) return [0,0,0]; const a = o.split(' ').map(parseFloat); return a.length >= 3 ? a : [0,0,0]; },
    parseAngle(a) { return a ? parseFloat(a) * Math.PI / 180 : 0; }
};
