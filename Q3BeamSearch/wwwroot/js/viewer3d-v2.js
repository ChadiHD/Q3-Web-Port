// wwwroot/js/viewer3d-v2.js
// Q3 TAS Viewer v2 — oDFe WASM only, map-first gate, collision physics,
// waypoint optimizer, script editor, spawn/trigger/item visualisation.
//
// Criteria satisfied:
//   1. Map upload required before anything else; demo/script upload optional
//   2. q3physics.wasm is the ONLY physics engine (no fallback)
//   3. Camera defaults to top-down on first spawn after map loads
//   4. BSP collision applied to player path
//   5. Spawn points, triggers, items rendered from BSP entities
//   6. This file replaces viewer3d.js

import * as THREE from 'three';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { PLAYER_PHYSICS_BOUNDS } from './collision-detection.js';
import { bspLoader } from './bsp-loader.js';
import { slideMove } from './slide-move.js';
import { V } from './viewer-state.js';
import { raceTime, formatMs, FRAME_MS } from './race-timer.js';
import { toast, downloadFile } from './ui-utils.js';
import { initThreeJS } from './scene-setup.js';
import { renderMap, findFirstSpawn, updateEntityVisibility } from './map-render.js';
import { runScript } from './movement-script.js';
import { exportBaked, exportScript } from './cfg-export.js';


// ═══════════════════════════════════════════════════════════════════════
//  Q3 WASM initialisation (mandatory — no fallback)
// ═══════════════════════════════════════════════════════════════════════
async function initQ3Physics() {
    try {
        V.Q3Physics = await Q3PhysicsModule();
        V.Q3Physics.ccall('InitPhysics', null, [], []);
        V.Q3Physics.ccall('SetPlayerSpeed', null, ['number'], [320]);
        V.Q3Physics.ccall('SetGravity', null, ['number'], [800]);
        V.Q3Physics._SetPromode(V.cpm ? 1 : 0);
        V.physicsReady = true;
        console.log('[v2] oDFe WASM physics ready');
        // If a map was already loaded before physics finished initialising,
        // push its collision model into the CM now.
        if (V.currentMapData) loadCollisionIntoWasm(V.currentMapData);
    } catch (e) {
        V.physicsReady = false;
        console.error('[v2] oDFe WASM failed to load — viewer will not function', e);
        setUploadStatus('Physics engine failed to load: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Upload gate
// ═══════════════════════════════════════════════════════════════════════
function setupUploadGate() {
    const dropZone = document.getElementById('dropZone');
    const browseBtn = document.getElementById('btnBrowseMap');
    const fileInput = document.getElementById('mapFileInput');

    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files[0]) handleMapUpload(e.target.files[0]); e.target.value = ''; });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f && (f.name.toLowerCase().endsWith('.bsp') || f.name.toLowerCase().endsWith('.pk3'))) handleMapUpload(f);
        else setUploadStatus('Only .bsp and .pk3 files are supported', 'error');
    });

    // defrag.racing download button
    document.getElementById('btnLoadDefrag')?.addEventListener('click', () => {
        let name = document.getElementById('defragMapName')?.value?.trim() ?? '';
        if (!name) { setUploadStatus('Enter a map filename', 'error'); return; }
        if (!name.toLowerCase().endsWith('.pk3')) name += '.pk3';
        loadMapFromDefrag(name);
    });
    document.getElementById('defragMapName')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btnLoadDefrag')?.click();
    });
}

