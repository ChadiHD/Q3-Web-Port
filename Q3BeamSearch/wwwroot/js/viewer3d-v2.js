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
import { PLAYER_PHYSICS_BOUNDS } from './collision-detection.js';
import { bspLoader } from './bsp-loader.js';
import { slideMove } from './slide-move.js';
import { V } from './viewer-state.js';
import { q3YawToThree } from './q3-math.js';
import { toast, downloadFile } from './ui-utils.js';
import { initThreeJS } from './scene-setup.js';
import { renderMap, findFirstSpawn, updateEntityVisibility } from './map-render.js';


// ═══════════════════════════════════════════════════════════════════════
//  Q3 WASM initialisation (mandatory — no fallback)
// ═══════════════════════════════════════════════════════════════════════
async function initQ3Physics() {
    try {
        V.Q3Physics = await Q3PhysicsModule();
        V.Q3Physics.ccall('InitPhysics', null, [], []);
        V.Q3Physics.ccall('SetPlayerSpeed', null, ['number'], [320]);
        V.Q3Physics.ccall('SetGravity', null, ['number'], [800]);
        V.physicsReady = true;
        console.log('[v2] oDFe WASM physics ready');
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
        setUploadStatus('Map loaded ✓', 'ok');
        setTimeout(() => transitionToViewer(), 400);
    } catch (err) {
        console.error('[v2] Map load failed', err);
        setUploadStatus('Failed: ' + err.message, 'error');
    }
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
    stopPlayback();
    V.currentFrames = [];
    V.currentFrame = 0;
    if (V.playerSphere) V.playerSphere.visible = false;
    V.trailPoints.forEach(p => V.scene.remove(p));
    V.trailPoints = [];
    if (V.pathGeometry) V.pathGeometry.setFromPoints([]);
    if (V.pathLine) V.pathLine.visible = false;

    const slider = document.getElementById('frameSlider');
    if (slider) { slider.value = 0; slider.max = 0; }
    const disp = document.getElementById('frameDisplay');
    if (disp) disp.textContent = '0 / 0';

    renderMap(V.currentMapData);
}

// ═══════════════════════════════════════════════════════════════════════
//  Q3 physics helpers (no fallback — requires WASM)
// ═══════════════════════════════════════════════════════════════════════
function computePhysics(frameIndex) {
    if (!V.physicsReady || frameIndex < 1 || frameIndex >= V.currentFrames.length) {
        return { hSpeed: 0, velAngle: 0, wishAngle: 0, efficiency: 0 };
    }
    const prev = V.currentFrames[frameIndex - 1], cur = V.currentFrames[frameIndex];
    const dt = 1/125;
    const vx = (cur.x - prev.x) / dt, vy = (cur.y - prev.y) / dt;
    const hSpeed = Math.sqrt(vx*vx + vy*vy);
    const velAngle = Math.atan2(vy, vx);
    const wishAngle = velAngle + Math.PI / 6;
    const wishDeg = wishAngle * 180 / Math.PI;
    const velDeg = velAngle * 180 / Math.PI;
    const diff = Math.abs(((wishDeg - velDeg + 180) % 360) - 180);
    let eff = 0;
    if (diff <= 45) { eff = Math.max(0, 100 - (Math.abs(diff-30)/45)*100); if (!cur.onGround) eff = Math.min(100, eff * 1.2); }
    return { hSpeed, velAngle, wishAngle, efficiency: eff };
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
        // No frames — keep playerSphere at spawn position (don't hide it)
        return;
    }
    const fr = V.currentFrames[V.currentFrame];
    if (!fr) return;
    const phys = computePhysics(V.currentFrame);

    V.playerSphere.visible = true;
    V.playerSphere.position.set(fr.x, fr.z, fr.y);

    // Velocity arrow
    if (phys.hSpeed > 10 && (document.getElementById('showVelocity')?.checked ?? true)) {
        V.velocityArrow.visible = true;
        V.velocityArrow.position.copy(V.playerSphere.position);
        V.velocityArrow.rotation.y = q3YawToThree(phys.velAngle);
        const s = Math.min(Math.max(phys.hSpeed / 400, 0.4), 3);
        V.velocityArrow.scale.set(s, s, s);
    } else V.velocityArrow.visible = false;

    // Yaw arrow
    const yawRad = fr.yawDeg * Math.PI / 180;
    V.yawArrow.position.copy(V.playerSphere.position);
    V.yawArrow.rotation.y = q3YawToThree(yawRad);
    V.yawArrow.visible = document.getElementById('showYaw')?.checked ?? true;

    // Wish arrow
    if (phys.hSpeed > 10 && (document.getElementById('showWish')?.checked ?? true)) {
        V.wishArrow.visible = true;
        V.wishArrow.position.copy(V.playerSphere.position);
        V.wishArrow.rotation.y = q3YawToThree(phys.wishAngle);
    } else V.wishArrow.visible = false;

    // Ground
    if (fr.onGround && (document.getElementById('showGround')?.checked ?? true)) {
        V.groundIndicator.position.set(fr.x, fr.z - 10, fr.y);
        V.groundIndicator.visible = true;
    } else V.groundIndicator.visible = false;

    // Trail
    if (document.getElementById('showTrail')?.checked) updateTrail(fr);

    // Waypoint check
    if (V.waypointSystem) V.waypointSystem.checkWaypoint({ x: fr.x, y: fr.y, z: fr.z }, V.currentFrame);

    updateInfoPanel(fr, phys);
}

