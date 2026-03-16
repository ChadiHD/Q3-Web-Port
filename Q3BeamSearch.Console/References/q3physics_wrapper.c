// Minimal Q3 Physics WebAssembly Wrapper
#include <stdint.h>
#include <math.h>
#include <string.h>

// Basic types
typedef float vec3_t[3];
typedef int qboolean;
#define qtrue 1
#define qfalse 0

// Player state structure (simplified)
typedef struct {
    vec3_t origin;
    vec3_t velocity;
    vec3_t viewangles;
    int groundEntityNum;
    int pm_flags;
    int pm_type;
    float speed;
    int commandTime;
    int pm_time;
    int gravity;
} playerState_t;

// User command structure  
typedef struct {
    int serverTime;
    int forwardmove;
    int rightmove;
    int upmove;
    int angles[3];
    int buttons;
} usercmd_t;

// Physics constants
#define PM_NORMAL 0
#define PM_DEAD 3
#define PMF_JUMP_HELD 2
#define PMF_TIME_KNOCKBACK 64
#define BUTTON_JUMP 2
#define ENTITYNUM_NONE -1
#define JUMP_VELOCITY 270

// Physics parameters
static float pm_stopspeed = 100.0f;
static float pm_friction = 6.0f;
static float pm_accelerate = 10.0f;
static float pm_airaccelerate = 1.0f;
static float pm_wateraccelerate = 4.0f;
static float pm_flyaccelerate = 8.0f;
static float pm_waterfriction = 1.0f;
static float pm_flightfriction = 3.0f;
static float pm_spectatorfriction = 5.0f;

// Global physics state
static playerState_t g_ps;
static usercmd_t g_cmd;

static float g_speed = 320.0f;
static int g_gravity = 800;

static float pm_frametime = 0.008f; // 125 FPS