async function loadMapFromDefrag(filename) {
    setUploadStatus(`Downloading ${filename}…`);
    try {
        const res = await fetch(`/api/map-proxy?mapname=${encodeURIComponent(filename)}`);
        if (!res.ok) {
            const msg = await res.text().catch(() => res.statusText);
            throw new Error(msg || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const file = new File([blob], filename, { type: 'application/octet-stream' });
        await handleMapUpload(file);
    } catch (err) {
        setUploadStatus(`Download failed: ${err.message}`, 'error');
    }
}

function setUploadStatus(msg, type = '') {
    const el = document.getElementById('uploadStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'upload-status' + (type ? ' ' + type : '');
}

async function handleMapUpload(file) {
    setUploadStatus('Loading map…');
    try {
        const mapData = await bspLoader.loadMapFromFile(file);
        V.currentMapData = mapData;
        V.collisionSystem.loadFromBSP(mapData.bsp);
        // Feed the raw BSP to the WASM collision model so Pmove traces hit real
        // world geometry (walls, floors, ramps, and curved patch surfaces).
        loadCollisionIntoWasm(mapData);
        setUploadStatus('Map loaded ✓', 'ok');
        setTimeout(() => transitionToViewer(), 400);
    } catch (err) {
        console.error('[v2] Map load failed', err);
        setUploadStatus('Failed: ' + err.message, 'error');
    }
}

// Uploads the raw .bsp bytes into the WASM heap and loads them into the ioq3
// collision model (CM). After this, StepPhysics/SimulateFrames collide against
// the real map inside Pmove. Safe to call before physics is ready — it becomes
// a no-op and is retried once initQ3Physics() finishes.
function loadCollisionIntoWasm(mapData) {
    if (!V.physicsReady || !V.Q3Physics) return false;
    if (!mapData || !mapData.rawBsp) {
        console.warn('[v2] no raw BSP bytes available — collision model not loaded');
        return false;
    }
    const Q3 = V.Q3Physics;

    // The collision exports only exist in a WASM build that includes the CM
    // module (wasm/src/cm). If q3physics.wasm hasn't been rebuilt since that was
    // added, these are missing — skip gracefully so the MAP STILL LOADS, just
    // without in-engine collision. Rebuild via wasm/build.ps1 to enable it.
    if (typeof Q3._LoadCollisionMap !== 'function' || typeof Q3._HasCollisionMap !== 'function') {
        console.warn('[v2] WASM module has no collision exports — rebuild wasm (wasm/build.ps1). ' +
                     'Map will load without in-engine collision.');
        toast('Collision unavailable — WASM needs rebuild (see console)');
        return false;
    }

    // Never let a collision-upload problem abort map loading.
    let ok = false;
    try {
        const bytes = new Uint8Array(mapData.rawBsp);
        const ptr = Q3._malloc(bytes.length);
        if (!ptr) { console.error('[v2] _malloc failed for BSP (%d bytes)', bytes.length); return false; }
        try {
            Q3.HEAPU8.set(bytes, ptr);
            Q3.ccall('LoadCollisionMap', null, ['number', 'number'], [ptr, bytes.length]);
        } finally {
            Q3._free(ptr);
        }
        ok = Q3.ccall('HasCollisionMap', 'number', [], []) === 1;
        console.log('[v2] WASM collision model %s (%d bytes)', ok ? 'loaded ✓' : 'FAILED', bytes.length);
        if (!ok) toast('Collision model failed to load');
    } catch (e) {
        console.error('[v2] collision upload failed:', e);
        toast('Collision upload failed (see console)');
        ok = false;
    }
    return ok;
}

function transitionToViewer() {
    document.getElementById('uploadGate').style.display = 'none';
    document.getElementById('viewerRoot').style.display = '';

    if (!V.isViewerInitialized) {
        initThreeJS();
        setupViewerControls();
        animate();
        V.isViewerInitialized = true;
    }

    // Reset per-map state so the previous run's frames/trail don't carry over.
    setFirstPerson(false);
    stopPlayback();
    V.currentFrames = [];
    V.currentFrame = 0;
    if (V.playerBox) V.playerBox.visible = false;
    V.trailPoints.forEach(p => V.scene.remove(p));
    V.trailPoints = [];
    if (V.pathLine) V.pathLine.visible = false;

    const slider = document.getElementById('frameSlider');
    if (slider) { slider.value = 0; slider.max = 0; }
    const disp = document.getElementById('frameDisplay');
    if (disp) disp.textContent = '0 / 0';

    renderMap(V.currentMapData);   // also finds the DeFRaG timer triggers (V.timerTriggers)
    V.currentRace = null;
    V.lastRoute = null;
    document.getElementById('btnExportRoute').style.display = 'none';
    const t = V.timerTriggers;
    document.getElementById('optFinishRow').style.display = t.stop.length ? 'block' : 'none';
    if (t.start.length || t.stop.length)
        toast(`Timer triggers: ${t.start.length} start · ${t.checkpoints.length} checkpoints · ${t.stop.length} stop`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Q3 physics helpers (no fallback — requires WASM)
// ═══════════════════════════════════════════════════════════════════════
// A frame's directions as Q3 yaws (radians): velocity after the frame, the view, and the
// wish direction its keys gave (Pmove: forward·f + right·s with right = view - 90°, so
// view + atan2(-s, f); null with no move keys). WASM runs carry the real Pmove velocity
// (vx, vy); other frames fall back to the movement since the previous frame.
function frameVectors(frameIndex) {
    const cur = V.currentFrames[frameIndex], prev = V.currentFrames[frameIndex - 1];
    let vx = cur.vx, vy = cur.vy;
    if (vx === undefined) {
        vx = prev ? (cur.x - prev.x) * 125 : 0;
        vy = prev ? -(cur.y - prev.y) * 125 : 0;   // frame y is -Q3 y
    }
    const yaw = (cur.yawDeg ?? 0) * Math.PI / 180;
    const f = cur.forwardMove ?? 0, s = cur.rightMove ?? 0;
    return { hSpeed: Math.hypot(vx, vy), velYaw: Math.atan2(vy, vx), yaw, wishYaw: f || s ? yaw + Math.atan2(-s, f) : null };
}

// ═══════════════════════════════════════════════════════════════════════
//  Collision application to loaded frames (criterion 4)
//  Implements Q3-style slide movement: when hitting a wall, clip the
//  remaining velocity against the surface normal and continue moving.
// ═══════════════════════════════════════════════════════════════════════

function applyCollisionsToFrames() {
    if (!V.collisionSystem.isReady() || !V.currentFrames.length) return;

    const dt = 1 / 125;
    let prev = V.currentFrames[0];

    for (let i = 1; i < V.currentFrames.length; i++) {
        const fr = V.currentFrames[i];

        // Frame convention -> Q3 coords for collision
        const startQ3 = [prev.x, -prev.y, prev.z];
        const endQ3 = [fr.x, -fr.y, fr.z];

        // Movement vector this frame wants to travel
        const moveVec = [endQ3[0] - startQ3[0], endQ3[1] - startQ3[1], endQ3[2] - startQ3[2]];

        const result = slideMove(startQ3, moveVec, V.collisionSystem, PLAYER_PHYSICS_BOUNDS);

        // Q3 coords -> frame convention
        fr.x = result.pos[0];
        fr.y = -result.pos[1];
        fr.z = result.pos[2];

        fr.onGround = result.hitPlane ? (result.hitPlane[2] > 0.7) : false;
        fr.speed = Math.sqrt(((fr.x - prev.x) / dt) ** 2 + ((fr.y - prev.y) / dt) ** 2 + ((fr.z - prev.z) / dt) ** 2);

        prev = fr;
    }

    updatePath();
}

// ═══════════════════════════════════════════════════════════════════════
//  Visualisation
// ═══════════════════════════════════════════════════════════════════════
function updateVisualization() {
    if (!V.currentFrames.length) {
        // No frames — keep playerBox at spawn position (don't hide it)
        return;
    }
    const fr = V.currentFrames[V.currentFrame];
    if (!fr) return;
    const phys = frameVectors(V.currentFrame);
    const fp = V.isFirstPerson;   // first person: no player marker, arrows, ground disc or trail

    V.playerBox.visible = !fp;
    V.playerBox.position.set(fr.x, fr.z, fr.y);

    // Arrows point along +X; rotation.y = Q3 yaw (Three Z is -Q3 Y), see scene-setup.js
    // Velocity arrow, scaled with speed
    if (!fp && phys.hSpeed > 10 && (document.getElementById('showVelocity')?.checked ?? true)) {
        V.velocityArrow.visible = true;
        V.velocityArrow.position.copy(V.playerBox.position);
        V.velocityArrow.rotation.y = phys.velYaw;
        const s = Math.min(Math.max(phys.hSpeed / 400, 0.4), 3);
        V.velocityArrow.scale.set(s, s, s);
    } else V.velocityArrow.visible = false;

    // Yaw (view) arrow
    V.yawArrow.position.copy(V.playerBox.position);
    V.yawArrow.rotation.y = phys.yaw;
    V.yawArrow.visible = !fp && (document.getElementById('showYaw')?.checked ?? true);

    // Wish arrow: where this frame's keys push
    if (!fp && phys.wishYaw !== null && (document.getElementById('showWish')?.checked ?? true)) {
        V.wishArrow.visible = true;
        V.wishArrow.position.copy(V.playerBox.position);
        V.wishArrow.rotation.y = phys.wishYaw;
    } else V.wishArrow.visible = false;

    // Ground: a disc at the feet (origin is 24 above them)
    if (!fp && fr.onGround && (document.getElementById('showGround')?.checked ?? true)) {
        V.groundIndicator.position.set(fr.x, fr.z - 23, fr.y);
        V.groundIndicator.visible = true;
    } else V.groundIndicator.visible = false;

    // Trail
    if (!fp && document.getElementById('showTrail')?.checked) updateTrail(fr);
    V.trailPoints.forEach(p => { p.visible = !fp; });

    // Waypoint check
    if (V.waypointSystem) V.waypointSystem.checkWaypoint({ x: fr.x, y: fr.y, z: fr.z }, V.currentFrame);

    updateCamera(fr, phys);
    updateInfoPanel(fr, phys);
}

const EYE = 26;   // DEFAULT_VIEWHEIGHT: the eye above the player origin

// Follow: the orbit target (and the camera with it) moves onto the player, keeping the
// user's orbit angle and zoom. First person: the camera at the player's eye, looking along
// the horizontal velocity (the view yaw when barely moving); the orbit controls are off.
function updateCamera(fr, phys) {
    if (V.isFlyMode) return;
    if (V.isFirstPerson) {
        const yaw = phys.hSpeed > 10 ? phys.velYaw : phys.yaw;   // Q3 yaw: Three's z is -Q3 y
        V.camera.position.set(fr.x, fr.z + EYE, fr.y);
        V.camera.lookAt(fr.x + Math.cos(yaw), fr.z + EYE, fr.y - Math.sin(yaw));
    } else if (V.followCam) {
        const p = new THREE.Vector3(fr.x, fr.z, fr.y);
        V.camera.position.add(p.clone().sub(V.controls.target));
        V.controls.target.copy(p);
    }
}

function setFirstPerson(on) {
    if (on === V.isFirstPerson) return;
    if (on && !V.currentFrames.length) { toast('First person needs a run: load a demo or run a script / the optimizer'); return; }
    V.isFirstPerson = on;
    document.getElementById('btnFirstPerson')?.classList.toggle('active', on);
    V.controls.enabled = !on;
    if (on) {
        if (V.isFlyMode) V.flyControls.unlock();
        V.savedCam = { position: V.camera.position.clone(), target: V.controls.target.clone() };
    } else if (V.savedCam) {
        V.camera.position.copy(V.savedCam.position);
        V.controls.target.copy(V.savedCam.target);
        V.camera.lookAt(V.controls.target);
    }
    updateVisualization();   // marker / arrow visibility, and the camera (Follow re-centres on the player)
}

function updateTrail(fr) {
    if (V.trailPoints.length > 60) { const old = V.trailPoints.shift(); V.scene.remove(old); }
    const pt = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.4 }));
    pt.position.set(fr.x, fr.z, fr.y);
    V.trailPoints.push(pt); V.scene.add(pt);
    V.trailPoints.forEach((p, i) => { p.material.opacity = (i / V.trailPoints.length) * 0.4; });
}

function updatePath() {
    if (V.currentFrames.length < 2) return;
    // A new geometry each time: Line2 keeps drawing the first geometry's segment count, and
    // setPositions computes fresh bounds (stale ones got the old line frustum-culled).
    V.pathLine.geometry.dispose();
    V.pathLine.geometry = new LineGeometry().setPositions(V.currentFrames.flatMap(f => [f.x, f.z, f.y]));
    V.pathLine.visible = document.getElementById('showPath')?.checked ?? true;
}

function updateInfoPanel(fr, phys) {
    const $ = id => document.getElementById(id);
    if ($('infoFrame'))    $('infoFrame').textContent = fr.frame;
    if ($('infoSpeed'))    $('infoSpeed').textContent = `${(fr.speed ?? 0).toFixed(1)} ups`;
    // Q3 coordinates, as viewpos / scriptpos print them (frame y is -Q3 y)
    if ($('infoPosition')) $('infoPosition').textContent = `${fr.x.toFixed(1)}, ${(-fr.y).toFixed(1)}, ${fr.z.toFixed(1)}`;
    if ($('infoYaw'))      $('infoYaw').textContent = `${((((fr.yawDeg ?? 0) % 360) + 540) % 360 - 180).toFixed(1)}°`;
    if ($('infoGround'))   $('infoGround').textContent = fr.onGround ? 'Yes' : 'No';
    if ($('infoHeight'))   $('infoHeight').textContent = fr.z.toFixed(1);
    if ($('infoHSpeed'))   $('infoHSpeed').textContent = `${phys.hSpeed.toFixed(1)} ups`;
    if ($('infoTimer'))    $('infoTimer').textContent = timerText(V.currentFrame);
}

// The DeFRaG race timer at frame i: from the last frame in the start trigger, frozen at the
// first frame in the stop trigger (race-timer.js).
function timerText(i) {
    const r = V.currentRace;
    if (!r) return V.timerTriggers?.start.length || V.timerTriggers?.stop.length ? 'not started' : '-';
    if (i < r.start) return 'not started';
    if (r.stop !== null && i >= r.stop) return `${formatMs(r.ms)} (finished)`;
    return formatMs((i - Math.max(r.start, 0)) * FRAME_MS);
}

// ═══════════════════════════════════════════════════════════════════════
//  Playback
// ═══════════════════════════════════════════════════════════════════════
function setCurrentFrame(idx) {
    if (!V.currentFrames.length) return;
    V.currentFrame = Math.max(0, Math.min(idx, V.currentFrames.length - 1));
    const slider = document.getElementById('frameSlider');
    if (slider) slider.value = V.currentFrame;
    const disp = document.getElementById('frameDisplay');
    if (disp) disp.textContent = `${V.currentFrame} / ${V.currentFrames.length - 1}`;
    updateVisualization();
}

function togglePlayback() { V.isPlaying ? stopPlayback() : startPlayback(); }

// The step buttons (and arrow keys) set the play direction: paused, they also step one
// frame; playing, they turn the playback around.
function stepFrame(dir) {
    V.playDirection = dir;
    updatePlayButton();
    if (!V.isPlaying) setCurrentFrame(V.currentFrame + dir);
}

function updatePlayButton() {
    const btn = document.getElementById('btnPlay');
    if (btn) btn.textContent = V.isPlaying ? '⏸' : V.playDirection < 0 ? '◀' : '▶';
}

// Real time: 125 game frames per second × the speed selector, read every tick so a change
// applies at once. Steps through every frame (trail, waypoint checks), however many a
// display frame covers, in V.playDirection (read every tick too).
function startPlayback() {
    if (V.isPlaying || !V.currentFrames.length) return;
    const lastFrame = V.currentFrames.length - 1;
    if (V.playDirection > 0 && V.currentFrame >= lastFrame) setCurrentFrame(0);   // at the end: replay
    if (V.playDirection < 0 && V.currentFrame <= 0) setCurrentFrame(lastFrame);   // backwards from the end
    V.isPlaying = true;
    updatePlayButton();
    let last = performance.now(), due = 0;
    const tick = now => {
        if (!V.isPlaying) return;
        const speed = parseFloat(document.getElementById('playbackSpeed')?.value || '1');
        due += Math.min(now - last, 250) * 0.125 * speed;   // ms → game frames; cap a stalled tab's catch-up
        last = now;
        for (; due >= 1; due--) {
            const next = V.currentFrame + V.playDirection;
            if (next < 0 || next > V.currentFrames.length - 1) { stopPlayback(); return; }
            setCurrentFrame(next);
        }
        V.playbackFrame = requestAnimationFrame(tick);
    };
    V.playbackFrame = requestAnimationFrame(tick);
}
function stopPlayback() {
    V.isPlaying = false;
    updatePlayButton();
    if (V.playbackFrame) { cancelAnimationFrame(V.playbackFrame); V.playbackFrame = null; }
}

// ═══════════════════════════════════════════════════════════════════════
//  WASM runs (scripts, optimizer) → viewer frames
// ═══════════════════════════════════════════════════════════════════════
// inputs [{f, s, u, yaw, yawShort}] + replay {positions, velocities, onGround} in Q3 coords.
// Frame convention: x = Q3_X, y = -Q3_Y (Three.js Z), z = Q3_Z (Three.js Y)
function framesFromRun(inputs, replay) {
    return replay.positions.map((p, i) => ({
        frame: i, x: p.x, y: -p.y, z: p.z,
        vx: replay.velocities[i].x, vy: replay.velocities[i].y,   // Q3 coords, the real Pmove velocity
        speed: Math.hypot(replay.velocities[i].x, replay.velocities[i].y),
        yawDeg: inputs[i].yaw, yawShort: inputs[i].yawShort, onGround: replay.onGround[i],
        forwardMove: inputs[i].f, rightMove: inputs[i].s, upMove: inputs[i].u, buttons: 0
    }));
}

// The map's first spawn as {origin: Q3 [x, y, z], angle}, or null
function mapSpawn() {
    const spawn = findFirstSpawn(V.currentMapData?.bsp?.entities);
    return spawn ? { origin: bspLoader.parseOrigin(spawn.properties.origin), angle: parseFloat(spawn.properties.angle || '0') } : null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Load demo / script / JSON data
// ═══════════════════════════════════════════════════════════════════════
// simulated: the frames came from the WASM Pmove (real collision already applied),
// so the JS re-clip below must not overwrite their positions, speed and ground state.
// keepCamera: re-runs (optimizer, scripts, editor) leave the view where the user put it.
function loadFrames(frames, { simulated = false, keepCamera = false } = {}) {
    V.currentFrames = frames;
    V.currentFrame = 0;
    V.playerBox.visible = frames.length > 0;
    const slider = document.getElementById('frameSlider');
    if (slider) slider.max = Math.max(0, frames.length - 1);
    if (!simulated) applyCollisionsToFrames();
    V.currentRace = raceTime(frames.map(f => ({ x: f.x, y: -f.y, z: f.z })), V.timerTriggers);
    updatePath();
    setCurrentFrame(0);

    // Camera to first frame top-down (criterion 3)
    if (frames.length > 0 && !keepCamera) {
        const f = frames[0];
        V.camera.position.set(f.x, f.z + 800, f.y);
        V.camera.lookAt(f.x, f.z, f.y);
        V.controls.target.set(f.x, f.z, f.y);
        V.controls.update();
    }
}

async function handleDemoUpload(file) {
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const frames = Array.isArray(data) ? data : (data.frames || []);
        if (!frames.length) { toast('No frame data found'); return; }
        loadFrames(frames);
        toast(`Loaded ${frames.length} frames`);
    } catch (e) {
        console.error('[v2] Demo load failed', e);
        toast('Failed to parse demo file');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  cfg export for the modified oDFe (cfg-export.js)
// ═══════════════════════════════════════════════════════════════════════
function exportOpts(kind) {
    const map = V.currentMapData?.mapName || 'map';
    return { Q3: V.Q3Physics, spawn: mapSpawn(), map, name: `${map}_${kind}`.replace(/[^\w-]/g, '_'), triggers: V.timerTriggers, cpm: V.cpm };
}

// make() returns {files: [one .cfg], run}. Downloads it; returns a status line, or throws.
async function downloadExport(make) {
    if (!V.physicsReady) throw new Error('physics engine not loaded');
    const { files, run } = make();
    if (run.error) throw new Error(run.error);
    downloadFile(files[0].name, files[0].text);
    const v = run.replay.velocities.at(-1), name = files[0].name.replace(/\.cfg$/, '');
    return `Exported ${files[0].name} (in game: scriptplay ${name}): ${run.inputs.length} frames, ends at ${Math.round(Math.hypot(v.x, v.y))} ups`;
}

async function exportToStatus(el, make) {
    try {
        const msg = await downloadExport(make);
        if (el) { el.textContent = msg; el.style.color = '#aaa'; }
        toast(msg);
    } catch (e) {
        if (el) { el.textContent = `Export failed: ${e.message}`; el.style.color = '#ff6b6b'; }
        toast('Export failed');
    }
}

// " · time 0:04.328" when the run crossed the start and stop triggers, else what's missing
function raceSummary(r) {
    if (!V.timerTriggers?.start.length && !V.timerTriggers?.stop.length) return '';
    if (!r) return ' · timer not started';
    return r.ms === null ? ' · stop trigger not reached' : ` · time ${formatMs(r.ms)}`;
}

// Runs the script the way the modified oDFe executes it (movement-script.js), from the
// map spawn, on the real WASM Pmove.
function handleScriptRun() {
    const text = document.getElementById('scriptTextArea')?.value;
    if (!text?.trim()) { toast('Script is empty'); return; }
    if (!V.physicsReady) { toast('Physics engine not loaded'); return; }
    const { inputs, replay, error } = runScript(text, V.Q3Physics, mapSpawn(), V.cpm);
    const el = document.getElementById('scriptStatus');
    if (inputs.length) loadFrames(framesFromRun(inputs, replay), { simulated: true, keepCamera: true });
    const vel = replay.velocities, v = vel.at(-1);
    const jumps = vel.filter((u, i) => u.z > 200 && (i === 0 || vel[i - 1].z <= 200)).length;   // jump frames leave with vz 264
    const summary = inputs.length
        ? `${inputs.length} frames (${(inputs.length / 125).toFixed(2)} s) · ${jumps} jumps · ${Math.round(Math.hypot(v.x, v.y))} ups${raceSummary(V.currentRace)}`
        : 'no frames';
    if (el) {
        el.textContent = error ? `Error, ${error} (${summary} before it)` : summary;
        el.style.color = error ? '#ff6b6b' : '#aaa';
    }
    toast(error ? 'Script error' : `Script → ${inputs.length} frames`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Optimizer integration
// ═══════════════════════════════════════════════════════════════════════

// Runs the search in a throwaway worker (own WASM instance) so it can't freeze
// the UI. Cancel asks the worker to stop; it still returns the best route so far.
function optimizeInWorker(job, onProgress, cancelBtn) {
    const worker = new Worker(new URL('./optimizer-worker.js', import.meta.url));
    cancelBtn.onclick = () => worker.postMessage({ type: 'cancel' });
    return new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') onProgress(data);
            else if (data.type === 'done') resolve(data);
            else if (data.type === 'error') reject(new Error(data.message));
        };
        worker.onerror = e => reject(new Error(e.message || 'Optimizer worker failed to load'));
        worker.postMessage({ type: 'run', ...job });
    }).finally(() => worker.terminate());
}

async function runOptimizer() {
    if (!V.physicsReady) { toast('Physics engine not available'); return; }
    // Start where a script starts in game: the map spawn, landed. No spawn: waypoint 1.
    // With DeFRaG timer triggers the route can end in the stop trigger, and it's ranked by race time.
    const spawn = mapSpawn();
    const triggers = V.timerTriggers ?? { start: [], checkpoints: [], stop: [] };
    const finish = !!spawn && triggers.stop.length > 0 && !!document.getElementById('optFinish')?.checked;
    const minWps = finish ? 0 : spawn ? 1 : 2;
    if (!V.waypointSystem || V.waypointSystem.waypoints.length < minWps) {
        toast(spawn ? 'Place at least 1 waypoint (or tick "Finish in the stop trigger")' : 'No spawn in this map: place at least 2 waypoints');
        return;
    }
    const missing = V.waypointSystem.missingNumbers();
    if (missing.length) toast(`Warning: waypoint ${missing.join(', ')} missing, the route skips that number`);
    // The optimizer counts waypoints by position (1..n); show their numbers instead.
    const wpNumber = i => V.waypointSystem.waypoints[i - 1]?.number ?? i;

    const statusEl = document.getElementById('optimizerStatus');
    const fillEl = document.getElementById('optimizerProgressFill');
    const cancelBtn = document.getElementById('btnCancelOptimizer');
    const runBtn = document.getElementById('btnRunOptimizer');

    runBtn.style.display = 'none';
    cancelBtn.style.display = '';

    if (statusEl) statusEl.textContent = 'Running…';
    if (fillEl) fillEl.style.width = '0%';

    try {
        const nWps = V.waypointSystem.waypoints.length;
        const { inputs, replay, jumps, reached, totalSeg, first, cancelled } = await optimizeInWorker(
            {
                // Plain copies: live waypoints reference THREE meshes, which can't be cloned to a worker.
                waypoints: V.waypointSystem.waypoints.map(w => ({ position: w.position, radius: w.radius, height: w.height })),
                spawn,
                cpm: V.cpm,
                race: triggers.start.length || triggers.stop.length ? { ...triggers, finish } : null,
                rawBsp: V.currentMapData?.rawBsp
            },
            ({ seg, totalSeg, wp, step, total, workers }) => {
                const pct = ((seg / totalSeg) + (step / total / totalSeg)) * 100;
                if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
                if (statusEl) statusEl.textContent = `${wp === 'finish' ? 'Stop trigger' : `Waypoint ${wpNumber(wp)} (${wp}/${nWps})`} · candidate ${step}/${total}${workers > 1 ? ` · ${workers} workers` : ''}`;
            },
            cancelBtn
        );
        if (!inputs.length) {
            const target = first > nWps ? 'The stop trigger' : `Waypoint ${wpNumber(first)}`;
            if (statusEl) statusEl.textContent = cancelled ? 'Cancelled'
                : `${target} unreachable from ${first === 1 ? 'the spawn' : `waypoint ${wpNumber(1)}`}`;
            return;
        }

        // The worker's continuous replay from the start is the optimized path.
        const frames = framesFromRun(inputs, replay);
        loadFrames(frames, { simulated: true, keepCamera: true });
        const ups = Math.round(frames.at(-1).speed);
        const summary = `${frames.length} frames · ${jumps} jumps · ${ups} ups${raceSummary(V.currentRace)}`;
        if (statusEl) statusEl.textContent = reached < totalSeg
            ? `Reached ${reached}/${totalSeg} targets${cancelled ? ' (cancelled)' : ''} — ${summary}`
            : `Done — ${summary}`;
        if (fillEl) fillEl.style.width = '100%';
        V.lastRoute = inputs;
        document.getElementById('btnExportRoute').style.display = '';
        toast(`Optimizer → ${summary}`);
    } catch (e) {
        console.error('[v2] Optimizer failed', e);
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
    } finally {
        runBtn.style.display = '';
        cancelBtn.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Frame Editor
// ═══════════════════════════════════════════════════════════════════════
function toggleFrameEditor() {
    V.isFrameEditorMode = !V.isFrameEditorMode;
    document.getElementById('btnFrameEditor')?.classList.toggle('active', V.isFrameEditorMode);
    if (V.isFrameEditorMode) {
        if (!V.physicsReady) { toast('Physics not loaded'); V.isFrameEditorMode = false; return; }
        showFrameEditorUI();
    } else {
        document.getElementById('frameEditorPanel')?.remove();
    }
}

function showFrameEditorUI() {
    if (document.getElementById('frameEditorPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'frameEditorPanel';
    panel.innerHTML = `
        <h3>Frame Editor</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
            <label><input type="checkbox" id="chkForward"> Forward</label>
            <label><input type="checkbox" id="chkBack"> Back</label>
            <label><input type="checkbox" id="chkLeft"> Left</label>
            <label><input type="checkbox" id="chkRight"> Right</label>
        </div>
        <div style="margin-bottom:10px">
            <label>Yaw: <span id="yawValue">0</span>°</label>
            <input type="range" id="yawSlider" min="-180" max="180" value="0" step="0.1" style="width:100%">
        </div>
        <label style="margin-bottom:10px;display:block"><input type="checkbox" id="jumpCheck"> Jump</label>
        <label>Frames: <input type="number" id="frameCountInput" value="1" min="1" max="200" style="width:100%"></label>
        <div style="display:flex;gap:6px;margin:10px 0"><button id="btnAddFrame" style="flex:1">Add</button><button id="btnInsertFrame" style="flex:1">Insert</button><button id="btnDeleteFrame" style="flex:1">Delete</button></div>
        <div style="display:flex;gap:6px;margin-bottom:10px"><button id="btnUndo">↶ Undo</button><button id="btnRedo">↷ Redo</button></div>
        <div style="display:flex;gap:6px"><button id="btnExportCfg">Export .cfg</button><button id="btnExportJSON">Export JSON</button></div>
        <div id="editorStats" style="font-size:12px;color:#aaa;margin-top:10px"><div>Frames: <span id="feFrameCount">0</span></div><div>Max Speed: <span id="feMaxSpeed">0 ups</span></div></div>`;
    document.getElementById('viewerRoot').appendChild(panel);

    const getInput = () => {
        const fwd = document.getElementById('chkForward').checked, bk = document.getElementById('chkBack').checked;
        const lt = document.getElementById('chkLeft').checked, rt = document.getElementById('chkRight').checked;
        const yaw = parseFloat(document.getElementById('yawSlider').value) || 0;
        const jump = document.getElementById('jumpCheck').checked;
        // Jump = upmove 10 (PM_CheckJump's minimum, full wishspeed; what cl_scriptRun sends), no buttons
        return { forwardMove: fwd && !bk ? 127 : (!fwd && bk ? -127 : 0), rightMove: rt && !lt ? 127 : (!rt && lt ? -127 : 0), upMove: jump ? 10 : 0, angles: [0, yaw, 0], buttons: 0 };
    };
    const count = () => { const v = parseInt(document.getElementById('frameCountInput').value); return Math.max(1, Math.min(200, isFinite(v) ? v : 1)); };

    document.getElementById('yawSlider').addEventListener('input', e => { document.getElementById('yawValue').textContent = parseFloat(e.target.value).toFixed(1); });
    document.getElementById('btnAddFrame').addEventListener('click', () => { const inp = getInput(); for (let i = 0; i < count(); i++) V.frameEditor.addFrame({...inp, angles:[...inp.angles]}); updateEditorViz(); });
    document.getElementById('btnInsertFrame').addEventListener('click', () => { const inp = getInput(); for (let i = 0; i < count(); i++) V.frameEditor.insertFrame(V.currentFrame+i, {...inp, angles:[...inp.angles]}); updateEditorViz(); });
    document.getElementById('btnDeleteFrame').addEventListener('click', () => { V.frameEditor.deleteFrame(V.currentFrame); updateEditorViz(); });
    document.getElementById('btnUndo').addEventListener('click', () => { V.frameEditor.undo(); updateEditorViz(); });
    document.getElementById('btnRedo').addEventListener('click', () => { V.frameEditor.redo(); updateEditorViz(); });
    // Baked: the editor frames' exact moves and yaw shorts, replayed from the landed spawn like in game
    document.getElementById('btnExportCfg').addEventListener('click', () =>
        exportToStatus(null, () => exportBaked(V.frameEditor.toInputs(), exportOpts('editor'))));
    document.getElementById('btnExportJSON').addEventListener('click', () => downloadFile('movement.json', V.frameEditor.exportToJSON()));
}

function updateEditorViz() {
    // FrameEditor stores Q3 coords; convert to frame convention: y = -Q3_Y
    const frames = V.frameEditor.frames.map(f => ({
        frame: f.index, x: f.stateAfter.pos.x, y: -f.stateAfter.pos.y, z: f.stateAfter.pos.z,
        vx: f.stateAfter.vel.x, vy: f.stateAfter.vel.y,
        speed: Math.hypot(f.stateAfter.vel.x, f.stateAfter.vel.y),
        yawDeg: f.stateAfter.angles.yaw, onGround: f.stateAfter.onGround,
        forwardMove: f.input.forwardMove, rightMove: f.input.rightMove, upMove: f.input.upMove, buttons: f.input.buttons
    }));
    loadFrames(frames, { simulated: true, keepCamera: true });
    const fc = document.getElementById('feFrameCount'); if (fc) fc.textContent = frames.length;
    const ms = document.getElementById('feMaxSpeed'); if (ms) ms.textContent = (frames.reduce((m,f) => Math.max(m, f.speed), 0)).toFixed(1) + ' ups';
}

// ═══════════════════════════════════════════════════════════════════════
//  Controls wiring
// ═══════════════════════════════════════════════════════════════════════
function setupViewerControls() {
    // Playback
    document.getElementById('frameSlider')?.addEventListener('input', e => setCurrentFrame(parseInt(e.target.value)));
    document.getElementById('btnFirst')?.addEventListener('click', () => setCurrentFrame(0));
    document.getElementById('btnPrev')?.addEventListener('click', () => stepFrame(-1));
    document.getElementById('btnPlay')?.addEventListener('click', togglePlayback);
    document.getElementById('btnNext')?.addEventListener('click', () => stepFrame(1));
    document.getElementById('btnLast')?.addEventListener('click', () => setCurrentFrame(V.currentFrames.length - 1));

    // Viz toggles
    ['showPath','showVelocity','showYaw','showWish','showGround','showTrail'].forEach(id =>
        document.getElementById(id)?.addEventListener('change', updateVisualization));
    ['showSpawns','showTriggers','showItems'].forEach(id =>
        document.getElementById(id)?.addEventListener('change', updateEntityVisibility));
    document.getElementById('showMap')?.addEventListener('change', e => { if (V.mapMesh) V.mapMesh.visible = e.target.checked; });

    // Camera
    document.getElementById('btnFollowCam')?.addEventListener('click', () => {
        V.followCam = !V.followCam;
        document.getElementById('btnFollowCam')?.classList.toggle('active', V.followCam);
        if (V.followCam) updateVisualization();
    });
    document.getElementById('btnFirstPerson')?.addEventListener('click', () => setFirstPerson(!V.isFirstPerson));
    // Preset views leave first person first (registered before their own handlers, so this runs first)
    ['resetCamera', 'topView', 'sideView'].forEach(id =>
        document.getElementById(id)?.addEventListener('click', () => setFirstPerson(false)));
    document.getElementById('resetCamera')?.addEventListener('click', () => {
        const spawn = findFirstSpawn(V.currentMapData?.bsp?.entities);
        if (spawn) {
            const o = bspLoader.parseOrigin(spawn.properties.origin);
            const pos = new THREE.Vector3(o[0], o[2], -o[1]);
            V.camera.position.set(pos.x, pos.y + 800, pos.z);
            V.controls.target.copy(pos);
        } else { V.camera.position.set(500, 500, 500); V.controls.target.set(0, 0, 0); }
        V.controls.update();
    });
    document.getElementById('topView')?.addEventListener('click', () => {
        if (!V.currentFrames.length) return;
        const f = V.currentFrames[V.currentFrame];
        V.camera.position.set(f.x, f.z + 800, f.y);
        V.controls.target.set(f.x, f.z, f.y);
        V.controls.update();
    });
    document.getElementById('sideView')?.addEventListener('click', () => {
        if (!V.currentFrames.length) return;
        const f = V.currentFrames[V.currentFrame];
        V.camera.position.set(f.x + 500, f.z + 200, f.y);
        V.controls.target.set(f.x, f.z, f.y);
        V.controls.update();
    });

    // Map brightness
    const bSlider = document.getElementById('brightnessSlider'), bVal = document.getElementById('brightnessValue');
    bSlider?.addEventListener('input', e => { bVal.textContent = e.target.value; updateBrightness(parseInt(e.target.value) / 100); });
    document.getElementById('resetBrightness')?.addEventListener('click', () => { if (bSlider) { bSlider.value = 100; bVal.textContent = '100'; } updateBrightness(1); });

    // Wireframe
    document.getElementById('toggleWireframe')?.addEventListener('click', () => {
        if (!V.mapMesh || !V.currentMapData) return;
        V.isWireframeMode = !V.isWireframeMode;
        V.scene.remove(V.mapMesh);
        V.mapMesh.traverse(c => {
            if (c.isMesh) {
                c.geometry.dispose();
                (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
            }
        });
        V.mapMesh = bspLoader.buildMapGroup(V.currentMapData, V.isWireframeMode);
        V.scene.add(V.mapMesh);
    });

    // Top bar actions
    document.getElementById('btnLoadNewMap')?.addEventListener('click', () => {
        document.getElementById('viewerRoot').style.display = 'none';
        document.getElementById('uploadGate').style.display = '';
    });
    document.getElementById('btnLoadDemo')?.addEventListener('click', () => document.getElementById('demoFileInput')?.click());
    document.getElementById('demoFileInput')?.addEventListener('change', e => { if (e.target.files[0]) handleDemoUpload(e.target.files[0]); e.target.value = ''; });
    document.getElementById('btnLoadScript')?.addEventListener('click', () => document.getElementById('scriptFileInput')?.click());
    document.getElementById('scriptFileInput')?.addEventListener('change', async e => {
        if (e.target.files[0]) {
            const text = await e.target.files[0].text();
            const ta = document.getElementById('scriptTextArea');
            if (ta) ta.value = text;
            if (!V.isScriptEditorOpen) toggleScriptEditor();
            handleScriptRun();
        }
        e.target.value = '';
    });

    // Frame editor
    document.getElementById('btnFrameEditor')?.addEventListener('click', toggleFrameEditor);

    // Waypoint editor
    document.getElementById('btnWaypointEditor')?.addEventListener('click', () => {
        if (!V.waypointSystem) return;
        V.isWaypointMode = V.waypointSystem.toggleEditMode();
        document.getElementById('btnWaypointEditor')?.classList.toggle('active', V.isWaypointMode);
        document.getElementById('waypointPanel').style.display = V.isWaypointMode ? '' : 'none';
        if (V.isWaypointMode) V.renderer.domElement.style.cursor = 'crosshair';
        else { V.renderer.domElement.style.cursor = ''; selectWaypoint(null); }
    });
    // Waypoint mode: a quick click without moving places (left) or deletes (middle) a waypoint;
    // holding or dragging is left to the camera controls.
    const canvas = V.renderer?.domElement;
    let press = null;
    canvas?.addEventListener('pointerdown', e => { press = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button }; });
    canvas?.addEventListener('mousedown', e => { if (e.button === 1 && V.isWaypointMode) e.preventDefault(); });   // no middle-click autoscroll
    const isClick = e => press && press.button === e.button && performance.now() - press.t < 300
        && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5;
    // After every change: the count, a warning for gaps in the numbering, and the next free number.
    const wpNumberEl = document.getElementById('waypointNumber');
    const showWaypointCount = () => {
        const ws = V.waypointSystem;
        const el = document.getElementById('waypointTotal');
        if (el) el.textContent = ws?.waypoints.length ?? 0;
        const missing = ws?.missingNumbers() ?? [];
        const warn = document.getElementById('waypointWarning');
        if (warn) {
            warn.textContent = missing.length ? `⚠ Missing waypoint ${missing.join(', ')}` : '';
            warn.style.display = missing.length ? '' : 'none';
        }
        if (wpNumberEl && ws) wpNumberEl.value = ws.nextFreeNumber();
        const sel = ws?.selectedWaypoint, selEl = document.getElementById('waypointSelected');
        if (selEl) {
            selEl.textContent = sel ? `Editing waypoint ${sel.number}: radius and height change it live (Esc: done)` : '';
            selEl.style.display = sel ? '' : 'none';
        }
    };
    const radiusEl = document.getElementById('waypointRadius'), heightEl = document.getElementById('waypointHeight');
    const readSize = () => ({ radius: Number(radiusEl?.value ?? 32), height: Number(heightEl?.value ?? 0) });
    const sizeError = ({ radius, height }) => !(radius >= 4) ? 'Waypoint radius must be 4 or more'
        : !(height >= 0) ? 'Waypoint height must be 0 or more' : null;
    // Select a waypoint to edit (null: done): the inputs show its size and change it live.
    // Done puts back the size they had for the next new waypoint.
    let nextSize = null;
    const selectWaypoint = wp => {
        if (wp && !V.waypointSystem.selectedWaypoint) nextSize = { radius: radiusEl.value, height: heightEl.value };
        V.waypointSystem.select(wp);
        if (wp) { radiusEl.value = wp.radius; heightEl.value = wp.height; }
        else if (nextSize) { radiusEl.value = nextSize.radius; heightEl.value = nextSize.height; nextSize = null; }
        showWaypointCount();
    };
    // Click a ball: edit it (again: done). Elsewhere: done editing, or place the next waypoint.
    canvas?.addEventListener('click', e => {
        if (!V.isWaypointMode || !V.waypointSystem || !isClick(e)) return;
        const ws = V.waypointSystem, hit = ws.pickAt(e, V.camera);
        if (hit || ws.selectedWaypoint) { selectWaypoint(hit === ws.selectedWaypoint ? null : hit); return; }
        const n = Number(wpNumberEl?.value), size = readSize();
        if (!Number.isInteger(n) || n < 1) { toast('Waypoint number must be a whole number, 1 or more'); return; }
        if (sizeError(size)) { toast(sizeError(size)); return; }
        if (ws.has(n)) { toast(`Waypoint ${n} already exists`); return; }
        if (ws.handleClick(e, V.camera, n, size.radius, size.height)) showWaypointCount();
    });
    // Typing a radius / height resizes the selected waypoint at once (invalid values wait)
    [radiusEl, heightEl].forEach(el => el?.addEventListener('input', () => {
        const wp = V.waypointSystem?.selectedWaypoint, size = readSize();
        if (wp && !sizeError(size)) V.waypointSystem.resize(wp, size.radius, size.height);
    }));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && V.waypointSystem?.selectedWaypoint) selectWaypoint(null);
    });
    canvas?.addEventListener('auxclick', e => {
        if (e.button !== 1 || !V.isWaypointMode || !V.waypointSystem || !isClick(e)) return;
        const n = V.waypointSystem.deleteAt(e, V.camera);
        if (n >= 0) { showWaypointCount(); toast(`Waypoint ${n} deleted`); }
    });
    document.getElementById('btnResetWaypoints')?.addEventListener('click', () => V.waypointSystem?.resetWaypoints());
    document.getElementById('btnClearWaypoints')?.addEventListener('click', () => { V.waypointSystem?.clearAllWaypoints(); showWaypointCount(); });

    // Script editor
    document.getElementById('btnScriptEditor')?.addEventListener('click', toggleScriptEditor);
    document.getElementById('btnRunScript')?.addEventListener('click', handleScriptRun);
    document.getElementById('btnClearScript')?.addEventListener('click', () => { const ta = document.getElementById('scriptTextArea'); if (ta) ta.value = ''; });
    const scriptText = () => document.getElementById('scriptTextArea')?.value?.trim() ? document.getElementById('scriptTextArea').value : null;
    const scriptStatusEl = () => document.getElementById('scriptStatus');
    document.getElementById('btnExportScript')?.addEventListener('click', () => {
        const text = scriptText();
        if (!text) { toast('Script is empty'); return; }
        exportToStatus(scriptStatusEl(), () => exportScript(text, exportOpts('script')));
    });
    document.getElementById('btnExportScriptBaked')?.addEventListener('click', () => {
        const text = scriptText();
        if (!text) { toast('Script is empty'); return; }
        exportToStatus(scriptStatusEl(), () => {
            const opts = exportOpts('baked'), run = runScript(text, opts.Q3, opts.spawn, opts.cpm);
            return run.error ? { files: [], run } : exportBaked(run.inputs, opts);
        });
    });
    document.getElementById('btnExportRoute')?.addEventListener('click', () => {
        if (!V.lastRoute?.length) { toast('Run the optimizer first'); return; }
        exportToStatus(document.getElementById('optimizerStatus'), () => exportBaked(V.lastRoute, exportOpts('route')));
    });

    // Physics: everything run from now on (scripts, optimizer, frame editor, exports) uses it.
    // The last route was optimized for the other physics, so it can't be exported any more.
    document.getElementById('physicsMode')?.addEventListener('change', e => {
        V.cpm = e.target.value === 'cpm';
        V.Q3Physics?._SetPromode(V.cpm ? 1 : 0);
        V.lastRoute = null;
        document.getElementById('btnExportRoute').style.display = 'none';
        toast(V.cpm ? 'Physics: CPM (df_promode 1), run again to apply' : 'Physics: VQ3, run again to apply');
    });

    // Stats: hand the loaded run to the statistics dashboard (stats.html) through localStorage
    document.getElementById('btnStats')?.addEventListener('click', () => {
        if (!V.currentFrames.length) { toast('No run to show: load a demo, or run a script or the optimizer'); return; }
        try {
            localStorage.setItem('q3StatsRun', JSON.stringify({ name: `${V.currentMapData?.mapName || 'map'} run`, frames: V.currentFrames }));
        } catch { toast('Run too large to hand to the dashboard'); return; }
        window.open('../stats.html?run=viewer', '_blank');
    });

    // Optimizer
    document.getElementById('btnOptimize')?.addEventListener('click', toggleOptimizer);
    document.getElementById('btnRunOptimizer')?.addEventListener('click', runOptimizer);

    // Keyboard
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

        // Fly mode movement keys (same behavior pattern as test-map-viewer)
        if (V.isFlyMode) {
            switch (e.code) {
                case 'KeyW': V.moveForward = true; return;
                case 'KeyS': V.moveBackward = true; return;
                case 'KeyA': V.moveLeft = true; return;
                case 'KeyD': V.moveRight = true; return;
                case 'Space': e.preventDefault(); V.moveUp = true; return;
                case 'ShiftLeft':
                case 'ShiftRight': V.moveDown = true; return;
            }
        }

        switch (e.key) {
            case 'ArrowLeft': e.preventDefault(); stepFrame(-1); break;
            case 'ArrowRight': e.preventDefault(); stepFrame(1); break;
            case ' ': e.preventDefault(); togglePlayback(); break;
            case 'Home': e.preventDefault(); setCurrentFrame(0); break;
            case 'End': e.preventDefault(); setCurrentFrame(V.currentFrames.length - 1); break;
            case 'f':
            case 'F':
                if (V.isFlyMode) V.flyControls.unlock();
                else { setFirstPerson(false); V.flyControls.lock(); }
                break;
            case 'Enter':
                // Enter already activates a focused button/select; don't also grab the mouse.
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') break;
                if (!V.isFlyMode) { setFirstPerson(false); V.flyControls.lock(); }
                break;
        }
    });

    document.addEventListener('keyup', e => {
        if (!V.isFlyMode) return;
        switch (e.code) {
            case 'KeyW': V.moveForward = false; break;
            case 'KeyS': V.moveBackward = false; break;
            case 'KeyA': V.moveLeft = false; break;
            case 'KeyD': V.moveRight = false; break;
            case 'Space': V.moveUp = false; break;
            case 'ShiftLeft':
            case 'ShiftRight': V.moveDown = false; break;
        }
    });

    document.addEventListener('wheel', e => {
        if (!V.isFlyMode) return;
        e.preventDefault();
        V.moveSpeed += e.deltaY > 0 ? -2 : 2;
        V.moveSpeed = Math.max(1, Math.min(100, V.moveSpeed));
    }, { passive: false });

    // Load demo from localStorage if available
    const stored = localStorage.getItem('q3DemoData');
    if (stored) {
        try {
            const data = JSON.parse(stored);
            if (Array.isArray(data) && data.length) loadFrames(data);
        } catch { /* ignore */ }
    }
}

function toggleScriptEditor() {
    V.isScriptEditorOpen = !V.isScriptEditorOpen;
    document.getElementById('btnScriptEditor')?.classList.toggle('active', V.isScriptEditorOpen);
    document.getElementById('scriptEditorPanel').style.display = V.isScriptEditorOpen ? '' : 'none';
    // Hide legend when script editor is open (they share bottom-right)
    if (V.isScriptEditorOpen) document.getElementById('legendPanel').style.display = 'none';
    else document.getElementById('legendPanel').style.display = '';
}

function toggleOptimizer() {
    V.isOptimizerOpen = !V.isOptimizerOpen;
    document.getElementById('btnOptimize')?.classList.toggle('active', V.isOptimizerOpen);
    document.getElementById('optimizerPanel').style.display = V.isOptimizerOpen ? '' : 'none';
}

function updateBrightness(multiplier) {
    V.currentBrightness = multiplier;
    if (V.ambientLight) V.ambientLight.intensity = 0.6 * multiplier;
    if (V.directionalLight) V.directionalLight.intensity = 0.8 * multiplier;
    if (V.mapMesh) {
        V.mapMesh.traverse(child => {
            // Skip sky meshes (MeshBasicMaterial, no emissive) and non-meshes
            if (!child.isMesh || child.userData.isSky) return;
            const mat = child.material;
            if (mat && mat.emissive !== undefined) {
                if (multiplier > 1) {
                    mat.emissive = new THREE.Color(0xffffff);
                    mat.emissiveIntensity = (multiplier - 1) * 0.3;
                } else {
                    mat.emissive = new THREE.Color(0);
                    mat.emissiveIntensity = 0;
                }
                mat.needsUpdate = true;
            }
        });
    }
    if (V.renderer) V.renderer.toneMappingExposure = multiplier;
}

function animate() {
    requestAnimationFrame(animate);
    if (V.isFlyMode && V.flyControls.isLocked) {
        if (V.moveForward)  V.flyControls.moveForward(V.moveSpeed);
        if (V.moveBackward) V.flyControls.moveForward(-V.moveSpeed);
        if (V.moveLeft)     V.flyControls.moveRight(-V.moveSpeed);
        if (V.moveRight)    V.flyControls.moveRight(V.moveSpeed);
        if (V.moveUp)       V.camera.position.y += V.moveSpeed;
        if (V.moveDown)     V.camera.position.y -= V.moveSpeed;
    } else {
        // OrbitControls.update() forces the camera to look at its target every
        // frame, which would override PointerLockControls mouse-look and the first
        // person view. Only run it when neither is on.
        if (!V.isFirstPerson) V.controls?.update();
    }
    V.renderer?.render(V.scene, V.camera);
}

// ═══════════════════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════════════════
window.addEventListener('load', async () => {
    await initQ3Physics();
    setupUploadGate();
});

// Expose for external use
window.setCurrentFrame = setCurrentFrame;
window.togglePlayback = togglePlayback;
window.updateVisualization = updateVisualization;