function updateTrail(fr) {
    if (V.trailPoints.length > 60) { const old = V.trailPoints.shift(); V.scene.remove(old); }
    const pt = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.4 }));
    pt.position.set(fr.x, fr.z, fr.y);
    V.trailPoints.push(pt); V.scene.add(pt);
    V.trailPoints.forEach((p, i) => { p.material.opacity = (i / V.trailPoints.length) * 0.4; });
}

function updatePath() {
    if (!V.currentFrames.length) return;
    V.pathGeometry.setFromPoints(V.currentFrames.map(f => new THREE.Vector3(f.x, f.z, f.y)));
    V.pathLine.visible = document.getElementById('showPath')?.checked ?? true;
}

function updateInfoPanel(fr, phys) {
    const $ = id => document.getElementById(id);
    if ($('infoFrame'))    $('infoFrame').textContent = fr.frame;
    if ($('infoSpeed'))    $('infoSpeed').textContent = `${(fr.speed ?? 0).toFixed(1)} ups`;
    if ($('infoPosition')) $('infoPosition').textContent = `${fr.x.toFixed(1)}, ${fr.y.toFixed(1)}, ${fr.z.toFixed(1)}`;
    if ($('infoYaw'))      $('infoYaw').textContent = `${fr.yawDeg.toFixed(1)}°`;
    if ($('infoGround'))   $('infoGround').textContent = fr.onGround ? 'Yes' : 'No';
    if ($('infoHeight'))   $('infoHeight').textContent = fr.z.toFixed(1);
    if ($('infoHSpeed'))   $('infoHSpeed').textContent = `${phys.hSpeed.toFixed(1)} ups`;
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
function startPlayback() {
    if (V.isPlaying || !V.currentFrames.length) return;
    V.isPlaying = true;
    const btn = document.getElementById('btnPlay'); if (btn) btn.textContent = '⏸';
    const speed = parseFloat(document.getElementById('playbackSpeed')?.value || '1');
    V.playbackInterval = setInterval(() => {
        if (V.currentFrame >= V.currentFrames.length - 1) { stopPlayback(); return; }
        setCurrentFrame(V.currentFrame + 1);
    }, Math.max(16, 1000 / (125 * speed)));
}
function stopPlayback() {
    V.isPlaying = false;
    const btn = document.getElementById('btnPlay'); if (btn) btn.textContent = '⏯';
    if (V.playbackInterval) { clearInterval(V.playbackInterval); V.playbackInterval = null; }
}

// ═══════════════════════════════════════════════════════════════════════
//  Movement script parser (Q3 cfg format → frames via WASM)
// ═══════════════════════════════════════════════════════════════════════
function parseMovementScript(text) {
    if (!V.physicsReady) { toast('Physics engine not loaded'); return []; }

    // Reset WASM physics state to clear stale pm_flags (e.g. PMF_JUMP_HELD from a
    // previous run), otherwise jumping and other state-dependent behaviours break
    // on second and subsequent script executions.
    const Q3 = V.Q3Physics;
    Q3.ccall('InitPhysics', null, [], []);
    Q3.ccall('SetPlayerSpeed', null, ['number'], [320]);
    Q3.ccall('SetGravity', null, ['number'], [800]);

    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    const frames = [];

    let forward = false, back = false, moveleft = false, moveright = false;
    let turnLeft = false, turnRight = false;
    let moveup = false, movedown = false;
    let yawSpeed = 140;

    const posPtr = Q3._malloc(12), velPtr = Q3._malloc(12), angPtr = Q3._malloc(12);
    const spawn = findFirstSpawn(V.currentMapData?.bsp?.entities);
    const spawnOrigin = spawn ? bspLoader.parseOrigin(spawn.properties.origin) : [0, 0, 0];
    const spawnAngle = spawn ? parseFloat(spawn.properties.angle || '0') : 0;

    Q3.HEAPF32.set(spawnOrigin, posPtr >> 2);
    Q3.HEAPF32.set([0, 0, 0], velPtr >> 2);
    Q3.HEAPF32.set([0, spawnAngle, 0], angPtr >> 2);

    function emitFrames(count) {
        for (let i = 0; i < count; i++) {
            let fwd = 0;
            if (forward && !back) fwd = 127;
            else if (back && !forward) fwd = -127;
            let str = 0;
            if (moveright && !moveleft) str = 127;
            else if (moveleft && !moveright) str = -127;
            let up = moveup ? 200 : (movedown ? -200 : 0);
            const buttons = moveup ? 2 : 0;

            const curYaw = Q3.HEAPF32[(angPtr >> 2) + 1];
            let newYaw = curYaw;
            if (turnLeft) newYaw += yawSpeed / 125;
            if (turnRight) newYaw -= yawSpeed / 125;
            Q3.HEAPF32[(angPtr >> 2) + 1] = newYaw;

            Q3.ccall('StepPhysics', null,
                ['number','number','number','number','number','number','number','number'],
                [posPtr, velPtr, angPtr, fwd, str, up, buttons, 0.008]);

            const p = Q3.HEAPF32.subarray(posPtr >> 2, (posPtr >> 2) + 3);
            const v = Q3.HEAPF32.subarray(velPtr >> 2, (velPtr >> 2) + 3);
            const a = Q3.HEAPF32.subarray(angPtr >> 2, (angPtr >> 2) + 3);
            const onGround = Q3.ccall('IsPlayerOnGround', 'number', [], []) === 1;
            const speed = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);

            // Frame convention: x = Q3_X, y = -Q3_Y (Three.js Z), z = Q3_Z (Three.js Y)
            frames.push({
                frame: frames.length,
                x: p[0], y: -p[1], z: p[2],
                speed, yawDeg: a[1], onGround,
                forwardMove: fwd, rightMove: str, upMove: up, buttons
            });
        }
    }

    for (const rawLine of lines) {
        const cmds = rawLine.split(';').map(c => c.trim()).filter(Boolean);
        for (const cmd of cmds) {
            const lower = cmd.toLowerCase();
            if (lower === '+forward')        forward = true;
            else if (lower === '-forward')   forward = false;
            else if (lower === '+back')      back = true;
            else if (lower === '-back')      back = false;
            else if (lower === '+moveleft')  moveleft = true;
            else if (lower === '-moveleft')  moveleft = false;
            else if (lower === '+moveright') moveright = true;
            else if (lower === '-moveright') moveright = false;
            else if (lower === '+moveup')    moveup = true;
            else if (lower === '-moveup')    moveup = false;
            else if (lower === '+movedown')  movedown = true;
            else if (lower === '-movedown')  movedown = false;
            else if (lower === '+left')      turnLeft = true;
            else if (lower === '-left')      turnLeft = false;
            else if (lower === '+right')     turnRight = true;
            else if (lower === '-right')     turnRight = false;
            else if (lower.startsWith('cl_yawspeed') || lower.startsWith('seta cl_yawspeed')) {
                const parts = cmd.split(/\s+/);
                const val = parseFloat(parts[parts.length - 1]);
                if (isFinite(val)) yawSpeed = val;
            }
            else if (lower.startsWith('wait')) {
                const parts = cmd.split(/\s+/);
                // In Q3, bare `wait` = 1 game frame; `wait N` = N frames at 125 Hz.
                // Previously this was halved (/ 2) which caused too few frames and
                // the player never reaching 320 ups.
                const waitVal = parseInt(parts[1]) || 1;
                emitFrames(Math.max(1, waitVal));
            }
        }
    }

    Q3._free(posPtr); Q3._free(velPtr); Q3._free(angPtr);
    return frames;
}

