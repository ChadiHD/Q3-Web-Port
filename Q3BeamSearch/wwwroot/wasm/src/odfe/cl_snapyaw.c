/*
cl_snapyaw.c -- snap-aware VQ3 / CPM yaw chooser for +snapbot / +strafebot.

Pmove rounds the velocity to whole units at the end of every frame
(Sys_SnapVector), so the best view angle is the one whose ROUNDED velocity is
fastest, not the continuous CGaz angle. This is a one-frame model of bg_pmove.c
in float (flat ground, no walls), searched over the yaw shorts with seeds + a
coarse grid + bisection instead of trying all of them.

Twin of Q3BeamSearch/wwwroot/js/strafe.js in the web TAS tool: same model, same
search, same tie rule and middle-of-zone answer, so both pick the same short.
The web tool's WASM compiles this file too (export SnapYaw, the route optimizer's
chooser); tests/snapyaw-wasm.check.mjs checks the two pick alike.
Only depends on the C library so it can be checked on its own.

CPM (DeFRaG df_promode 1) follows the web tool's WASM Pmove: ground accel 15;
in the air strafe keys alone get accel 70 with the wishspeed capped to 30,
accelerating against the velocity uses 2.5, and forward or back alone steers
(air control). DeFRaG is closed source: the rules come from Opensource Defrag
and the proxymod HUD.
*/

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "cl_snapyaw.h"

#define SY_PI			3.14159265358979323846
#define SY_SHORTS		65536
#define SY_HALF			32768
#define SY_WORDS		( SY_HALF / 64 )

#if defined( _MSC_VER )
#include <intrin.h>
static int SY_Ctz( unsigned long long w ) { unsigned long i; _BitScanForward64( &i, w ); return (int)i; }
#else
#define SY_Ctz( w ) __builtin_ctzll( w )
#endif

static const float sy_ft = (float)( 8 * 0.001 );	// pml.frametime at 125 fps

typedef struct {
	float vx, vy, vz;
	int fmove, smove;
	float scale, accel;
	int ground;
	float cap;		// wishspeed cap, 0 = none (CPM strafe keys alone)
	float stop;		// accel against the velocity, 0 = same as accel (CPM air)
	int control;	// CPM air control (forward or back alone)
} syPrep_t;

// Search points t = 0..SY_HALF-1 (shorts from the velocity direction toward the chosen side):
// bitsets of the seeds and of the evaluated points, walked in order (no sorting), and the
// snapped outcome of each evaluated point.
static unsigned long long sy_seedBits[ SY_WORDS ], sy_evalBits[ SY_WORDS ];
static int sy_ox[ SY_HALF ], sy_oy[ SY_HALF ];
static int sy_list[ SY_HALF ];

static float SY_Len3( float x, float y, float z ) {
	return (float)sqrt( x*x + y*y + z*z );
}

// Everything that doesn't depend on the yaw: friction, cmd scale, jump.
static void SY_Prepare( syPrep_t *p, const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int cpm ) {
	const int ground = ( mode == SNAP_GROUND );
	const int up = ground ? 0 : upmove;	// ground: a held jump gets upmove cleared by PM_CheckJump
	float vx = vel[0], vy = vel[1], vz = vel[2];
	float sp, total;
	int max;

	if ( mode == SNAP_JUMP ) {
		vz = 270;	// JUMP_VELOCITY
	}

	// PM_Friction (in the air only the "speed < 1" stop applies)
	sp = SY_Len3( vx, vy, ground ? 0 : vz );
	if ( sp < 1 ) {
		vx = 0;
		vy = 0;
	} else if ( ground ) {
		float control = sp < 100 ? 100 : sp;
		float drop = control * 6.0f * sy_ft;
		float ns = sp - drop;
		if ( ns < 0 ) {
			ns = 0;
		}
		ns /= sp;
		vx = vx * ns;
		vy = vy * ns;
		vz = vz * ns;
	}

	// PM_CmdScale
	max = abs( fmove );
	if ( abs( smove ) > max ) max = abs( smove );
	if ( abs( up ) > max ) max = abs( up );
	total = (float)sqrt( (double)( fmove*fmove + smove*smove + up*up ) );

	p->vx = vx; p->vy = vy; p->vz = vz;
	p->fmove = fmove; p->smove = smove;
	p->scale = max ? (float)( (float)( 320 * max ) / ( 127.0 * total ) ) : 0;
	p->accel = ground ? 10.0f : 1.0f;
	p->ground = ground;
	p->cap = 0;
	p->stop = 0;
	p->control = 0;
	if ( cpm && ground ) {
		p->accel = 15.0f;
	} else if ( cpm && !fmove && smove ) {
		p->accel = 70.0f;
		p->cap = 30.0f;
	} else if ( cpm ) {
		p->stop = 2.5f;
		p->control = fmove && !smove;
	}
}

