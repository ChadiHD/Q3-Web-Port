#include <emscripten.h>
#include <string.h>
#include <math.h>

// oDFe includes
#define GAME_INCLUDE
#include "odfe/q_shared.h"
#include "odfe/bg_public.h"

// Simplified structures for JavaScript interop
typedef struct {
    float origin[3];
    float velocity[3];
    float viewangles[3];
    int groundEntityNum;
    int pm_flags;
    int pm_time;
    int commandTime;
} JSPlayerState;

typedef struct {
    int serverTime;
    int forwardmove;   // -127 to 127
    int rightmove;     // -127 to 127
    int upmove;        // 0 or 200
    float angles[3];   // pitch, yaw, roll
    int buttons;       // BUTTON_JUMP = 2
} JSUserCmd;

// Forward-declare the stubs defined in browser_stubs.c
void trap_Trace(trace_t *results, const vec3_t start, const vec3_t mins,
                const vec3_t maxs, const vec3_t end, int passEntityNum, int contentmask);
int trap_PointContents(const vec3_t point, int passEntityNum);

// Global physics state
static pmove_t pm;
static playerState_t ps;
static usercmd_t cmd;

// Wrapper callbacks matching the pmove_t function-pointer signatures
static void PM_Trace(trace_t *results, const vec3_t start, const vec3_t mins,
                     const vec3_t maxs, const vec3_t end, int passEntityNum, int contentMask) {
    trap_Trace(results, start, mins, maxs, end, passEntityNum, contentMask);
}

static int PM_PointContents(const vec3_t point, int passEntityNum) {
    return trap_PointContents(point, passEntityNum);
}

// Initialize physics module
EMSCRIPTEN_KEEPALIVE
void InitPhysics() {
    memset(&pm, 0, sizeof(pm));
    memset(&ps, 0, sizeof(ps));
    memset(&cmd, 0, sizeof(cmd));
    
    // Set default values
    ps.pm_type = PM_NORMAL;
    ps.gravity = 800;
    ps.speed = 320;

    // Wire up the trace/pointcontents callbacks so Pmove doesn't call NULL
    pm.trace = PM_Trace;
    pm.pointcontents = PM_PointContents;
    
    printf("[oDFe WASM] Physics initialized\n");
}

// Convert JavaScript state to oDFe playerState_t
static void JSToPlayerState(const JSPlayerState* js, playerState_t* ps) {
    VectorCopy(js->origin, ps->origin);
    VectorCopy(js->velocity, ps->velocity);
    VectorCopy(js->viewangles, ps->viewangles);
    ps->groundEntityNum = js->groundEntityNum;
    ps->pm_flags = js->pm_flags;
    ps->pm_time = js->pm_time;
    ps->commandTime = js->commandTime;
}

// Convert oDFe playerState_t to JavaScript state
static void PlayerStateToJS(const playerState_t* ps, JSPlayerState* js) {
    VectorCopy(ps->origin, js->origin);
    VectorCopy(ps->velocity, js->velocity);
    VectorCopy(ps->viewangles, js->viewangles);
    js->groundEntityNum = ps->groundEntityNum;
    js->pm_flags = ps->pm_flags;
    js->pm_time = ps->pm_time;
    js->commandTime = ps->commandTime;
}

// Simulate one physics frame using oDFe
// Renamed from PmoveSingle to avoid collision with oDFe's PmoveSingle(pmove_t*)
EMSCRIPTEN_KEEPALIVE
void StepPhysics(
    float* pos,        // [x, y, z]
    float* vel,        // [vx, vy, vz]
    float* angles,     // [pitch, yaw, roll]
    int forwardmove,   // -127 to 127
    int rightmove,     // -127 to 127
    int upmove,        // 0 or 200
    int buttons,       // 2 = jump
    float frametime    // 0.008 for 125 FPS
) {
    // Setup player state
    VectorCopy(pos, ps.origin);
    VectorCopy(vel, ps.velocity);
    VectorCopy(angles, ps.viewangles);
    
    // Setup command
    cmd.forwardmove = forwardmove;
    cmd.rightmove = rightmove;
    cmd.upmove = upmove;
    cmd.buttons = buttons;
    cmd.serverTime = ps.commandTime + (int)(frametime * 1000.0f);
    
    // Convert angles to command angles (short format)
    cmd.angles[0] = ANGLE2SHORT(angles[0]);
    cmd.angles[1] = ANGLE2SHORT(angles[1]);
    cmd.angles[2] = ANGLE2SHORT(angles[2]);
    
    // Setup pmove structure
    pm.ps = &ps;
    pm.cmd = cmd;
    pm.tracemask = MASK_PLAYERSOLID;
    pm.debugLevel = qfalse;
    pm.noFootsteps = qtrue;
    pm.trace = PM_Trace;
    pm.pointcontents = PM_PointContents;
    
    // Run oDFe physics (THE REAL DEAL!)
    Pmove(&pm);
    
    // Copy results back
    VectorCopy(ps.origin, pos);
    VectorCopy(ps.velocity, vel);
    VectorCopy(ps.viewangles, angles);
}

// Get player ground status
EMSCRIPTEN_KEEPALIVE
int IsPlayerOnGround() {
    return ps.groundEntityNum != ENTITYNUM_NONE;
}

// Get horizontal speed
EMSCRIPTEN_KEEPALIVE
float GetHorizontalSpeed() {
    return sqrt(ps.velocity[0] * ps.velocity[0] + 
                ps.velocity[1] * ps.velocity[1]);
}

// Set physics parameters
EMSCRIPTEN_KEEPALIVE
void SetPlayerSpeed(float speed) {
    ps.speed = (int)speed;
}

EMSCRIPTEN_KEEPALIVE
void SetGravity(float gravity) {
    ps.gravity = (int)gravity;
}

// Get current position
EMSCRIPTEN_KEEPALIVE
float* GetPlayerPosition() {
    return ps.origin;
}

// Get current velocity
EMSCRIPTEN_KEEPALIVE
float* GetPlayerVelocity() {
    return ps.velocity;
}

// Get current angles
EMSCRIPTEN_KEEPALIVE
float* GetPlayerAngles() {
    return ps.viewangles;
}

// Simulate multiple frames (for optimization)
EMSCRIPTEN_KEEPALIVE
void SimulateFrames(
    float* initialPos,
    float* initialVel,
    float* initialAngles,
    int* commands,     // Array of packed commands [fwd, str, up, buttons] * numFrames
    int numFrames,
    float* outPositions  // Output: [x,y,z] * numFrames
) {
    // Initialize state
    VectorCopy(initialPos, ps.origin);
    VectorCopy(initialVel, ps.velocity);
    VectorCopy(initialAngles, ps.viewangles);
    
    float frametime = 0.008f; // 125 FPS
    
    for (int i = 0; i < numFrames; i++) {
        int idx = i * 4;
        
        // Unpack command
        cmd.forwardmove = commands[idx + 0];
        cmd.rightmove = commands[idx + 1];
        cmd.upmove = commands[idx + 2];
        cmd.buttons = commands[idx + 3];
        cmd.serverTime = ps.commandTime + 8; // 8ms per frame
        
        // Run physics
        pm.ps = &ps;
        pm.cmd = cmd;
        pm.tracemask = MASK_PLAYERSOLID;
        pm.trace = PM_Trace;
        pm.pointcontents = PM_PointContents;
        Pmove(&pm);
        
        // Store position
        int outIdx = i * 3;
        outPositions[outIdx + 0] = ps.origin[0];
        outPositions[outIdx + 1] = ps.origin[1];
        outPositions[outIdx + 2] = ps.origin[2];
    }
}