// Vector math functions
static float VectorLength(const vec3_t v) {
    return sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

static void VectorCopy(const vec3_t in, vec3_t out) {
    out[0] = in[0]; out[1] = in[1]; out[2] = in[2];
}

static void VectorScale(const vec3_t in, float scale, vec3_t out) {
    out[0] = in[0] * scale;
    out[1] = in[1] * scale;
    out[2] = in[2] * scale;
}

static float DotProduct(const vec3_t v1, const vec3_t v2) {
    return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

static void VectorNormalize(vec3_t v) {
    float length = VectorLength(v);
    if (length > 0) {
        v[0] /= length;
        v[1] /= length;
        v[2] /= length;
    }
}

// Simplified physics functions
static void PM_Friction(void) {
    vec3_t vec;
    float speed, newspeed, control, drop;

    VectorCopy(pm_ps->velocity, vec);
    vec[2] = 0; // ignore vertical movement for friction

    speed = VectorLength(vec);
    if (speed < 1) {
        pm_ps->velocity[0] = 0;
        pm_ps->velocity[1] = 0;
        return;
    }

    drop = 0;

    // Apply ground friction
    if (pm_ps->groundEntityNum != ENTITYNUM_NONE) {
        control = speed < pm_stopspeed ? pm_stopspeed : speed;
        drop += control * pm_friction * pm_frametime;
    }

    // Scale velocity
    newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    if (speed > 0) {
        newspeed /= speed;
        pm_ps->velocity[0] *= newspeed;
        pm_ps->velocity[1] *= newspeed;
        pm_ps->velocity[2] *= newspeed;
    }
}

static void PM_Accelerate(vec3_t wishdir, float wishspeed, float accel) {
    float addspeed, accelspeed, currentspeed;

    currentspeed = DotProduct(pm_ps->velocity, wishdir);
    addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) return;

    accelspeed = accel * pm_frametime * wishspeed;
    if (accelspeed > addspeed) accelspeed = addspeed;

    pm_ps->velocity[0] += accelspeed * wishdir[0];
    pm_ps->velocity[1] += accelspeed * wishdir[1];
    pm_ps->velocity[2] += accelspeed * wishdir[2];
}

static qboolean PM_CheckJump(void) {
    if (pm_cmd->upmove < 10) return qfalse;
    if (pm_ps->pm_flags & PMF_JUMP_HELD) {
        pm_cmd->upmove = 0;
        return qfalse;
    }

    pm_ps->pm_flags |= PMF_JUMP_HELD;
    pm_ps->groundEntityNum = ENTITYNUM_NONE;
    pm_ps->velocity[2] = JUMP_VELOCITY;
    return qtrue;
}

static void PM_AirMove(void) {
    vec3_t wishvel, wishdir;
    float wishspeed, scale;

    PM_Friction();

    scale = pm_ps->speed / 127.0f;

    // Calculate wish direction
    wishvel[0] = pm_cmd->forwardmove * scale;
    wishvel[1] = pm_cmd->rightmove * scale;
    wishvel[2] = 0;

    VectorCopy(wishvel, wishdir);
    wishspeed = VectorLength(wishdir);
    VectorNormalize(wishdir);

    PM_Accelerate(wishdir, wishspeed, pm_airaccelerate);
}

static void PM_WalkMove(void) {
    vec3_t wishvel, wishdir;
    float wishspeed, scale;

    if (PM_CheckJump()) {
        PM_AirMove();
        return;
    }

    PM_Friction();

    scale = pm_ps->speed / 127.0f;

    // Calculate wish direction
    wishvel[0] = pm_cmd->forwardmove * scale;
    wishvel[1] = pm_cmd->rightmove * scale;
    wishvel[2] = 0;

    VectorCopy(wishvel, wishdir);
    wishspeed = VectorLength(wishdir);
    VectorNormalize(wishdir);

    PM_Accelerate(wishdir, wishspeed, pm_accelerate);
}

static void PM_GroundTrace(void) {
    // Simple ground check - if Z position <= 24, player is on ground
    if (pm_ps->origin[2] <= 24.0f) {
        pm_ps->origin[2] = 24.0f;
        if (pm_ps->velocity[2] < 0) {
            pm_ps->velocity[2] = 0;
        }
        pm_ps->groundEntityNum = 0;
    }
    else {
        pm_ps->groundEntityNum = ENTITYNUM_NONE;
    }
}

// Public API functions
void PmoveSingle(playerState_t* ps, usercmd_t* cmd) {
    pm_ps = ps;
    pm_cmd = cmd;

    // Clear jump flag if not holding jump
    if (cmd->upmove < 10) {
        ps->pm_flags &= ~PMF_JUMP_HELD;
    }

    // Apply gravity
    if (ps->groundEntityNum == ENTITYNUM_NONE) {
        ps->velocity[2] -= ps->gravity * pm_frametime;
    }

    // Ground trace
    PM_GroundTrace();

    // Movement
    if (ps->groundEntityNum != ENTITYNUM_NONE) {
        PM_WalkMove();
    }
    else {
        PM_AirMove();
    }

    // Update position
    ps->origin[0] += ps->velocity[0] * pm_frametime;
    ps->origin[1] += ps->velocity[1] * pm_frametime;
    ps->origin[2] += ps->velocity[2] * pm_frametime;

    // Update command time
    ps->commandTime = cmd->serverTime;
}

// Helper functions for WebAssembly
void SetPlayerSpeed(float speed) {
    g_speed = speed;
    g_ps.speed = speed;
}

void SetGravity(int gravity) {
    g_gravity = gravity;
    g_ps.gravity = gravity;
}

void GetPlayerPosition(float* x, float* y, float* z) {
    if (pm_ps) {
        *x = pm_ps->origin[0];
        *y = pm_ps->origin[1];
        *z = pm_ps->origin[2];
    }
}

void GetPlayerVelocity(float* x, float* y, float* z) {
    if (pm_ps) {
        *x = pm_ps->velocity[0];
        *y = pm_ps->velocity[1];
        *z = pm_ps->velocity[2];
    }
}

float GetPlayerHorizontalSpeed(void) {
    if (pm_ps) {
        return sqrtf(pm_ps->velocity[0] * pm_ps->velocity[0] +
            pm_ps->velocity[1] * pm_ps->velocity[1]);
    }
    return 0.0f;
}

// Q3-style cmd scaling so diagonals don't exceed max speed
static float PM_CmdScale(const usercmd_t* cmd, float speed) {
    int f = cmd->forwardmove;
    int r = cmd->rightmove;
    int u = cmd->upmove;

    int af = f < 0 ? -f : f;
    int ar = r < 0 ? -r : r;
    int au = u < 0 ? -u : u;

    int max = af;
    if (ar > max) max = ar;
    if (au > max) max = au;
    if (max == 0) return 0.0f;

    float total = sqrtf((float)(f*f + r*r + u*u));
    if (total <= 0.0f) return 0.0f;

    return speed * (float)max / (127.0f * total);
}

// Rotate local (forward/right) into world XY using yaw degrees
static void YawToAxes(float yawDeg, vec3_t fwd, vec3_t right) {
    float yaw = yawDeg * (float)M_PI / 180.0f;
    float sy = sinf(yaw), cy = cosf(yaw);
    fwd[0] = cy;  fwd[1] = sy;  fwd[2] = 0.0f;
    right[0] = -sy; right[1] = cy; right[2] = 0.0f;
}

// Replace your wishvel build to use cmdScale + yaw rotation
// (Call this from PM_WalkMove / PM_AirMove instead of direct forwardmove/rightmove scaling)
static void BuildWishVel(vec3_t outWishVel) {
    float cmdScale = PM_CmdScale(pm_cmd, pm_ps->speed);

    vec3_t fwd, right;
    YawToAxes(pm_ps->viewangles[1], fwd, right);

    // local moves -> world wishvel
    outWishVel[0] = (fwd[0] * (pm_cmd->forwardmove * cmdScale)) + (right[0] * (pm_cmd->rightmove * cmdScale));
    outWishVel[1] = (fwd[1] * (pm_cmd->forwardmove * cmdScale)) + (right[1] * (pm_cmd->rightmove * cmdScale));
    outWishVel[2] = 0.0f;
}

// --- Flat exported API (no JS struct packing) ---
EMSCRIPTEN_KEEPALIVE
void InitPlayerState(float x, float y, float z, float vx, float vy, float vz, float yawDeg) {
    memset(&g_ps, 0, sizeof(g_ps));
    g_ps.origin[0] = x; g_ps.origin[1] = y; g_ps.origin[2] = z;
    g_ps.velocity[0] = vx; g_ps.velocity[1] = vy; g_ps.velocity[2] = vz;
    g_ps.viewangles[0] = 0.0f; g_ps.viewangles[1] = yawDeg; g_ps.viewangles[2] = 0.0f;
    g_ps.speed = g_speed;
    g_ps.gravity = g_gravity;
    g_ps.groundEntityNum = ENTITYNUM_NONE;
    g_ps.pm_type = PM_NORMAL;
}

EMSCRIPTEN_KEEPALIVE
int StepPmove(int forwardmove, int rightmove, int upmove, int buttons, float yawDeg, int serverTime) {
    memset(&g_cmd, 0, sizeof(g_cmd));
    g_cmd.forwardmove = forwardmove;
    g_cmd.rightmove = rightmove;
    g_cmd.upmove = upmove;
    g_cmd.buttons = buttons;
    g_cmd.serverTime = serverTime;

    g_ps.viewangles[1] = yawDeg;

    PmoveSingle(&g_ps, &g_cmd);
    return (g_ps.groundEntityNum != ENTITYNUM_NONE) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void GetPlayerState(float* outPos3, float* outVel3, float* outYawDeg) {
    outPos3[0] = g_ps.origin[0];
    outPos3[1] = g_ps.origin[1];
    outPos3[2] = g_ps.origin[2];

    outVel3[0] = g_ps.velocity[0];
    outVel3[1] = g_ps.velocity[1];
    outVel3[2] = g_ps.velocity[2];

    outYawDeg[0] = g_ps.viewangles[1];
}