import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';
import { FrameEditor } from './frame-editor.js';
import { WaypointSystem } from './waypoint-system.js';
import { BSPCollisionSystem, PLAYER_PHYSICS_BOUNDS } from './collision-detection.js';

// Global variables
let scene, camera, renderer, controls, clock;
let currentFrames = [];
let currentFrame = 0;
let isPlaying = false;
let playbackInterval = null;
let mapMesh = null;
let isWireframeMode = false;

// Lighting objects
let ambientLight = null;
let directionalLight = null;
let currentBrightness = 1.0; // 100% default

// 3D visualization objects
let playerSphere, pathGeometry, pathMaterial, pathLine;
let velocityArrow, yawArrow, wishArrow, groundIndicator;
let gridHelper = null;
let axesHelper = null;
let trailPoints = [];

// Entity visualization objects
let spawnObjects = [];
let triggerObjects = [];
let itemObjects = [];
let currentMapData = null;
let framesCollisionApplied = false;

// Q3 Physics Integration
let Q3Physics = null;
let physicsInitialized = false;

// Frame Editor and Waypoint System
let frameEditor = null;
let waypointSystem = null;
let isFrameEditorMode = false;
let isWaypointEditMode = false;

async function initQ3Physics() {
    try {
        console.log('[3D Viewer] Initializing oDFe Physics WebAssembly...');
        Q3Physics = await Q3PhysicsModule();

        // Initialize physics
        Q3Physics.ccall('InitPhysics', null, [], []);

        physicsInitialized = true;
        console.log('[3D Viewer] oDFe Physics initialized (100% accurate!)');

        Q3Physics.ccall('SetPlayerSpeed', null, ['number'], [320]);
        Q3Physics.ccall('SetGravity', null, ['number'], [800]);

        return true;
    } catch (error) {
        console.warn('[3D Viewer] oDFe Physics unavailable:', error.message);
        return false;
    }
}

function calculateQ3Physics(frameIndex) {
    if (!physicsInitialized || !Q3Physics || frameIndex >= currentFrames.length) {
        return calculateFallbackPhysics(frameIndex);
    }
    const prevFrame = currentFrames[frameIndex - 1];
    const currFrame = currentFrames[frameIndex];
    try {
        const dt = 1 / 125;
        const velX = (currFrame.x - prevFrame.x) / dt;
        const velY = (currFrame.y - prevFrame.y) / dt;
        const horizontalSpeed = Math.sqrt(velX * velX + velY * velY);
        const velocityAngle = Math.atan2(velY, velX);
        const yawAngle = prevFrame.yawDeg * Math.PI / 180;
        let optimalWishAngle = yawAngle;
        if (horizontalSpeed > 10) optimalWishAngle = velocityAngle + (Math.PI / 6);
        const prevVelX = frameIndex < 2 ? 0 : (prevFrame.x - currentFrames[frameIndex - 2].x) / dt;
        const prevVelY = frameIndex < 2 ? 0 : (prevFrame.y - currentFrames[frameIndex - 2].y) / dt;
        const accelX = velX - prevVelX;
        const accelY = velY - prevVelY;
        const accelMagnitude = Math.sqrt(accelX * accelX + accelY * accelY);
        const wishAngleDeg = optimalWishAngle * 180 / Math.PI;
        const velAngleDeg = velocityAngle * 180 / Math.PI;
        const angleDiff = Math.abs(((wishAngleDeg - velAngleDeg + 180) % 360) - 180);
        let efficiency = 0;
        if (angleDiff <= 45) {
            efficiency = Math.max(0, 100 - (Math.abs(angleDiff - 30) / 45) * 100);
            if (!currFrame.onGround) efficiency = Math.min(100, efficiency * 1.2);
        }
        return { horizontalSpeed, velocityAngle, optimalWishAngle, efficiency, acceleration: accelMagnitude, q3Enhanced: true };
    } catch (e) {
        return calculateFallbackPhysics(frameIndex);
    }
}

function calculateFallbackPhysics(frameIndex) {
    if (frameIndex < 1 || frameIndex >= currentFrames.length) {
        return { horizontalSpeed: 0, velocityAngle: 0, optimalWishAngle: 0, efficiency: 0, acceleration: 0, q3Enhanced: false };
    }
    const prevFrame = currentFrames[frameIndex - 1];
    const currFrame = currentFrames[frameIndex];
    const dt = 1 / 125;
    const velX = (currFrame.x - prevFrame.x) / dt;
    const velY = (currFrame.y - prevFrame.y) / dt;
    const horizontalSpeed = Math.sqrt(velX * velX + velY * velY);
    const velocityAngle = Math.atan2(velY, velX);
    const optimalWishAngle = velocityAngle + (Math.PI / 6);
    console.warn('[Viewer3D] Using fallback physics calculation - demo data lacks movement inputs');
    return { horizontalSpeed, velocityAngle, optimalWishAngle, efficiency: 50, acceleration: 0, q3Enhanced: false };
}

function quakeYawRadToThree(angleRad) {
    if (!isFinite(angleRad)) return 0;
    const dirX = Math.cos(angleRad);
    const dirZ = -Math.sin(angleRad);
    return Math.atan2(dirZ, dirX);
}

function applyEfficiencyColor(group, efficiency) {
    const color = new THREE.Color();
    if (efficiency >= 80) color.setHex(0x4caf50);
    else if (efficiency >= 60) color.setHex(0x9c27b0);
    else if (efficiency >= 40) color.setHex(0xff9800);
    else color.setHex(0xf44336);
    group.children.forEach(c => c.material && (c.material.color = color));
}

