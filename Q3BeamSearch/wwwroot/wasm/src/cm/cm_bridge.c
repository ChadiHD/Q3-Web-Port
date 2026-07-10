#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <stdio.h>
#include "cm_local.h"
int cm_worldLoaded = 0;
#define CM_HUNK_SIZE  (64 * 1024 * 1024)
static unsigned char *s_hunk=NULL; static size_t s_hunkUsed=0, s_hunkSize=0;
void CM_HunkReset(void){ s_hunkUsed=0; }
void *Hunk_Alloc(int size, ha_pref preference){
    void *p; (void)preference;
    if(!s_hunk){ s_hunkSize=CM_HUNK_SIZE; s_hunk=(unsigned char*)malloc(s_hunkSize);
        if(!s_hunk){ Com_Error(ERR_DROP,"CM hunk malloc failed"); return NULL; } }
    if(size<0){ Com_Error(ERR_DROP,"CM Hunk_Alloc neg"); return NULL; }
    size=(size+31)&~31;
    if(s_hunkUsed+(size_t)size>s_hunkSize){ Com_Error(ERR_DROP,"CM Hunk overflow"); return NULL; }
    p=s_hunk+s_hunkUsed; s_hunkUsed+=(size_t)size; memset(p,0,size); return p;
}
#define CM_MAX_CVARS 8
static cvar_t s_cvarPool[CM_MAX_CVARS]; static char s_cvarStr[CM_MAX_CVARS][32]; static int s_numCvars=0;
void CM_CvarReset(void){ s_numCvars=0; }
cvar_t *Cvar_Get(const char *var_name,const char *value,int flags){
    cvar_t *cv; int slot;
    if(s_numCvars>=CM_MAX_CVARS) s_numCvars=0;
    slot=s_numCvars++; cv=&s_cvarPool[slot];
    strncpy(s_cvarStr[slot], value?value:"0", sizeof(s_cvarStr[slot])-1);
    s_cvarStr[slot][sizeof(s_cvarStr[slot])-1]='\0';
    cv->name=(char*)var_name; cv->string=s_cvarStr[slot]; cv->flags=flags;
    cv->value=(float)atof(cv->string); cv->integer=atoi(cv->string); return cv;
}
void QDECL Com_DPrintf(const char *fmt,...){ (void)fmt; }
unsigned Com_BlockChecksum(const void *buffer,int length){
    const unsigned char *p=(const unsigned char*)buffer; unsigned h=2166136261u; int i;
    for(i=0;i<length;i++){ h^=p[i]; h*=16777619u; } return h;
}
int FS_ReadFile(const char *qpath,void **buffer){ (void)qpath; if(buffer)*buffer=NULL; return -1; }
void FS_FreeFile(void *buffer){ (void)buffer; }
void Q_strncpyz(char *dest,const char *src,int destsize){
    if(!dest||!src||destsize<1) return; strncpy(dest,src,destsize-1); dest[destsize-1]='\0';
}
#ifndef Com_Memcpy
void Com_Memcpy(void *dest,const void *src,const size_t count){ memcpy(dest,src,count); }
#endif
#ifndef Com_Memset
void Com_Memset(void *dest,const int val,const size_t count){ memset(dest,val,count); }
#endif
/* zone allocator for cm_polylib windings (transient) */
void *Z_Malloc( int size ){ void *p = malloc( size ); if ( p ) memset( p, 0, size ); return p; }
void  Z_Free( void *ptr ){ if ( ptr ) free( ptr ); }
/* debug-draw hook, only reached by CM_DrawDebugSurface (unused in headless/browser) */
void  BotDrawDebugPolygons( void (*drawPoly)(int color, int numPoints, float *points), int value ){ (void)drawPoly; (void)value; }
