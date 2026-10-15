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
    currentFrames: [], currentFrame: 0, isPlaying: false, playbackFrame: null,
    playDirection: 1,      // +1 forward, -1 backward: the last step button pressed

    // Camera modes
    followCam: true,       // orbit target stays on the player
    isFirstPerson: false,  // camera at the player's eye, looking along the velocity
    savedCam: null,        // orbit camera before first person, restored after

    // Map
    mapMesh: null, isWireframeMode: false, currentMapData: null, currentBrightness: 1.0,

    // Lights
    ambientLight: null, directionalLight: null,

    // 3D helpers
    playerBox: null, pathLine: null, pathMaterial: null,
    velocityArrow: null, yawArrow: null, wishArrow: null, groundIndicator: null,
    gridHelper: null, axesHelper: null,
    trailPoints: [],

    // Entities
    spawnObjects: [], triggerObjects: [], itemObjects: [],

    // Subsystems
    collisionSystem: new BSPCollisionSystem(),
    frameEditor: null,
    waypointSystem: null,
    isFrameEditorMode: false,
    isWaypointMode: false,
    isScriptEditorOpen: false,
    isOptimizerOpen: false,
    lastRoute: null,   // inputs of the last optimizer route, for its cfg export
    cpm: false,        // physics: CPM (DeFRaG df_promode 1) instead of VQ3, from the Physics menu
    timerTriggers: null,   // DeFRaG start / checkpoint / stop trigger boxes (race-timer.js)
    currentRace: null,     // raceTime() of the loaded frames

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