class EnhancedMapLoader {
    constructor() { this.mapData = null; this.textures = new Map(); this.materials = new Map(); }
    async loadMapFromFile(file) {
        const fn = file.name.toLowerCase();
        if (fn.endsWith('.pk3')) return this.loadPK3FromFile(file);
        if (fn.endsWith('.bsp')) return this.loadBSPFromFile(file);
        throw new Error('Unsupported file format');
    }
    async loadPK3FromFile(file) {
        const zip = await JSZip.loadAsync(file);
        let bspFile = null;

        zip.forEach((path, entry) => {
            const normalized = path.toLowerCase();
            if (!bspFile && normalized.startsWith('maps/') && normalized.endsWith('.bsp')) {
                bspFile = entry;
            }
        });

        if (!bspFile) throw new Error('No BSP inside PK3');
        const bspArrayBuffer = await bspFile.async('arraybuffer');
        const bspData = this.parseBSP(bspArrayBuffer);
        const textures = await this.loadTexturesFromPK3(zip);
        const shaders = await this.loadShadersFromPK3(zip);
        return { type: 'pk3', bsp: bspData, textures, shaders, zipFile: zip };
    }
    async loadTexturesFromPK3(zip) {
        const textures = new Map();
        const promises = [];

        zip.forEach((path, entry) => {
            const normalized = path.toLowerCase();
            if (normalized.startsWith('textures/') && /\.(jpg|png|tga)$/i.test(normalized)) {
                const name = path.split('/').pop().split('.')[0];
                promises.push(entry.async('blob').then(blob => new Promise(res => {
                    const img = new Image();
                    img.onload = () => {
                        const tex = new THREE.Texture(img);
                        tex.needsUpdate = true;
                        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                        textures.set(name.toLowerCase(), tex);
                        res();
                    };
                    img.src = URL.createObjectURL(blob);
                })));
            }
        });
        await Promise.all(promises);
        return textures;
    }
    async loadShadersFromPK3(zip) {
        const shaders = new Map();
        zip.forEach(async (p, e) => {
            if (p.startsWith('scripts/') && p.endsWith('.shader')) {
                try {
                    const txt = await e.async('text');
                    this.parseShaderScript(txt, shaders);
                } catch { }
            }
        });
        return shaders;
    }
    parseShaderScript(text, shaders) {
        const lines = text.split('\n');
        let cur = null;
        for (let l of lines) {
            l = l.trim();
            if (!l || l.startsWith('//')) continue;
            if (l.includes('{')) {
                const nm = l.replace('{', '').trim();
                cur = { name: nm, stages: [], properties: {} };
            } else if (l.includes('}') && cur) {
                shaders.set(cur.name.toLowerCase(), cur);
                cur = null;
            } else if (cur && l.includes('map')) {
                cur.stages.push({ map: l.replace('map', '').trim() });
            }
        }
    }
    loadBSPFromFile(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => {
                try {
                    resolve({ type: 'bsp', bsp: this.parseBSP(e.target.result), textures: new Map(), shaders: new Map() });
                } catch (err) {
                    reject(err);
                }
            };
            r.onerror = () => reject(new Error('Read fail'));
            r.readAsArrayBuffer(file);
        });
    }
    parseBSP(arrayBuffer) {
        const dv = new DataView(arrayBuffer);
        let off = 0;
        const magic = dv.getUint32(off, true); off += 4;
        const ver = dv.getUint32(off, true); off += 4;
        if (magic !== 0x50534249) throw new Error('Invalid BSP');
        const lumps = [];
        for (let i = 0; i < 17; i++) {
            lumps.push({ offset: dv.getUint32(off, true), length: dv.getUint32(off + 4, true) });
            off += 8;
        }
        const vertices = this.parseVertices(arrayBuffer, lumps[10]);
        const faces = this.parseFaces(arrayBuffer, lumps[13]);
        const meshVerts = this.parseMeshVerts(arrayBuffer, lumps[11]);
        const textures = this.parseTextures(arrayBuffer, lumps[1]);
        const entities = this.parseEntities(arrayBuffer, lumps[0]);
        const planes = this.parsePlanes(arrayBuffer, lumps[2]);
        const nodes = this.parseNodes(arrayBuffer, lumps[3]);
        const leafs = this.parseLeafs(arrayBuffer, lumps[4]);
        const leafBrushes = this.parseLeafBrushes(arrayBuffer, lumps[6]);
        const models = this.parseModels(arrayBuffer, lumps[7]);
        const brushes = this.parseBrushes(arrayBuffer, lumps[8], textures);
        const brushSides = this.parseBrushSides(arrayBuffer, lumps[9], textures);
        return { vertices, faces, meshVerts, textures, entities, lumps, planes, nodes, leafs, leafBrushes, brushes, brushSides, models };
    }
    parseEntities(arrayBuffer, lump) {
        const entities = [];
        if (!lump.length) return entities;
        const str = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, lump.offset, lump.length));
        const lines = str.split('\n');
        let cur = null, depth = 0;
        for (let ln of lines) {
            ln = ln.trim();
            if (!ln || ln.startsWith('//')) continue;
            if (ln === '{') {
                depth++;
                if (depth === 1) cur = { properties: {} };
            } else if (ln === '}') {
                depth--;
                if (depth === 0 && cur) {
                    entities.push(cur);
                    cur = null;
                }
            } else if (cur && depth === 1) {
                const m = ln.match(/^"([^"]+)"\s+"([^"]*)"$/);
                if (m) cur.properties[m[1]] = m[2];
            }
        }
        this.categorizeEntities(entities);
        return entities;
    }
    categorizeEntities(entities) {
        const cat = { players: [], triggers: [], items: [], lights: [], other: [] };
        entities.forEach((e, i) => {
            const c = e.properties.classname || '';
            e.index = i;
            if (c.includes('info_player') || c.includes('info_spectator')) cat.players.push(e);
            else if (c.startsWith('trigger_')) cat.triggers.push(e);
            else if (/^item_|^weapon_|^ammo_/.test(c)) cat.items.push(e);
            else if (c.includes('light')) cat.lights.push(e);
            else cat.other.push(e);
        });
        const el = document.getElementById('entityCount');
        if (el) {
            el.innerHTML = `<div>Players: ${cat.players.length}</div><div>Triggers: ${cat.triggers.length}</div><div>Items: ${cat.items.length}</div><div>Lights: ${cat.lights.length}</div><div>Other: ${cat.other.length}</div>`;
        }
        return cat;
    }
    parseOrigin(o) {
        if (!o) return [0, 0, 0];
        const a = o.split(' ').map(parseFloat);
        return a.length >= 3 ? a : [0, 0, 0];
    }
    parseAngle(a) { return a ? parseFloat(a) * Math.PI / 180 : 0; }
    parseTextures(arrayBuffer, lump) {
        const list = [];
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const entry = 72;
        const n = lump.length / entry;
        for (let i = 0; i < n; i++) {
            const off = i * entry;
            const bytes = new Uint8Array(arrayBuffer, lump.offset + off, 64);
            let name = '';
            for (let j = 0; j < 64 && bytes[j] !== 0; j++) name += String.fromCharCode(bytes[j]);
            list.push({ name, flags: dv.getUint32(off + 64, true), contents: dv.getUint32(off + 68, true) });
        }
        return list;
    }
    parseVertices(arrayBuffer, lump) {
        const verts = [];
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const sz = 44;
        const n = lump.length / sz;
        for (let i = 0; i < n; i++) {
            const o = i * sz;
            verts.push({
                position: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
                texCoord: [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true)],
                normal: [dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true), dv.getFloat32(o + 36, true)],
                color: [dv.getUint8(o + 40), dv.getUint8(o + 41), dv.getUint8(o + 42), dv.getUint8(o + 43)]
            });
        }
        return verts;
    }
    parseFaces(arrayBuffer, lump) {
        const faces = [];
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const sz = 104;
        const n = lump.length / sz;
        for (let i = 0; i < n; i++) {
            const o = i * sz;
            faces.push({
                texture: dv.getInt32(o, true), type: dv.getInt32(o + 8, true),
                vertex: dv.getInt32(o + 12, true), numVerts: dv.getInt32(o + 16, true),
                meshVert: dv.getInt32(o + 20, true), numMeshVerts: dv.getInt32(o + 24, true)
            });
        }
        return faces;
    }
    parseMeshVerts(arrayBuffer, lump) {
        const out = [];
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        for (let i = 0; i < lump.length / 4; i++) out.push(dv.getInt32(i * 4, true));
        return out;
    }
    parsePlanes(arrayBuffer, lump) {
        const planes = [];
        if (!lump.length) return planes;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 16;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            const normal = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
            const dist = dv.getFloat32(o + 12, true);
            const type = this.classifyPlane(normal);
            const signBits = (normal[0] < 0 ? 1 : 0) | (normal[1] < 0 ? 2 : 0) | (normal[2] < 0 ? 4 : 0);
            planes.push({ normal, dist, type, signBits });
        }
        return planes;
    }
    parseNodes(arrayBuffer, lump) {
        const nodes = [];
        if (!lump.length) return nodes;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 36;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            nodes.push({
                plane: dv.getInt32(o, true),
                children: [dv.getInt32(o + 4, true), dv.getInt32(o + 8, true)],
                mins: [dv.getInt32(o + 12, true), dv.getInt32(o + 16, true), dv.getInt32(o + 20, true)],
                maxs: [dv.getInt32(o + 24, true), dv.getInt32(o + 28, true), dv.getInt32(o + 32, true)]
            });
        }
        return nodes;
    }
    parseLeafs(arrayBuffer, lump) {
        const leafs = [];
        if (!lump.length) return leafs;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 48;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            leafs.push({
                cluster: dv.getInt32(o, true),
                area: dv.getInt32(o + 4, true),
                mins: [dv.getInt32(o + 8, true), dv.getInt32(o + 12, true), dv.getInt32(o + 16, true)],
                maxs: [dv.getInt32(o + 20, true), dv.getInt32(o + 24, true), dv.getInt32(o + 28, true)],
                firstLeafSurface: dv.getInt32(o + 32, true),
                numLeafSurfaces: dv.getInt32(o + 36, true),
                firstLeafBrush: dv.getInt32(o + 40, true),
                numLeafBrushes: dv.getInt32(o + 44, true)
            });
        }
        return leafs;
    }
    parseLeafBrushes(arrayBuffer, lump) {
        if (!lump.length) return [];
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const list = [];
        for (let i = 0; i < lump.length / 4; i++) list.push(dv.getInt32(i * 4, true));
        return list;
    }
    parseModels(arrayBuffer, lump) {
        const models = [];
        if (!lump.length) return models;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 40;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            models.push({
                mins: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
                maxs: [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)],
                firstSurface: dv.getInt32(o + 24, true),
                numSurfaces: dv.getInt32(o + 28, true),
                firstBrush: dv.getInt32(o + 32, true),
                numBrushes: dv.getInt32(o + 36, true)
            });
        }
        return models;
    }
    parseBrushes(arrayBuffer, lump, textures) {
        const brushes = [];
        if (!lump.length) return brushes;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 12;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            const textureIndex = dv.getInt32(o + 8, true);
            const shader = textures[textureIndex] || { contents: 0, flags: 0 };
            brushes.push({
                firstSide: dv.getInt32(o, true),
                numSides: dv.getInt32(o + 4, true),
                textureIndex,
                contents: shader.contents ?? 0,
                surfaceFlags: shader.flags ?? 0,
                _lastTraceId: 0
            });
        }
        return brushes;
    }
    parseBrushSides(arrayBuffer, lump, textures) {
        const sides = [];
        if (!lump.length) return sides;
        const dv = new DataView(arrayBuffer, lump.offset, lump.length);
        const stride = 8;
        for (let i = 0; i < lump.length / stride; i++) {
            const o = i * stride;
            const textureIndex = dv.getInt32(o + 4, true);
            const shader = textures[textureIndex] || { contents: 0, flags: 0 };
            sides.push({
                planeIndex: dv.getInt32(o, true),
                textureIndex,
                surfaceFlags: shader.flags ?? 0,
                contents: shader.contents ?? 0
            });
        }
        return sides;
    }
    classifyPlane(normal) {
        const AXIS_EPSILON = 1e-4;
        for (let axis = 0; axis < 3; axis++) {
            const isAxis = Math.abs(Math.abs(normal[axis]) - 1) < AXIS_EPSILON;
            const otherA = Math.abs(normal[(axis + 1) % 3]) < AXIS_EPSILON;
            const otherB = Math.abs(normal[(axis + 2) % 3]) < AXIS_EPSILON;
            if (isAxis && otherA && otherB) {
                return axis;
            }
        }
        return 3;
    }
    createThreeJSGeometry(mapData) {
        const geom = new THREE.BufferGeometry();
        const pos = [], norm = [], uv = [], col = [];
        for (const face of mapData.bsp.faces) {
            if (face.type === 1 || face.type === 3) {
                for (let i = 0; i < face.numMeshVerts; i += 3) {
                    for (let j = 0; j < 3; j++) {
                        const mv = face.meshVert + i + j;
                        if (mv < mapData.bsp.meshVerts.length) {
                            const vi = face.vertex + mapData.bsp.meshVerts[mv];
                            const v = mapData.bsp.vertices[vi];
                            // Q3 to Three.js coordinate conversion: Q3(X,Y,Z) → Three.js(X,Z,-Y)
                            pos.push(v.position[0], v.position[2], -v.position[1]);
                            norm.push(v.normal[0], v.normal[2], -v.normal[1]);
                            uv.push(...v.texCoord);
                            col.push(v.color[0] / 255, v.color[1] / 255, v.color[2] / 255);
                        }
                    }
                }
            }
        }
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geom.computeBoundingBox();
        return geom;
    }
    createMaterial(mapData, wireframe = false) {
        if (mapData.type === 'pk3' && mapData.textures.size > 0) {
            const first = mapData.textures.values().next().value;
            return new THREE.MeshLambertMaterial({ map: first, transparent: true, opacity: wireframe ? 0.3 : 0.8, wireframe, side: THREE.DoubleSide });
        }
        return new THREE.MeshLambertMaterial({ vertexColors: true, wireframe, transparent: true, opacity: wireframe ? 0.5 : 0.7, side: THREE.DoubleSide });
    }
}

