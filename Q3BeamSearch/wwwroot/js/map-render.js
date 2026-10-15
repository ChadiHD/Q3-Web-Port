// wwwroot/js/map-render.js
// Builds the map mesh + entity markers from parsed BSP data and positions the
// camera on the first spawn. Reads/writes shared state (V).

import * as THREE from 'three';
import { V } from './viewer-state.js';
import { bspLoader } from './bsp-loader.js';
import { findTimerTriggers } from './race-timer.js';

// Marker meshes point along +X; rotation.y = θ turns them to Q3 yaw θ, because Three's
// Z axis is -Q3 Y (Q3 → Three: (x, z, -y)).

export function renderMap(mapData) {
    if (V.mapMesh) {
        V.scene.remove(V.mapMesh);
        V.mapMesh.traverse(c => {
            if (c.isMesh) {
                c.geometry.dispose();
                (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
            }
        });
    }
    V.mapMesh = bspLoader.buildMapGroup(mapData, V.isWireframeMode);
    V.scene.add(V.mapMesh);
    if (V.waypointSystem) V.waypointSystem.setMap(V.mapMesh);

    const hasSky = V.mapMesh.children.some(c => c.userData?.isSky);
    // Sky surfaces should not be fogged into black.
    V.scene.fog = hasSky ? null : new THREE.Fog(0x111111, 2000, 12000);
    if (mapData.skyTexture) {
        V.scene.background = mapData.skyTexture;
    } else {
        V.scene.background = hasSky ? new THREE.Color(0x87CEEB) : new THREE.Color(0x111111);
    }

    V.timerTriggers = findTimerTriggers(mapData.bsp);
    if (mapData.bsp.entities) createEntityObjects(mapData.bsp);

    // Default camera: top-down on first spawn (criterion 3)
    const spawn = findFirstSpawn(mapData.bsp.entities);
    if (spawn) {
        const o = bspLoader.parseOrigin(spawn.properties.origin);
        const spawnAngle = spawn.properties.angle ? parseFloat(spawn.properties.angle) : 0;
        // Q3→Three: (X, Z, -Y)
        const pos = new THREE.Vector3(o[0], o[2], -o[1]);
        V.camera.position.set(pos.x, pos.y + 800, pos.z);
        V.camera.lookAt(pos);
        V.controls.target.copy(pos);

        // Place playerBox at spawn (same position as green cone)
        if (V.playerBox) {
            V.playerBox.position.copy(pos);
            V.playerBox.visible = true;
        }

        // Seed FrameEditor with Q3 spawn origin so physics starts here
        if (V.frameEditor) {
            V.frameEditor.setSpawnState(o, spawnAngle);
        }
    } else {
        const box = new THREE.Box3().setFromObject(V.mapMesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        V.camera.position.set(center.x, center.y + Math.max(size.x, size.z) * 0.9, center.z);
        V.camera.lookAt(center);
        V.controls.target.copy(center);
    }
    V.controls.update();
}

export function findFirstSpawn(entities) {
    if (!entities) return null;
    return entities.find(e => e.properties.classname === 'info_player_deathmatch' || e.properties.classname === 'info_player_start');
}

function createEntityObjects(bsp) {
    clearEntityObjects();
    const entities = bsp.entities;
    const targets = new Map(entities.filter(e => e.properties.targetname).map(e => [e.properties.targetname, e.properties.classname]));
    const cats = { players: 0, triggers: 0, items: 0, lights: 0, other: 0 };
    for (const e of entities) {
        const c = e.properties.classname || '';
        const o = bspLoader.parseOrigin(e.properties.origin);
        const ang = bspLoader.parseAngle(e.properties.angle);
        const pos = new THREE.Vector3(o[0], o[2], -o[1]);

        if (c.includes('info_player') || c.includes('info_spectator')) {
            createSpawnPoint(pos, ang, c); cats.players++;
        } else if (c.startsWith('trigger_')) {
            createTrigger(pos, e, c, bsp, targets.get(e.properties.target)); cats.triggers++;
        } else if (/^item_|^weapon_|^ammo_/.test(c)) {
            createItem(pos, c); cats.items++;
        } else if (c.includes('light')) { cats.lights++; }
        else { cats.other++; }
    }
    const el = document.getElementById('entityCount');
    if (el) el.innerHTML = `Players: ${cats.players} · Triggers: ${cats.triggers} · Items: ${cats.items} · Lights: ${cats.lights}`;
    updateEntityVisibility();
}

function createSpawnPoint(pos, angle, classname) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(12, 24, 8), new THREE.MeshPhongMaterial({ color: classname.includes('deathmatch') ? 0x00ff00 : 0x00aa00, transparent: true, opacity: 0.8 }));
    cone.position.y = 12; g.add(cone);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(6, 20, 8), new THREE.MeshPhongMaterial({ color: 0xffff00 }));
    arrow.position.set(0, 30, 0);
    arrow.rotation.z = -Math.PI/2;
    arrow.rotation.y = angle;
    g.add(arrow);
    g.position.copy(pos);
    V.spawnObjects.push(g); V.scene.add(g);
}
// Brush triggers ("model" "*N") have no origin: draw their brush model's bounds. DeFRaG timer
// triggers by what they target: start green, stop red, checkpoint blue; others yellow.
const TRIGGER_COLORS = { target_startTimer: 0x00ff66, target_stopTimer: 0xff3333, target_checkpoint: 0x33aaff };
function createTrigger(pos, entity, classname, bsp, targetClass) {
    const model = entity.properties.model?.startsWith('*') ? bsp.models?.[parseInt(entity.properties.model.slice(1), 10)] : null;
    const size = model ? [0, 1, 2].map(k => Math.max(1, model.maxs[k] - model.mins[k])) : [32, 32, 32];
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[2], size[1]),
        new THREE.MeshBasicMaterial({ color: TRIGGER_COLORS[targetClass] ?? 0xffff00, wireframe: true, transparent: true, opacity: 0.6 }));
    if (model) {
        const c = [0, 1, 2].map(k => (model.mins[k] + model.maxs[k]) / 2);
        m.position.set(c[0], c[2], -c[1]);
    } else m.position.copy(pos);
    m.userData = { type: 'trigger', classname, entity, timer: targetClass };
    V.triggerObjects.push(m); V.scene.add(m);
}
function createItem(pos, classname) {
    let color = 0x00ffff, geo = new THREE.SphereGeometry(8, 12, 12);
    if (classname.includes('weapon_')) { geo = new THREE.BoxGeometry(16,8,16); color = 0xff8800; }
    else if (classname.includes('ammo_')) { geo = new THREE.CylinderGeometry(8,8,12,8); color = 0x8800ff; }
    const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.7 }));
    m.position.copy(pos); m.userData = { type: 'item', classname };
    V.itemObjects.push(m); V.scene.add(m);
}
function clearEntityObjects() {
    [...V.spawnObjects, ...V.triggerObjects, ...V.itemObjects].forEach(o => V.scene.remove(o));
    V.spawnObjects = []; V.triggerObjects = []; V.itemObjects = [];
}
export function updateEntityVisibility() {
    const sp = document.getElementById('showSpawns')?.checked ?? true;
    const tr = document.getElementById('showTriggers')?.checked ?? true;
    const it = document.getElementById('showItems')?.checked ?? true;
    V.spawnObjects.forEach(o => o.visible = sp);
    V.triggerObjects.forEach(o => o.visible = tr);
    V.itemObjects.forEach(o => o.visible = it);
}
