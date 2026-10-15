/*
cl_snapyaw.h -- snap-aware VQ3 / CPM yaw chooser for +snapbot / +strafebot.
Twin of Q3BeamSearch/wwwroot/js/strafe.js (web TAS tool): same model, same search.
*/
#ifndef CL_SNAPYAW_H
#define CL_SNAPYAW_H

typedef enum {
	SNAP_AIR,		// airborne
	SNAP_GROUND,	// walking, not jumping this frame (jump not pressed, or still held)
	SNAP_JUMP		// walking and this frame jumps (PM_CheckJump, then AirMove)
} snapMode_t;

// Yaw short (0..65535) whose snapped velocity after this frame is fastest, or -1
// when the yaw can't matter (no forward/side keys, or standing still).
// vel: velocity before the frame. side: +1 = wish direction left of the velocity
// (turn left), -1 = right. cpm: CPM physics (DeFRaG df_promode 1). outVel (may be NULL):
// the snapped x/y velocity it gives.
int CL_SnapYaw( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm, int outVel[2] );

// Same, scored (1 - lambda)*speed + lambda*(snapped velocity . aim) when aim (a unit x/y
// direction) isn't NULL: steering toward a point, as the web tool's route optimizer does.
int CL_SnapYawAim( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm,
				   const double aim[2], double lambda, int outVel[2] );

// Same, at the continuous CGaz angle (ignores snapping), rounded to a short.
int CL_CGazYaw( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm, int outVel[2] );

#endif
