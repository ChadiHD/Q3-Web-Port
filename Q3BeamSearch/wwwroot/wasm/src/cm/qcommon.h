// qcommon.h — MINIMAL SHIM for the browser/WASM build (not the real engine header).
// See PHYSICS_AND_COLLISION.md. cm_local.h includes q_shared.h *before* this file,
// so all shared types (vec3_t, cplane_t, trace_t, cvar_t, ha_pref/h_high, ERR_*,
// CVAR_*) are already available here.

#ifndef CM_QCOMMON_SHIM_H
#define CM_QCOMMON_SHIM_H

#include <stdint.h>   // intptr_t, used by cm_polylib.c

// BSP on-disk structures (dheader_t, lump_t, dshader_t, dbrush_t, dbrushside_t,
// dplane_t, dnode_t, dleaf_t, dmodel_t, drawVert_t, dsurface_t, LUMP_* indices,
// BSP_VERSION, MST_PATCH, ...).
#include "qfiles.h"

// CM API prototypes (CM_ModelBounds, CM_TempBoxModel, CM_PointContents,
// CM_BoxTrace, CM_InlineModel, ...). Without these, cm_trace.c/cm_test.c call
// them implicitly, which emcc's clang treats as an error.
#include "cm_public.h"

// floatint_t: fast float<->int bit union used by cm_trace.c's inverse-sqrt.
// Present in newer ioq3 q_shared.h but not in this oDFe fork.
#ifndef Q3_FLOATINT_T_DEFINED
#define Q3_FLOATINT_T_DEFINED
typedef union { float f; int i; unsigned int ui; } floatint_t;
#endif

// Little-endian byte-swap helpers.
// oDFe's q_shared.h only defines LittleLong/LittleShort/LittleFloat for the
// platforms its endianness detection recognises; the emscripten/wasm target is
// NOT one of them, so under emcc they arrive UNDECLARED. The oDFe game/movement
// code never calls them, but the BSP collision loader does heavily. WASM is
// always little-endian, so define them as identity when missing. Guarded to
// emscripten so native builds keep using q_shared.h's own definitions unchanged.
#if defined(__EMSCRIPTEN__)
  #ifndef LittleLong
  #define LittleLong(x)  (x)
  #endif
  #ifndef LittleShort
  #define LittleShort(x) (x)
  #endif
  #ifndef LittleFloat
  #define LittleFloat(x) (x)
  #endif
#endif

// ── Engine services required by cm_*.c (implemented in cm_bridge.c) ────────
void      QDECL Com_DPrintf( const char *fmt, ... );
cvar_t   *Cvar_Get( const char *var_name, const char *value, int flags );
unsigned  Com_BlockChecksum( const void *buffer, int length );
int       FS_ReadFile( const char *qpath, void **buffer );
void      FS_FreeFile( void *buffer );

// Entry point used by the WASM wrapper (defined at the bottom of cm_load.c).
void      CM_LoadWorldFromMemory( void *data, int length );

// Set to 1 once a world is loaded (read by browser_stubs.c trap_Trace).
extern int cm_worldLoaded;

// Zone allocator used by cm_polylib.c for transient patch windings.
void *Z_Malloc( int size );
void  Z_Free( void *ptr );

// Debug-draw hook referenced by cm_patch.c's CM_DrawDebugSurface (unused here).
void  BotDrawDebugPolygons( void (*drawPoly)(int color, int numPoints, float *points), int value );

#endif // CM_QCOMMON_SHIM_H
