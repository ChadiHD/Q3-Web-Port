// wwwroot/js/scene-setup.js
// One-time Three.js scene/camera/renderer/controls construction, player
// visualisation objects, and subsystem creation. Reads/writes shared state (V).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { FrameEditor } from './frame-editor.js';
import { WaypointSystem } from './waypoint-system.js';
import { WaypointOptimizer } from './waypoint-optimizer.js';
import { V } from './viewer-state.js';
import { toast } from './ui-utils.js';

export function initThreeJS() {
    V.scene = new THREE.Scene();
    V.scene.background = new THREE.Color(0x111111);
    V.scene.fog = new THREE.Fog(0x111111, 2000, 12000);

    V.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 20000);
    V.renderer = new THREE.WebGLRenderer({ antialias: true });
    V.renderer.setSize(window.innerWidth, window.innerHeight);
    V.renderer.shadowMap.enabled = true;
    V.renderer.outputColorSpace = THREE.SRGBColorSpace;
    V.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    V.renderer.toneMappingExposure = 1;
    document.getElementById('threejs-container').appendChild(V.renderer.domElement);

    V.controls = new OrbitControls(V.camera, V.renderer.domElement);
    V.controls.enableDamping = true;
    V.controls.dampingFactor = 0.05;
    V.controls.minDistance = 10;
    V.controls.maxDistance = 8000;

    // PointerLockControls for first-person fly mode (WASD + mouse look)
    V.flyControls = new PointerLockControls(V.camera, document.body);
    V.scene.add(V.flyControls.getObject());

    V.flyControls.addEventListener('lock', () => {
        V.isFlyMode = true;
        V.controls.enabled = false;
        V.renderer.domElement.style.cursor = 'none';
        toast('Fly mode ON — WASD: move, Space/Shift: up/down, Wheel: speed, F or ESC: exit');
    });

    V.flyControls.addEventListener('unlock', () => {
        V.isFlyMode = false;
        V.controls.enabled = true;
        V.renderer.domElement.style.cursor = '';
        V.moveForward = V.moveBackward = V.moveLeft = V.moveRight = V.moveUp = V.moveDown = false;
        // Re-anchor OrbitControls target in front of the camera so it doesn't
        // snap back to the old orbit target when fly mode ends.
        const dir = new THREE.Vector3();
        V.camera.getWorldDirection(dir);
        V.controls.target.copy(V.camera.position).addScaledVector(dir, 200);
        V.controls.update();
    });

    // Click on the 3D canvas to enter fly mode
    V.renderer.domElement.addEventListener('click', () => {
        if (!V.isFlyMode) V.flyControls.lock();
    });

    V.ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    V.scene.add(V.ambientLight);
    V.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    V.directionalLight.position.set(1000, 1000, 500);
    V.directionalLight.castShadow = true;
    V.scene.add(V.directionalLight);

    V.gridHelper = new THREE.GridHelper(2000, 50, 0x444444, 0x222222);
    V.gridHelper.visible = false;
    V.scene.add(V.gridHelper);
    V.axesHelper = new THREE.AxesHelper(200);
    V.axesHelper.visible = false;
    V.scene.add(V.axesHelper);

    V.clock = new THREE.Clock();
    createPlayerObjects();
    window.addEventListener('resize', () => {
        V.camera.aspect = window.innerWidth / window.innerHeight;
        V.camera.updateProjectionMatrix();
        V.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Subsystems
    if (V.physicsReady) {
        V.frameEditor = new FrameEditor(V.Q3Physics);
        V.frameEditor.setCollisionSystem(V.collisionSystem.isReady() ? V.collisionSystem : null);
        V.optimizer = new WaypointOptimizer(V.Q3Physics);
    }
    V.waypointSystem = new WaypointSystem(V.scene, V.mapMesh);
}

function createPlayerObjects() {
    V.playerSphere = new THREE.Mesh(
        new THREE.SphereGeometry(8, 16, 16),
        new THREE.MeshPhongMaterial({ color: 0xff6b6b, emissive: 0x220000, shininess: 80 })
    );
    V.playerSphere.visible = false;
    V.scene.add(V.playerSphere);

    V.pathGeometry = new THREE.BufferGeometry();
    V.pathMaterial = new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.8 });
    V.pathLine = new THREE.Line(V.pathGeometry, V.pathMaterial);
    V.scene.add(V.pathLine);

    V.velocityArrow = createArrowGroup(0x4caf50); V.scene.add(V.velocityArrow);
    V.yawArrow = createArrowGroup(0xff9800); V.scene.add(V.yawArrow);
    V.wishArrow = createArrowGroup(0x9c27b0); V.scene.add(V.wishArrow);

    V.groundIndicator = new THREE.Mesh(
        new THREE.CylinderGeometry(15, 15, 2, 16),
        new THREE.MeshPhongMaterial({ color: 0xf44336, transparent: true, opacity: 0.7 })
    );
    V.scene.add(V.groundIndicator);
}

function createArrowGroup(color) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1,1,50,8), new THREE.MeshPhongMaterial({ color }));
    shaft.rotation.z = -Math.PI/2; shaft.position.x = 25; g.add(shaft);
    const head = new THREE.Mesh(new THREE.ConeGeometry(4,10,8), new THREE.MeshPhongMaterial({ color }));
    head.rotation.z = -Math.PI/2; head.position.x = 55; g.add(head);
    g.visible = false;
    return g;
}
