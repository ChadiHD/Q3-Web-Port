// wwwroot/js/q3-math.js
// Small pure math helpers for Q3 ↔ Three.js coordinate conversion.

// Convert a Quake 3 yaw (radians) to a Three.js Y-rotation.
export function q3YawToThree(rad) {
    if (!isFinite(rad)) return 0;
    return Math.atan2(-Math.sin(rad), Math.cos(rad));
}