const bspLoader = new EnhancedMapLoader();
const collisionSystem = new BSPCollisionSystem();

function initializeObjects() {
    const sGeo = new THREE.SphereGeometry(8, 16, 16);
    const sMat = new THREE.MeshPhongMaterial({ color: 0xff6b6b, emissive: 0x220000, shininess: 80 });
    playerSphere = new THREE.Mesh(sGeo, sMat);
    playerSphere.castShadow = true;
    scene.add(playerSphere);
    pathGeometry = new THREE.BufferGeometry();
    pathMaterial = new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.8 });
    pathLine = new THREE.Line(pathGeometry, pathMaterial);
    scene.add(pathLine);
    velocityArrow = createArrow(0x4caf50, 'Velocity');
    scene.add(velocityArrow);
    yawArrow = createArrow(0xff9800, 'Yaw');
    scene.add(yawArrow);
    wishArrow = createArrow(0x9c27b0, 'Wish');
    scene.add(wishArrow);
    const gGeo = new THREE.CylinderGeometry(15, 15, 2, 16);
    const gMat = new THREE.MeshPhongMaterial({ color: 0xf44336, transparent: true, opacity: 0.7 });
    groundIndicator = new THREE.Mesh(gGeo, gMat);
    scene.add(groundIndicator);
}

