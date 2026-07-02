// wwwroot/js/viewer-state.js
// Central mutable state for the Q3 TAS Viewer v2.
// All modules import this single object and read/write V.<field> so scene
// setup, map rendering, playback and controls share the same live state.

import { BSPCollisionSystem } from './collision-detection.js';

export const V = {
    // Core Three.js
    scene: null, camera: null, renderer: null, controls: null, clock: null,

    // Physics (WASM)
    Q3Physics: null, physicsReady: false,

    // Playback
    currentFrames: [], currentFrame: 0, isPlaying: false, playbackInterval: null,

    // Map
    mapMesh: null, isWireframeMode: false, currentMapData: null, currentBrightness: 1.0,

    // Lights
    ambientLight: null, directionalLight: null,

    // 3D helpers
    playerSphere: null, pathLine: null, pathGeometry: null, pathMaterial: null,
    velocityArrow: null, yawArrow: null, wishArrow: null, groundIndicator: null,
    gridHelper: null, axesHelper: null,
    trailPoints: [],

    // Entities
    spawnObjects: [], triggerObjects: [], itemObjects: [],

    // Subsystems
    collisionSystem: new BSPCollisionSystem(),
    frameEditor: null,
    waypointSystem: null,
    optimizer: null,
    isFrameEditorMode: false,
    isWaypointMode: false,
    isScriptEditorOpen: false,
    isOptimizerOpen: false,

    isViewerInitialized: false,

    // Fly movement (PointerLockControls — same as test-map-viewer)
    moveForward: false,
    moveBackward: false,
    moveLeft: false,
    moveRight: false,
    moveUp: false,
    moveDown: false,
    moveSpeed: 10,
    isFlyMode: false,
    flyControls: null,
};