static int SY_Rint( float v ) {
	return (int)rintf( v );	// round half to even, like Sys_SnapVector
}

// Normalized forward vector of every yaw short, as PM_UpdateViewAngles (signed short) +
// AngleVectors at pitch = roll = 0 make it; right = (fy, -fx). It depends on the short only,
// so it's built once instead of a sin / cos pair per evaluated short (slow in WebAssembly).
static float sy_fx[ SY_SHORTS ], sy_fy[ SY_SHORTS ];
static int sy_vectorsBuilt;

static void SY_BuildVectors( void ) {
	int s;
	for ( s = 0; s < SY_SHORTS; s++ ) {
		const float yaw = (float)( ( s >= SY_HALF ? s - SY_SHORTS : s ) * ( 360.0 / SY_SHORTS ) );
		const float a = (float)( yaw * ( SY_PI * 2 / 360 ) );
		const float sy = (float)sin( a ), cy = (float)cos( a );
		const float il = 1 / (float)sqrt( cy*cy + sy*sy );
		sy_fx[s] = cy * il;
		sy_fy[s] = sy * il;
	}
	sy_vectorsBuilt = 1;
}

// Horizontal velocity after the frame, snapped, for yaw short s.
static void SY_Outcome( const syPrep_t *p, int s, int *ox, int *oy ) {
	// forward = (cy, sy), right = (sy, -cy); both normalized
	const float fx = sy_fx[s], fy = sy_fy[s], rx = fy, ry = -fx;
	const float wx = fx * p->fmove + rx * p->smove, wy = fy * p->fmove + ry * p->smove;
	const float wl = (float)sqrt( wx*wx + wy*wy );
	float vx = p->vx, vy = p->vy, vz = p->vz;

	// PM_Accelerate (CPM: accel 2.5 against the velocity, a wishspeed cap for strafe keys alone)
	if ( wl ) {
		const float iw = 1 / wl, dx = wx * iw, dy = wy * iw;
		float ws = wl * p->scale;
		float dot, add;
		if ( p->cap && ws > p->cap ) {
			ws = p->cap;
		}
		dot = vx*dx + vy*dy;
		add = ws - dot;
		if ( add > 0 ) {
			float acc = ( p->stop && dot < 0 ? p->stop : p->accel ) * sy_ft * ws;
			if ( acc > add ) {
				acc = add;
			}
			vx = vx + acc * dx;
			vy = vy + acc * dy;
		}
		// PM_CPMAirControl: forward or back alone turns the velocity toward the wish direction
		if ( p->control ) {
			const float sp = (float)sqrt( vx*vx + vy*vy );
			if ( sp ) {
				const float is = 1 / sp;
				float nx = vx * is, ny = vy * is;
				const float d = nx*dx + ny*dy;
				if ( d > 0 ) {
					const float k = 32 * 150.0f * ( d * d ) * sy_ft;
					float l;
					nx = nx * sp + dx * k;
					ny = ny * sp + dy * k;
					l = (float)sqrt( nx*nx + ny*ny );
					if ( l ) {
						const float il2 = 1 / l;
						nx = nx * il2;
						ny = ny * il2;
					}
				}
				vx = nx * sp;
				vy = ny * sp;
			}
		}
	}

	// PM_WalkMove: clip to the (flat) ground plane, keep the speed
	if ( p->ground ) {
		const float vl = SY_Len3( vx, vy, vz );
		const float back = vz < 0 ? vz * 1.001f : vz / 1.001f;
		float n;
		vz = vz - back;
		n = SY_Len3( vx, vy, vz );
		if ( n ) {
			const float inv = 1 / n;
			vx = vx * inv * vl;
			vy = vy * inv * vl;
		}
	}

	*ox = SY_Rint( vx );
	*oy = SY_Rint( vy );
}

static int SY_Round( double x ) {
	return (int)floor( x + 0.5 );	// Math.round
}