function createArrow(color, name) {
    const group = new THREE.Group();
    group.name = name;
    const shaftGeo = new THREE.CylinderGeometry(1, 1, 50, 8);
    const shaftMat = new THREE.MeshPhongMaterial({ color });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = 25;
    group.add(shaft);
    const headGeo = new THREE.ConeGeometry(4, 10, 8);
    const headMat = new THREE.MeshPhongMaterial({ color });
    const head = new THREE.Mesh(headGeo, headMat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = 55;
    group.add(head);
    return group;
}

function updateVisualization() {
    if (!currentFrames.length || !currentFrames[currentFrame]) return;
    const frame = currentFrames[currentFrame];
    const phys = calculateQ3Physics(currentFrame);
    playerSphere.position.set(frame.x, frame.z, frame.y);
    if (phys.horizontalSpeed > 10) {
        velocityArrow.visible = document.getElementById('showVelocity')?.checked ?? true;
        velocityArrow.position.copy(playerSphere.position);
        velocityArrow.rotation.y = quakeYawRadToThree(phys.velocityAngle);
        const scale = Math.min(Math.max(phys.horizontalSpeed / 400, 0.4), 3.0);
        velocityArrow.scale.set(scale, scale, scale);
    } else velocityArrow.visible = false;
    const yawRad = frame.yawDeg * Math.PI / 180;
    yawArrow.position.copy(playerSphere.position);
    yawArrow.rotation.y = quakeYawRadToThree(yawRad);
    yawArrow.visible = document.getElementById('showYaw')?.checked ?? true;
    wishArrow.position.copy(playerSphere.position);
    if (phys.horizontalSpeed > 10) {
        wishArrow.rotation.y = quakeYawRadToThree(phys.optimalWishAngle);
        wishArrow.visible = document.getElementById('showWish')?.checked ?? true;
        applyEfficiencyColor(wishArrow, phys.efficiency);
    } else {
        wishArrow.rotation.y = quakeYawRadToThree(yawRad + Math.PI / 4);
        wishArrow.visible = document.getElementById('showWish')?.checked ?? true;
        applyEfficiencyColor(wishArrow, 0);
    }
    if (frame.onGround) {
        groundIndicator.position.set(frame.x, frame.z - 10, frame.y);
        groundIndicator.visible = document.getElementById('showGround')?.checked ?? true;
    } else groundIndicator.visible = false;
    if (document.getElementById('showTrail')?.checked) updateTrail(frame);
    updateInfoPanel(frame, phys);
}

function updateTrail(frame) {
    if (trailPoints.length > 60) {
        const old = trailPoints.shift();
        scene.remove(old);
    }
    const geo = new THREE.SphereGeometry(2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.4 });
    const pt = new THREE.Mesh(geo, mat);
    pt.position.set(frame.x, frame.z, frame.y);
    trailPoints.push(pt);
    scene.add(pt);
    trailPoints.forEach((p, i) => {
        p.material.opacity = (i / trailPoints.length) * 0.4;
    });
}

function updatePath() {
    if (!currentFrames.length) return;
    const pts = currentFrames.map(f => new THREE.Vector3(f.x, f.z, f.y));
    pathGeometry.setFromPoints(pts);
    pathLine.visible = document.getElementById('showPath')?.checked ?? true;
}

function updateInfoPanel(frame, phys) {
    const fEl = id => document.getElementById(id);
    fEl('infoFrame') && (fEl('infoFrame').textContent = frame.frame);
    fEl('infoSpeed') && (fEl('infoSpeed').textContent = `${frame.speed?.toFixed(1) ?? 0} ups`);
    fEl('infoPosition') && (fEl('infoPosition').textContent = `${frame.x.toFixed(1)}, ${frame.y.toFixed(1)}, ${frame.z.toFixed(1)}`);
    fEl('infoYaw') && (fEl('infoYaw').textContent = `${frame.yawDeg.toFixed(1)}°`);
    fEl('infoGround') && (fEl('infoGround').textContent = frame.onGround ? 'Yes' : 'No');
    fEl('infoHeight') && (fEl('infoHeight').textContent = frame.z.toFixed(1));
    if (phys) {
        let qs = fEl('infoQ3Speed');
        if (!qs) {
            const panel = document.querySelector('.info-panel');
            if (panel) {
                panel.insertAdjacentHTML('beforeend', `<div class="info-item"><span class="info-label">Q3 H-Speed:</span><span class="info-value" id="infoQ3Speed"></span></div><div class="info-item"><span class="info-label">Strafe Eff:</span><span class="info-value" id="infoQ3Eff"></span></div><div class="info-item"><span class="info-label">Accel:</span><span class="info-value" id="infoQ3Accel"></span></div>`);
                qs = fEl('infoQ3Speed');
            }
        }
        if (qs) {
            fEl('infoQ3Speed').textContent = `${phys.horizontalSpeed.toFixed(1)} ups`;
            fEl('infoQ3Eff').textContent = `${phys.efficiency.toFixed(1)}%`;
            fEl('infoQ3Accel').textContent = `${phys.acceleration.toFixed(1)} ups/s`;
        }
    }
}