// ═══════════════════════════════════════════════════════════════════════
//  Load demo / script / JSON data
// ═══════════════════════════════════════════════════════════════════════
function loadFrames(frames) {
    V.currentFrames = frames;
    V.currentFrame = 0;
    V.playerSphere.visible = frames.length > 0;
    const slider = document.getElementById('frameSlider');
    if (slider) slider.max = Math.max(0, frames.length - 1);
    applyCollisionsToFrames();
    updatePath();
    setCurrentFrame(0);

    // Camera to first frame top-down (criterion 3)
    if (frames.length > 0) {
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

function handleScriptRun() {
    const text = document.getElementById('scriptTextArea')?.value;
    if (!text?.trim()) { toast('Script is empty'); return; }
    const frames = parseMovementScript(text);
    if (frames.length === 0) { toast('Script produced no frames'); return; }
    loadFrames(frames);
    const el = document.getElementById('scriptStatus');
    if (el) el.textContent = `Generated ${frames.length} frames (${(frames.length / 125).toFixed(2)}s)`;
    toast(`Script → ${frames.length} frames`);
}

// ═══════════════════════════════════════════════════════════════════════
//  Optimizer integration
// ═══════════════════════════════════════════════════════════════════════
async function runOptimizer() {
    if (!V.optimizer) { toast('Physics engine not available'); return; }
    if (!V.waypointSystem || V.waypointSystem.waypoints.length < 2) { toast('Place at least 2 waypoints'); return; }

    const algo = document.getElementById('optimizerAlgo')?.value || 'de';
    const maxFrames = parseInt(document.getElementById('optimizerMaxFrames')?.value) || 250;
    const targetJumps = parseInt(document.getElementById('optimizerTargetJumps')?.value) || 3;
    const iters = parseInt(document.getElementById('optimizerIters')?.value) || 60;

    const statusEl = document.getElementById('optimizerStatus');
    const fillEl = document.getElementById('optimizerProgressFill');
    const cancelBtn = document.getElementById('btnCancelOptimizer');
    const runBtn = document.getElementById('btnRunOptimizer');

    runBtn.style.display = 'none';
    cancelBtn.style.display = '';
    cancelBtn.onclick = () => V.optimizer.cancel();

    if (statusEl) statusEl.textContent = 'Running…';
    if (fillEl) fillEl.style.width = '0%';

    try {
        const inputs = await V.optimizer.optimizeFullRoute(
            V.waypointSystem.waypoints,
            algo,
            { maxFrames, targetJumps, generations: iters, maxEvals: iters * 10 },
            (seg, totalSeg, step, total, score) => {
                const pct = ((seg / totalSeg) + (step / total / totalSeg)) * 100;
                if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
                if (statusEl) statusEl.textContent = `Seg ${seg+1}/${totalSeg} step ${step}/${total} score=${score?.toFixed(1) ?? '?'}`;
            }
        );

        if (statusEl) statusEl.textContent = `Done — ${inputs.length} frames`;
        if (fillEl) fillEl.style.width = '100%';

        // Convert optimizer inputs → frame data via WASM simulation
        const spawn = findFirstSpawn(V.currentMapData?.bsp?.entities);
        const spawnOrigin = spawn ? bspLoader.parseOrigin(spawn.properties.origin) : [0, 0, 0];
        const result = V.optimizer.simulateRoute(spawnOrigin, [0,0,0], 0, inputs);
        // Frame convention: x = Q3_X, y = -Q3_Y (Three.js Z), z = Q3_Z (Three.js Y)
        const frames = result.positions.map((p, i) => ({
            frame: i, x: p.x, y: -p.y, z: p.z,
            speed: 0, yawDeg: 0, onGround: true,
            forwardMove: inputs[i]?.fwd * 127 || 0,
            rightMove: inputs[i]?.str * 127 || 0,
            upMove: inputs[i]?.jump ? 200 : 0,
            buttons: inputs[i]?.jump ? 2 : 0
        }));
        loadFrames(frames);
        toast(`Optimizer → ${frames.length} frames`);
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
        return { forwardMove: fwd && !bk ? 127 : (!fwd && bk ? -127 : 0), rightMove: rt && !lt ? 127 : (!rt && lt ? -127 : 0), upMove: jump ? 200 : 0, angles: [0, yaw, 0], buttons: jump ? 2 : 0 };
    };
    const count = () => { const v = parseInt(document.getElementById('frameCountInput').value); return Math.max(1, Math.min(200, isFinite(v) ? v : 1)); };

    document.getElementById('yawSlider').addEventListener('input', e => { document.getElementById('yawValue').textContent = parseFloat(e.target.value).toFixed(1); });
    document.getElementById('btnAddFrame').addEventListener('click', () => { const inp = getInput(); for (let i = 0; i < count(); i++) V.frameEditor.addFrame({...inp, angles:[...inp.angles]}); updateEditorViz(); });
    document.getElementById('btnInsertFrame').addEventListener('click', () => { const inp = getInput(); for (let i = 0; i < count(); i++) V.frameEditor.insertFrame(V.currentFrame+i, {...inp, angles:[...inp.angles]}); updateEditorViz(); });
    document.getElementById('btnDeleteFrame').addEventListener('click', () => { V.frameEditor.deleteFrame(V.currentFrame); updateEditorViz(); });
    document.getElementById('btnUndo').addEventListener('click', () => { V.frameEditor.undo(); updateEditorViz(); });
    document.getElementById('btnRedo').addEventListener('click', () => { V.frameEditor.redo(); updateEditorViz(); });
    document.getElementById('btnExportCfg').addEventListener('click', () => downloadFile('movement.cfg', V.frameEditor.exportToCfg()));
    document.getElementById('btnExportJSON').addEventListener('click', () => downloadFile('movement.json', V.frameEditor.exportToJSON()));
}

function updateEditorViz() {
    // FrameEditor stores Q3 coords; convert to frame convention: y = -Q3_Y
    const frames = V.frameEditor.frames.map(f => ({
        frame: f.index, x: f.stateAfter.pos.x, y: -f.stateAfter.pos.y, z: f.stateAfter.pos.z,
        speed: Math.sqrt(f.stateAfter.vel.x**2 + f.stateAfter.vel.y**2 + f.stateAfter.vel.z**2),
        yawDeg: f.stateAfter.angles.yaw, onGround: f.stateAfter.onGround,
        forwardMove: f.input.forwardMove, rightMove: f.input.rightMove, upMove: f.input.upMove, buttons: f.input.buttons
    }));
    loadFrames(frames);
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
    document.getElementById('btnPrev')?.addEventListener('click', () => setCurrentFrame(V.currentFrame - 1));
    document.getElementById('btnPlay')?.addEventListener('click', togglePlayback);
    document.getElementById('btnNext')?.addEventListener('click', () => setCurrentFrame(V.currentFrame + 1));
    document.getElementById('btnLast')?.addEventListener('click', () => setCurrentFrame(V.currentFrames.length - 1));

    // Viz toggles
    ['showPath','showVelocity','showYaw','showWish','showGround','showTrail'].forEach(id =>
        document.getElementById(id)?.addEventListener('change', updateVisualization));
    ['showSpawns','showTriggers','showItems'].forEach(id =>
        document.getElementById(id)?.addEventListener('change', updateEntityVisibility));
    document.getElementById('showMap')?.addEventListener('change', e => { if (V.mapMesh) V.mapMesh.visible = e.target.checked; });

    // Camera
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
        else V.renderer.domElement.style.cursor = '';
    });
    V.renderer?.domElement?.addEventListener('click', e => { if (V.isWaypointMode && V.waypointSystem) V.waypointSystem.handleClick(e, V.camera); });
    document.getElementById('btnResetWaypoints')?.addEventListener('click', () => V.waypointSystem?.resetWaypoints());
    document.getElementById('btnClearWaypoints')?.addEventListener('click', () => V.waypointSystem?.clearAllWaypoints());
    document.getElementById('btnExportWaypoints')?.addEventListener('click', () => { if (V.waypointSystem) downloadFile('waypoints.json', V.waypointSystem.exportToJSON()); });
    document.getElementById('btnImportWaypoints')?.addEventListener('click', () => document.getElementById('waypointImportInput')?.click());
    document.getElementById('waypointImportInput')?.addEventListener('change', async e => {
        if (e.target.files[0] && V.waypointSystem) {
            const text = await e.target.files[0].text();
            V.waypointSystem.importFromJSON(text);
        }
        e.target.value = '';
    });

    // Script editor
    document.getElementById('btnScriptEditor')?.addEventListener('click', toggleScriptEditor);
    document.getElementById('btnRunScript')?.addEventListener('click', handleScriptRun);
    document.getElementById('btnClearScript')?.addEventListener('click', () => { const ta = document.getElementById('scriptTextArea'); if (ta) ta.value = ''; });
    document.getElementById('btnExportScript')?.addEventListener('click', () => {
        const text = document.getElementById('scriptTextArea')?.value;
        if (text) downloadFile('movement.cfg', text);
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
            case 'ArrowLeft': e.preventDefault(); setCurrentFrame(V.currentFrame - 1); break;
            case 'ArrowRight': e.preventDefault(); setCurrentFrame(V.currentFrame + 1); break;
            case ' ': e.preventDefault(); togglePlayback(); break;
            case 'Home': e.preventDefault(); setCurrentFrame(0); break;
            case 'End': e.preventDefault(); setCurrentFrame(V.currentFrames.length - 1); break;
            case 'f':
            case 'F':
                if (V.isFlyMode) V.flyControls.unlock();
                else V.flyControls.lock();
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
        // frame, which would override PointerLockControls mouse-look. Only run
        // it when fly mode is OFF.
        V.controls?.update();
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