static int SY_Wrap( int s ) {
	return ( ( s % SY_SHORTS ) + SY_SHORTS ) % SY_SHORTS;
}

static int sy_base, sy_side;

static int SY_YawAt( int t ) {
	return ( sy_base + sy_side * t + SY_SHORTS ) & 0xffff;
}

static void SY_Mark( unsigned long long *bits, int t ) {
	bits[ t >> 6 ] |= 1ULL << ( t & 63 );
}

// The set points of `bits`, ascending, into sy_list; returns how many.
static int SY_Collect( const unsigned long long *bits ) {
	int i, n = 0;
	for ( i = 0; i < SY_WORDS; i++ ) {
		unsigned long long w = bits[i];
		while ( w ) {
			sy_list[ n++ ] = ( i << 6 ) + SY_Ctz( w );
			w &= w - 1;
		}
	}
	return n;
}

// The snapped outcome of point t, evaluated once
static void SY_Eval( const syPrep_t *p, int t ) {
	if ( sy_evalBits[ t >> 6 ] & ( 1ULL << ( t & 63 ) ) ) {
		return;
	}
	SY_Mark( sy_evalBits, t );
	SY_Outcome( p, SY_YawAt( t ), &sy_ox[t], &sy_oy[t] );
}

// bisect between neighbours whose outcomes differ, down to one short
static void SY_Split( const syPrep_t *p, int a, int b ) {
	int m;
	if ( ( sy_ox[a] == sy_ox[b] && sy_oy[a] == sy_oy[b] ) || b - a <= 1 ) {
		return;
	}
	m = ( a + b ) >> 1;
	SY_Eval( p, m );
	SY_Split( p, a, m );
	SY_Split( p, m, b );
}

static void SY_AddSeed( int t ) {
	int d;
	for ( d = -1; d <= 1; d++ ) {
		if ( t + d >= 0 && t + d < SY_HALF ) {
			SY_Mark( sy_seedBits, t + d );
		}
	}
}

int CL_SnapYaw( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm, int outVel[2] ) {
	return CL_SnapYawAim( vel, mode, fmove, smove, upmove, side, cpm, NULL, 0, outVel );
}