function setCurrentFrame(index) {
    if (!currentFrames.length) return;
    currentFrame = Math.max(0, Math.min(index, currentFrames.length - 1));
    const slider = document.getElementById('frameSlider');
    if (slider) slider.value = currentFrame;
    const disp = document.getElementById('frameDisplay');
    if (disp) disp.textContent = `${currentFrame} / ${currentFrames.length - 1}`;
    updateVisualization();
}

function togglePlayback() {
    if (isPlaying) {
        stopPlayback();
    } else startPlayback();
}

function startPlayback() {
    if (isPlaying || !currentFrames.length) return;
    isPlaying = true;
    const btn = document.getElementById('btnPlay');
    if (btn) btn.textContent = '⏸';
    const speed = parseFloat(document.getElementById('playbackSpeed')?.value || '1');
    const interval = Math.max(16, 1000 / (125 * speed));
    playbackInterval = setInterval(() => {
        if (currentFrame >= currentFrames.length - 1) {
            stopPlayback();
            return;
        }
        setCurrentFrame(currentFrame + 1);
    }, interval);
}

function stopPlayback() {
    isPlaying = false;
    const btn = document.getElementById('btnPlay');
    if (btn) btn.textContent = '⏯';
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
}

function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    scene.fog = new THREE.Fog(0x1a1a1a, 1000, 10000);
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 20000);
    camera.position.set(500, 500, 500);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = currentBrightness;

    document.getElementById('threejs-container')?.appendChild(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 10;
    controls.maxDistance = 5000;
    
    // Store lighting references globally
    ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);
    
    directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1000, 1000, 500);
    directionalLight.castShadow = true;
    scene.add(directionalLight);
    
    gridHelper = new THREE.GridHelper(2000, 50, 0x444444, 0x222222);
    scene.add(gridHelper);
    axesHelper = new THREE.AxesHelper(200);
    scene.add(axesHelper);
    clock = new THREE.Clock();
    initializeObjects();
    window.addEventListener('resize', onWindowResize);
    setupControlListeners();
    setupBSPControls();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function setupControlListeners() {
    document.getElementById('frameSlider')?.addEventListener('input', e => setCurrentFrame(parseInt(e.target.value)));
    document.getElementById('btnFirst')?.addEventListener('click', () => setCurrentFrame(0));
    document.getElementById('btnPrev')?.addEventListener('click', () => setCurrentFrame(currentFrame - 1));
    document.getElementById('btnPlay')?.addEventListener('click', togglePlayback);
    document.getElementById('btnNext')?.addEventListener('click', () => setCurrentFrame(currentFrame + 1));
    document.getElementById('btnLast')?.addEventListener('click', () => setCurrentFrame(currentFrames.length - 1));
    ['showPath', 'showVelocity', 'showYaw', 'showWish', 'showGround', 'showTrail'].forEach(id => document.getElementById(id)?.addEventListener('change', updateVisualization));
    document.getElementById('resetCamera')?.addEventListener('click', resetCamera);
    document.getElementById('topView')?.addEventListener('click', () => setCameraView('top'));
    document.getElementById('sideView')?.addEventListener('click', () => setCameraView('side'));
    document.addEventListener('keydown', handleKeyPress);
}

function setupBSPControls() {
    const loadBspButton = document.getElementById('loadBspButton');
    const bspFileInput = document.getElementById('bspFileInput');
    const showMapCheckbox = document.getElementById('showMap');
    const toggleWireframeButton = document.getElementById('toggleWireframe');
    const brightnessSlider = document.getElementById('brightnessSlider');
    const brightnessValue = document.getElementById('brightnessValue');
    const resetBrightness = document.getElementById('resetBrightness');
    
    if (!loadBspButton || !bspFileInput) return;
    loadBspButton.addEventListener('click', () => bspFileInput.click());
    bspFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && (file.name.toLowerCase().endsWith('.bsp') || file.name.toLowerCase().endsWith('.pk3'))) {
            loadBSPMap(file);
        }
        e.target.value = '';
    });
    if (toggleWireframeButton) toggleWireframeButton.addEventListener('click', toggleWireframe);
    if (showMapCheckbox) showMapCheckbox.addEventListener('change', (e) => {
        if (mapMesh) {
            mapMesh.visible = e.target.checked;
        }
        if (gridHelper) gridHelper.visible = !e.target.checked;
        if (axesHelper) axesHelper.visible = !e.target.checked;
    });
    
    // Brightness control
    if (brightnessSlider && brightnessValue) {
        brightnessSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            brightnessValue.textContent = value;
            updateMapBrightness(value / 100.0);
        });
    }
    
    if (resetBrightness) {
        resetBrightness.addEventListener('click', () => {
            if (brightnessSlider && brightnessValue) {
                brightnessSlider.value = 100;
                brightnessValue.textContent = '100';
                updateMapBrightness(1.0);
            }
        });
    }
    
    ['showSpawns', 'showTriggers', 'showItems'].forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.addEventListener('change', updateEntityVisibility);
    });
}

// Update map brightness by adjusting lighting intensity
function updateMapBrightness(multiplier) {
    currentBrightness = multiplier;
    
    if (ambientLight) {
        // Base ambient light intensity is 0.6
        ambientLight.intensity = 0.6 * multiplier;
    }
    
    if (directionalLight) {
        // Base directional light intensity is 0.8
        directionalLight.intensity = 0.8 * multiplier;
    }
    
    // Update material emissive for additional brightness on dark maps
    if (mapMesh && mapMesh.material) {
        if (multiplier > 1.0) {
            // Add emissive light for brightness boost
            const emissiveIntensity = (multiplier - 1.0) * 0.3; // Scale emissive
            mapMesh.material.emissive = new THREE.Color(0xffffff);
            mapMesh.material.emissiveIntensity = emissiveIntensity;
        } else {
            // No emissive when brightness is normal or lower
            mapMesh.material.emissive = new THREE.Color(0x000000);
            mapMesh.material.emissiveIntensity = 0;
        }
        mapMesh.material.needsUpdate = true;
    }
    
    if (renderer) {
        renderer.toneMappingExposure = multiplier;
    }
    
    console.log(`[3D Viewer] Map brightness set to ${(multiplier * 100).toFixed(0)}%`);
}

function resetCamera() {
    camera.position.set(500, 500, 500);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
}

function setCameraView(view) {
    if (!currentFrames || currentFrames.length === 0) return;
    const frame = currentFrames[currentFrame];
    const target = new THREE.Vector3(frame.x, frame.z, frame.y);
    switch (view) {
        case 'top':
            camera.position.set(frame.x, frame.z + 800, frame.y);
            break;
        case 'side':
            camera.position.set(frame.x + 500, frame.z + 200, frame.y);
            break;
    }
    controls.target.copy(target);
    controls.update();
}

