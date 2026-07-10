// Stubs for functions oDFe expects but we don't need in browser
//
// bg_pmove.c / bg_slidemove.c / bg_misc.c call into engine "trap_*"
// functions and Com_Printf/Com_Error which don't exist in our WASM
// build. This file provides minimal implementations.

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <math.h>
#include "q_shared.h"
#include "bg_public.h"

// ============================================================
// Engine trap functions
// ============================================================

// Snap vector components to integers (called at end of PmoveSingle)
void trap_SnapVector(float *v) {
    v[0] = (int)v[0];
    v[1] = (int)v[1];
    v[2] = (int)v[2];
}

// Error handling
void trap_Error(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
}

// Print function
void trap_Print(const char *msg) {
    printf("%s", msg);
}

// ── Real world collision, provided by the ioq3 collision model (wasm/src/cm) ──
// cm_worldLoaded is set by CM_LoadWorldFromMemory once a map is uploaded.
extern int cm_worldLoaded;
void CM_BoxTrace( trace_t *results, const vec3_t start, const vec3_t end,
                  vec3_t mins, vec3_t maxs, int model, int brushmask, int capsule );
int  CM_PointContents( const vec3_t p, int model );

// trace->entityNum values. q_shared.h defines these; guard just in case.
#ifndef ENTITYNUM_WORLD
#define ENTITYNUM_WORLD (ENTITYNUM_NONE - 1)
#endif

// Trace function (collision detection).
// NOTE argument order: pm->trace passes (start, mins, maxs, end) but
// CM_BoxTrace expects (start, end, mins, maxs) — do not mix these up.
void trap_Trace(trace_t *results, const vec3_t start, const vec3_t mins,
                const vec3_t maxs, const vec3_t end, int passEntityNum, int contentmask) {
    (void)passEntityNum;

    if (cm_worldLoaded) {
        // model 0 == world BSP tree. capsule 0 == axis-aligned player box.
        CM_BoxTrace(results, start, end, (float *)mins, (float *)maxs, 0, contentmask, 0);
        results->entityNum = (results->fraction != 1.0f) ? ENTITYNUM_WORLD : ENTITYNUM_NONE;
        return;
    }

    // No map loaded yet — behave as open space.
    memset(results, 0, sizeof(*results));
    VectorCopy(end, results->endpos);
    results->fraction = 1.0f;
    results->allsolid = qfalse;
    results->startsolid = qfalse;
    results->entityNum = ENTITYNUM_NONE;
}

// Point contents.
int trap_PointContents(const vec3_t point, int passEntityNum) {
    (void)passEntityNum;
    if (cm_worldLoaded) {
        return CM_PointContents(point, 0);
    }
    return 0;
}

// Cvar read — stub (used by BG_AddPredictableEventToPlayerstate in _DEBUG)
void trap_Cvar_VariableStringBuffer(const char *var_name, char *buffer, int bufsize) {
    if (bufsize > 0) buffer[0] = '\0';
}

// ============================================================
// Com_Printf / Com_Error
// (called by bg_pmove.c debug prints and bg_misc.c error paths)
// ============================================================

void QDECL Com_Printf(const char *msg, ...) {
    va_list ap;
    va_start(ap, msg);
    vprintf(msg, ap);
    va_end(ap);
}

void QDECL Com_Error(int level, const char *error, ...) {
    va_list ap;
    va_start(ap, error);
    printf("ERROR [%d]: ", level);
    vprintf(error, ap);
    va_end(ap);
    printf("\n");
}

// ============================================================
// Misc symbols referenced by the compiled bg code
// ============================================================

// Case-insensitive string compare (used by BG_FindItem in bg_misc.c)
int Q_stricmp(const char *s1, const char *s2) {
    unsigned char c1, c2;
    if (s1 == NULL) return s2 == NULL ? 0 : -1;
    if (s2 == NULL) return 1;
    do {
        c1 = *s1++;
        c2 = *s2++;
        if (c1 >= 'A' && c1 <= 'Z') c1 += 'a' - 'A';
        if (c2 >= 'A' && c2 <= 'Z') c2 += 'a' - 'A';
        if (c1 != c2) return c1 < c2 ? -1 : 1;
    } while (c1);
    return 0;
}