int CL_SnapYawAim( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm,
				   const double aim[2], double lambda, int outVel[2] ) {
	const double k = SY_SHORTS / ( 2 * SY_PI );
	syPrep_t p;
	double v, va, offset, W, A, R, bestScore;
	int i, n, r, ns, step, from, bestFrom, bestTo, bestX, bestY;

	SY_Prepare( &p, vel, mode, fmove, smove, upmove, cpm );
	v = sqrt( (double)p.vx * p.vx + (double)p.vy * p.vy );
	if ( ( !fmove && !smove ) || v < 1 ) {
		return -1;
	}
	if ( !sy_vectorsBuilt ) {
		SY_BuildVectors();
	}

	va = atan2( p.vy, p.vx );
	offset = atan2( -smove, fmove );	// wish direction relative to the view
	sy_side = side >= 0 ? 1 : -1;
	sy_base = SY_Wrap( SY_Round( ( va - offset ) * k ) );
	// t = 0..SY_HALF-1 walks from the velocity direction (delta = 0) toward the chosen side
#define SY_T( psi ) SY_Wrap( ( SY_Round( ( (psi) - offset ) * k ) - sy_base ) * sy_side )

	// 1) seeds: where the full-accel circle crosses a rounding line (x or y = n + 0.5),
	//    and the edges of the clamped band (addspeed between 0 and a), each +-1 short
	//    (CPM: also the smaller circle of the 2.5 accel against the velocity)
	W = sqrt( (double)( fmove*fmove + smove*smove ) ) * p.scale;
	if ( p.cap && W > p.cap ) {
		W = p.cap;
	}
	A = p.accel * 0.008 * W;
	memset( sy_seedBits, 0, sizeof( sy_seedBits ) );
	memset( sy_evalBits, 0, sizeof( sy_evalBits ) );
	SY_Mark( sy_seedBits, 0 );
	SY_Mark( sy_seedBits, SY_HALF - 1 );
	for ( r = 0; r < ( p.stop ? 2 : 1 ); r++ ) {
		R = r ? p.stop * 0.008 * W : A;
		for ( n = (int)floor( p.vx - R ); n <= (int)ceil( p.vx + R ); n++ ) {
			const double c = ( n + 0.5 - p.vx ) / R;
			if ( fabs( c ) <= 1 ) {
				const double t = acos( c );
				SY_AddSeed(SY_T( t ) );
				SY_AddSeed(SY_T( -t ) );
			}
		}
		for ( n = (int)floor( p.vy - R ); n <= (int)ceil( p.vy + R ); n++ ) {
			const double c = ( n + 0.5 - p.vy ) / R;
			if ( fabs( c ) <= 1 ) {
				const double t = asin( c );
				SY_AddSeed(SY_T( t ) );
				SY_AddSeed(SY_T( SY_PI - t ) );
			}
		}
	}
	if ( v > W - A ) {
		const double dOpt = acos( ( W - A ) / v ), dMin = v > W ? acos( W / v ) : 0;
		SY_AddSeed(SY_T( va + dOpt ) );
		SY_AddSeed(SY_T( va - dOpt ) );
		SY_AddSeed(SY_T( va + dMin ) );
		SY_AddSeed(SY_T( va - dMin ) );
	}
#undef SY_T
	// 2) coarse grid (the ground accel circle is big, and CPM air control curves back on
	//    itself, so they need finer ones)
	step = p.ground ? 64 : p.control ? 256 : 1024;
	for ( i = 0; i < SY_HALF; i += step ) {
		SY_Mark( sy_seedBits, i );
	}

	// 3) evaluate the seeds, then bisect between neighbours that differ
	ns = SY_Collect( sy_seedBits );
	for ( i = 0; i < ns; i++ ) {
		SY_Eval( &p, sy_list[i] );
	}
	for ( i = 0; i + 1 < ns; i++ ) {
		SY_Split( &p, sy_list[i], sy_list[i + 1] );
	}
	n = SY_Collect( sy_evalBits );	// every evaluated point, ascending

	// 4) zones = runs of equal outcome; best score wins, ties go to the smaller turn.
	//    Score: speed, or with aim (1 - lambda)*speed + lambda*(v . aim).
	//    Answer the zone's middle short so float differences (C vs JS) can't flip it.
	bestScore = -HUGE_VAL;
	bestFrom = bestTo = 0;
	bestX = bestY = 0;
	from = sy_list[0];
	for ( i = 0; i < n; i++ ) {
		const int t = sy_list[i], x = sy_ox[t], y = sy_oy[t];
		double score;
		if ( i + 1 < n && x == sy_ox[ sy_list[i + 1] ] && y == sy_oy[ sy_list[i + 1] ] ) {
			continue;
		}
		score = sqrt( (double)x * x + (double)y * y );
		if ( aim ) {
			score = ( 1 - lambda ) * score + lambda * ( x * aim[0] + y * aim[1] );
		}
		if ( score > bestScore + 1e-9 ) {
			bestScore = score;
			bestFrom = from;
			bestTo = t;
			bestX = x;
			bestY = y;
		}
		if ( i + 1 < n ) {
			from = sy_list[i + 1];
		}
	}

	if ( outVel ) {
		outVel[0] = bestX;
		outVel[1] = bestY;
	}
	return SY_YawAt( ( bestFrom + bestTo ) >> 1 );
}

int CL_CGazYaw( const float vel[3], snapMode_t mode, int fmove, int smove, int upmove, int side, int cpm, int outVel[2] ) {
	syPrep_t p;
	double v, W, A, d;
	int s;

	SY_Prepare( &p, vel, mode, fmove, smove, upmove, cpm );
	v = sqrt( (double)p.vx * p.vx + (double)p.vy * p.vy );
	if ( ( !fmove && !smove ) || v < 1 ) {
		return -1;
	}
	W = sqrt( (double)( fmove*fmove + smove*smove ) ) * p.scale;
	if ( p.cap && W > p.cap ) {
		W = p.cap;
	}
	A = p.accel * 0.008 * W;
	d = v > W - A ? acos( ( W - A ) / v ) : 0;	// max-accel angle between wish and velocity
	s = SY_Wrap( SY_Round( ( atan2( p.vy, p.vx ) + ( side >= 0 ? d : -d ) - atan2( -smove, fmove ) ) * ( SY_SHORTS / ( 2 * SY_PI ) ) ) );
	if ( !sy_vectorsBuilt ) {
		SY_BuildVectors();
	}
	if ( outVel ) {
		SY_Outcome( &p, s, &outVel[0], &outVel[1] );
	}
	return s;
}