function handleKeyPress(e) {
    if (!currentFrames || currentFrames.length === 0) return;
    switch (e.key) {
        case 'ArrowLeft':
            e.preventDefault();
            setCurrentFrame(currentFrame - 1);
            break;
        case 'ArrowRight':
            e.preventDefault();
            setCurrentFrame(currentFrame + 1);
            break;
        case ' ':
            e.preventDefault();
            togglePlayback();
            break;
        case 'Home':
            e.preventDefault();
            setCurrentFrame(0);
            break;
        case 'End':
            e.preventDefault();
            setCurrentFrame(currentFrames.length - 1);
            break;
        case 'r':
            resetCamera();
            break;
    }
}

function loadDemoData() {
    const stored = localStorage.getItem('q3DemoData');
    if (stored) {
        try {
            currentFrames = JSON.parse(stored);
            if (currentFrames && currentFrames.length > 0) {
                document.getElementById('frameSlider').max = currentFrames.length - 1;
                framesCollisionApplied = false;
                updatePath();
                
                // Check if we have a BSP map loaded with spawn points
                if (currentMapData && currentMapData.bsp && currentMapData.bsp.entities) {
                    alignDemoToMapSpawn();
                    applyCollisionsToCurrentFrames();
                } else {
                    // Fallback to default behavior
                    setCurrentFrame(0);
                    const bounds = calculateBounds();
                    const center = bounds.center;
                    const size = bounds.size;
                    camera.position.set(center.x + size * 0.8, center.y + size * 0.6, center.z + size * 0.8);
                    controls.target.copy(center);
                    controls.update();
                    applyCollisionsToCurrentFrames();
                }
            }
        } catch (e) {
            console.error('Demo parse error', e);
        }
    }
}

// Align demo player to map spawn point
function alignDemoToMapSpawn() {
    if (!currentMapData || !currentMapData.bsp || !currentMapData.bsp.entities || !currentFrames.length) return;
    
    const spawnEntity = currentMapData.bsp.entities.find(e => 
        e.properties.classname === 'info_player_deathmatch' || 
        e.properties.classname === 'info_player_start'
    );
    
    if (spawnEntity) {
        const spawnOrigin = bspLoader.parseOrigin(spawnEntity.properties.origin);
        const spawnAngle = bspLoader.parseAngle(spawnEntity.properties.angle);
        const spawnPos = new THREE.Vector3(spawnOrigin[0], spawnOrigin[2], -spawnOrigin[1]);
        const firstFrame = currentFrames[0];
        const demoStartPos = new THREE.Vector3(firstFrame.x, firstFrame.z, firstFrame.y);
        const offset = new THREE.Vector3().subVectors(spawnPos, demoStartPos);
        
        currentFrames.forEach(frame => {
            frame.x += offset.x;
            frame.y += offset.z;
            frame.z += offset.y;
        });
        
        const spawnYawDeg = spawnAngle * 180 / Math.PI;
        const yawOffset = spawnYawDeg - firstFrame.yawDeg;
        currentFrames.forEach(frame => {
            frame.yawDeg = (frame.yawDeg + yawOffset + 360) % 360;
        });
        framesCollisionApplied = false;
        
        console.log(`[3D Viewer] Demo aligned to spawn: pos(${spawnOrigin[0].toFixed(1)}, ${spawnOrigin[1].toFixed(1)}, ${spawnOrigin[2].toFixed(1)}) yaw ${spawnYawDeg.toFixed(1)}°`);
        updatePath();
        setCurrentFrame(0);
        camera.position.set(spawnPos.x + 300, spawnPos.y + 200, spawnPos.z + 300);
        controls.target.copy(spawnPos);
        controls.update();
    }
}

function calculateBounds() {
    const box = new THREE.Box3();
    currentFrames.forEach(frame => {
        box.expandByPoint(new THREE.Vector3(frame.x, frame.z, frame.y));
    });
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    return { center, size };
}

function applyCollisionsToCurrentFrames() {
    if (!collisionSystem.isReady() || !currentFrames || currentFrames.length === 0) {
        return;
    }
    const dt = 1 / 125;
    let prev = currentFrames[0];
    for (let i = 1; i < currentFrames.length; i++) {
        const frame = currentFrames[i];
        const trace = collisionSystem.traceBox(
            [prev.x, prev.y, prev.z],
            [frame.x, frame.y, frame.z],
            PLAYER_PHYSICS_BOUNDS.mins,
            PLAYER_PHYSICS_BOUNDS.maxs
        );
        frame.x = trace.endPos.x;
        frame.y = trace.endPos.y;
        frame.z = trace.endPos.z;
        frame.onGround = trace.hit && trace.plane ? (trace.plane.normal[2] > 0.7) : false;
        const velX = (frame.x - prev.x) / dt;
        const velY = (frame.y - prev.y) / dt;
        const velZ = (frame.z - prev.z) / dt;
        frame.speed = Math.sqrt(velX * velX + velY * velY + velZ * velZ);
        prev = frame;
    }
    framesCollisionApplied = true;
    updatePath();
    setCurrentFrame(Math.min(currentFrame, currentFrames.length - 1));
}

function animate() {
    requestAnimationFrame(animate);
    controls?.update();
    renderer.render(scene, camera);
}

function toggleWireframe() {
    if (mapMesh && currentMapData) {
        isWireframeMode = !isWireframeMode;
        const newMat = bspLoader.createMaterial(currentMapData, isWireframeMode);
        mapMesh.material.dispose();
        mapMesh.material = newMat;
    }
}

async function loadBSPMap(file) {
    try {
        const mapData = await bspLoader.loadMapFromFile(file);
        currentMapData = mapData;
        if (!collisionSystem.loadFromBSP(mapData.bsp)) {
            console.warn('[3D Viewer] Collision system unavailable for this BSP');
        }
        if (frameEditor) {
            frameEditor.setCollisionSystem(collisionSystem.isReady() ? collisionSystem : null);
        }
        if (mapMesh) {
            if (waypointSystem) {
                waypointSystem.setMap(null);
            }
            scene.remove(mapMesh);
            mapMesh.geometry.dispose();
            mapMesh.material.dispose();
        }
        const geom = bspLoader.createThreeJSGeometry(mapData);
        const mat = bspLoader.createMaterial(mapData, isWireframeMode);
        mapMesh = new THREE.Mesh(geom, mat);
        mapMesh.name = 'BSP_Map';
        scene.add(mapMesh);
        if (waypointSystem) {
            waypointSystem.setMap(mapMesh);
        }
        if (gridHelper) gridHelper.visible = false;
        if (axesHelper) axesHelper.visible = false;
        if (mapData.bsp.entities) createEntityObjects(mapData.bsp.entities);
        
        // If demo is already loaded, align it to spawn point
        if (currentFrames.length > 0) {
            alignDemoToMapSpawn();
            applyCollisionsToCurrentFrames();
        }
        
        const box = new THREE.Box3().setFromObject(mapMesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        camera.position.set(center.x + maxDim, center.y + maxDim * 0.5, center.z + maxDim);
        controls.target.copy(center);
        controls.update();
    } catch (err) {
        console.error('Map load failed', err);
        alert('Failed to load map: ' + err.message);
        collisionSystem.reset();
        if (frameEditor) {
            frameEditor.setCollisionSystem(null);
        }
        if (!mapMesh) {
            if (gridHelper) gridHelper.visible = true;
            if (axesHelper) axesHelper.visible = true;
        }
    }
}

function createEntityObjects(entities) {
    clearEntityObjects();
    entities.forEach(e => {
        const c = e.properties.classname || '';
        const o = bspLoader.parseOrigin(e.properties.origin);
        const angle = bspLoader.parseAngle(e.properties.angle);
        // Q3 to Three.js coordinate conversion: Q3(X,Y,Z) → Three.js(X,Z,-Y)
        const pos = new THREE.Vector3(o[0], o[2], -o[1]);
        if (c.includes('info_player') || c.includes('info_spectator')) createSpawnPoint(pos, angle, c);
        else if (c.startsWith('trigger_')) createTrigger(pos, e, c);
        else if (/^item_|^weapon_|^ammo_/.test(c)) createItem(pos, c);
    });
    updateEntityVisibility();
}

function createSpawnPoint(pos, angle, classname) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(12, 24, 8), new THREE.MeshPhongMaterial({ color: classname.includes('deathmatch') ? 0x00ff00 : 0x00aa00, transparent: true, opacity: 0.8 }));
    cone.position.y = 12;
    g.add(cone);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(6, 20, 8), new THREE.MeshPhongMaterial({ color: 0xffff00 }));
    arrow.position.set(0, 30, 0);
    arrow.rotation.z = -Math.PI / 2;
    arrow.rotation.y = quakeYawRadToThree(angle);
    g.add(arrow);
    g.position.copy(pos);
    spawnObjects.push(g);
    scene.add(g);
}

function createTrigger(pos, entity, classname) {
    const size = 32;
    const trig = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true, transparent: true, opacity: 0.6 }));
    trig.position.copy(pos);
    trig.userData = { type: 'trigger', classname, entity };
    triggerObjects.push(trig);
    scene.add(trig);
}

function createItem(pos, classname) {
    let color = 0x00ffff, geo = new THREE.SphereGeometry(8, 12, 12);
    if (classname.includes('weapon_')) {
        geo = new THREE.BoxGeometry(16, 8, 16);
        color = 0xff8800;
    } else if (classname.includes('ammo_')) {
        geo = new THREE.CylinderGeometry(8, 8, 12, 8);
        color = 0x8800ff;
    }
    const item = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.7 }));
    item.position.copy(pos);
    item.userData = { type: 'item', classname };
    itemObjects.push(item);
    scene.add(item);
}

function clearEntityObjects() {
    [...spawnObjects, ...triggerObjects, ...itemObjects].forEach(o => scene.remove(o));
    spawnObjects = [];
    triggerObjects = [];
    itemObjects = [];
}

function updateEntityVisibility() {
    const showSp = document.getElementById('showSpawns')?.checked ?? true;
    const showTr = document.getElementById('showTriggers')?.checked ?? true;
    const showIt = document.getElementById('showItems')?.checked ?? true;
    spawnObjects.forEach(o => o.visible = showSp);
    triggerObjects.forEach(o => o.visible = showTr);
    itemObjects.forEach(o => o.visible = showIt);
}

function setupEditorControls() {
    const btnFrameEditor = document.getElementById('btnFrameEditor');
    if (btnFrameEditor) {
        btnFrameEditor.addEventListener('click', () => {
            toggleFrameEditor();
        });
    }

    const btnWaypointEdit = document.getElementById('btnWaypointEditor');
    if (btnWaypointEdit) {
        btnWaypointEdit.addEventListener('click', () => {
            if (!waypointSystem) return;
            isWaypointEditMode = waypointSystem.toggleEditMode();
            btnWaypointEdit.classList.toggle('active', isWaypointEditMode);
        });
    }

    if (renderer?.domElement) {
        renderer.domElement.addEventListener('click', (event) => {
            if (isWaypointEditMode && waypointSystem) {
                waypointSystem.handleClick(event, camera);
            }
        });
    }
}

function toggleFrameEditor() {
    isFrameEditorMode = !isFrameEditorMode;

    if (isFrameEditorMode) {
        if (!physicsInitialized || !Q3Physics) {
            alert('Q3 Physics WASM not initialized. Frame Editor will be unavailable until initialization completes.');
            console.warn('[3D Viewer] Frame Editor opened but Q3 Physics not ready - buttons will be disabled');
        }
        // Show frame editor UI
        showFrameEditorUI();
        console.log('[3D Viewer] Frame Editor Mode: ON (using Q3 WASM physics)');
    } else {
        // Hide frame editor UI
        hideFrameEditorUI();
        console.log('[3D Viewer] Frame Editor Mode: OFF');
    }

    const btnFrameEditor = document.getElementById('btnFrameEditor');
    if (btnFrameEditor) {
        btnFrameEditor.classList.toggle('active', isFrameEditorMode);
    }
}

function showFrameEditorUI() {
    // Create frame editor panel
    const panel = document.createElement('div');
    panel.id = 'frameEditorPanel';
    panel.style.cssText = `
        position: absolute;
        top: 160px;
        right: 20px;
        width: 300px;
        background: rgba(42, 42, 42, 0.95);
        padding: 20px;
        border-radius: 8px;
        z-index: 1001;
        max-height: 60vh;
        overflow-y: auto;
    `;

    panel.innerHTML = `
        <h3 style="margin: 0 0 15px 0; color: #4fc3f7;">Frame Editor</h3>
        
        <div style="margin-bottom: 15px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            <label><input type="checkbox" id="chkForward"> Forward</label>
            <label><input type="checkbox" id="chkBack"> Back</label>
            <label><input type="checkbox" id="chkLeft"> Left</label>
            <label><input type="checkbox" id="chkRight"> Right</label>
        </div>

        <div style="margin-bottom: 15px;">
            <label>Yaw: <span id="yawValue">0</span>°</label>
            <input type="range" id="yawSlider" min="-180" max="180" value="0" step="0.1" style="width: 100%;">
        </div>
        
        <div style="margin-bottom: 15px;">
            <label><input type="checkbox" id="jumpCheck"> Jump</label>
        </div>

        <div style="margin-bottom: 15px;">
            <label>Frames to add:</label>
            <input type="number" id="frameCountInput" value="1" min="1" max="200" style="width: 100%;">
        </div>
        
        <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <button id="btnAddFrame" style="flex: 1;">Add Last</button>
            <button id="btnInsertFrame" style="flex: 1;">Insert</button>
            <button id="btnDeleteFrame" style="flex: 1;">Delete</button>
        </div>
        
        <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <button id="btnUndo">↶ Undo</button>
            <button id="btnRedo">↷ Redo</button>
        </div>
        
        <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <button id="btnExportCfg">Export .cfg</button>
            <button id="btnExportJSON">Export JSON</button>
        </div>
        
        <div id="editorStats" style="font-size: 12px; color: #bbb;">
            <div>Frames: <span id="frameCount">0</span></div>
            <div>Duration: <span id="duration">0s</span></div>
            <div>Max Speed: <span id="maxSpeed">0 ups</span></div>
        </div>
    `;

    document.body.appendChild(panel);

    // Setup event listeners
    const readMovementInput = () => {
        const forward = document.getElementById('chkForward').checked;
        const back = document.getElementById('chkBack').checked;
        const left = document.getElementById('chkLeft').checked;
        const right = document.getElementById('chkRight').checked;

        let forwardMove = 0;
        if (forward && !back) forwardMove = 127;
        else if (back && !forward) forwardMove = -127;

        let rightMove = 0;
        if (right && !left) rightMove = 127;
        else if (left && !right) rightMove = -127;

        const yaw = parseFloat(document.getElementById('yawSlider').value) || 0;
        const jump = document.getElementById('jumpCheck').checked;

        return {
            forwardMove,
            rightMove,
            upMove: jump ? 200 : 0,
            angles: [0, yaw, 0],
            buttons: jump ? 2 : 0
        };
    };

    const readFrameCount = () => {
        const input = document.getElementById('frameCountInput');
        const parsed = parseInt(input.value, 10);
        const clamped = Math.min(200, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
        if (clamped !== parsed) input.value = clamped;
        return clamped;
    };

    document.getElementById('yawSlider').addEventListener('input', (e) => {
        document.getElementById('yawValue').textContent = parseFloat(e.target.value).toFixed(1);
    });

    const checkPhysicsReady = () => {
        if (!physicsInitialized || !Q3Physics) {
            alert('Q3 Physics WASM not initialized yet. Please wait...');
            return false;
        }
        return true;
    };

    document.getElementById('btnAddFrame').addEventListener('click', () => {
        if (!checkPhysicsReady()) return;
        const baseInput = readMovementInput();
        const count = readFrameCount();
        try {
            for (let i = 0; i < count; i++) {
                frameEditor.addFrame({ ...baseInput, angles: [...baseInput.angles] });
            }
            updateEditorStats();
            updateVisualizationFromEditor();
        } catch (error) {
            alert(error.message);
            console.error(error);
        }
    });

    document.getElementById('btnInsertFrame').addEventListener('click', () => {
        if (!checkPhysicsReady()) return;
        const baseInput = readMovementInput();
        const count = readFrameCount();
        try {
            for (let i = 0; i < count; i++) {
                frameEditor.insertFrame(currentFrame + i, { ...baseInput, angles: [...baseInput.angles] });
            }
            updateEditorStats();
            updateVisualizationFromEditor();
        } catch (error) {
            alert(error.message);
            console.error(error);
        }
    });

    document.getElementById('btnDeleteFrame').addEventListener('click', () => {
        frameEditor.deleteFrame(currentFrame);
        updateEditorStats();
        updateVisualizationFromEditor();
    });

    document.getElementById('btnUndo').addEventListener('click', () => {
        frameEditor.undo();
        updateEditorStats();
        updateVisualizationFromEditor();
    });

    document.getElementById('btnRedo').addEventListener('click', () => {
        frameEditor.redo();
        updateEditorStats();
        updateVisualizationFromEditor();
    });

    document.getElementById('btnExportCfg').addEventListener('click', () => {
        const cfg = frameEditor.exportToCfg();
        downloadFile('movement.cfg', cfg);
    });

    document.getElementById('btnExportJSON').addEventListener('click', () => {
        const json = frameEditor.exportToJSON();
        downloadFile('movement.json', json);
    });
}

function hideFrameEditorUI() {
    const panel = document.getElementById('frameEditorPanel');
    if (panel) {
        panel.remove();
    }
}

function updateEditorStats() {
    const stats = frameEditor.getStats();
    if (stats) {
        document.getElementById('frameCount').textContent = stats.totalFrames;
        document.getElementById('duration').textContent = stats.duration;
        document.getElementById('maxSpeed').textContent = stats.maxSpeed;
    }
}

function updateVisualizationFromEditor() {
    // Convert frame editor data to viewer format
    currentFrames = frameEditor.frames.map(frame => ({
        frame: frame.index,
        x: frame.stateAfter.pos.x,
        y: frame.stateAfter.pos.y,
        z: frame.stateAfter.pos.z,
        speed: Math.sqrt(
            frame.stateAfter.vel.x ** 2 +
            frame.stateAfter.vel.y ** 2 +
            frame.stateAfter.vel.z ** 2
        ),
        yawDeg: frame.stateAfter.angles.yaw,
        onGround: frame.stateAfter.onGround,
        forwardMove: frame.input.forwardMove,
        rightMove: frame.input.rightMove,
        upMove: frame.input.upMove,
        buttons: frame.input.buttons
    }));

    updatePath();
    setCurrentFrame(currentFrame);
}

function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

window.addEventListener('load', async () => {
    await initQ3Physics();
    initThreeJS();

    // Only create frame editor if physics initialized
    if (physicsInitialized && Q3Physics) {
        frameEditor = new FrameEditor(Q3Physics);
        frameEditor.setCollisionSystem(collisionSystem.isReady() ? collisionSystem : null);
        console.log('[3D Viewer] Frame Editor initialized with Q3 WASM physics');
    } else {
        console.warn('[3D Viewer] Frame Editor unavailable - Q3 Physics failed to initialize');
        frameEditor = null;
    }

    waypointSystem = new WaypointSystem(scene, mapMesh);
    console.log('[3D Viewer] Waypoint System initialized');

    setupEditorControls();
    loadDemoData();
    animate();
});

window.setCurrentFrame = setCurrentFrame;
window.togglePlayback = togglePlayback;
window.loadBSPMap = loadBSPMap;
window.updateVisualization = updateVisualization;