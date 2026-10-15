// wwwroot/js/waypoint-system.js
// Waypoint System for TAS optimization with Q3 Physics

import * as THREE from 'three';
import { hitboxTouches } from './waypoint-optimizer.js';

const SELECTED = 0xffff00;   // outline of the waypoint being edited

export class WaypointSystem {
    constructor(scene, map) {
        this.scene = scene;
        this.map = map;
        this.waypoints = [];
        this.currentWaypoint = 0;
        this.waypointMarkers = [];
        this.isEditMode = false;
        this.selectedWaypoint = null;   // the one being edited (outline yellow), or null
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
    }

    // Add waypoint number `number` (default: the lowest free one) on the clicked surface point
    // `position`: a ball of `radius` resting on it, lifted by `height` (the gap under the ball).
    // Numbers stay fixed when others are deleted. Returns null if the number is already taken.
    addWaypoint(position, number = this.nextFreeNumber(), radius = 32, height = 0, color = 0xff0000) {
        if (this.has(number)) return null;
        const waypoint = {
            number,
            position: { x: position.x, y: position.y, z: position.z },
            height,
            radius: radius,
            reached: false,
            reachTime: null,
            color: color
        };

        // Both arrays stay in number order: the route (optimizer, playback check) follows it.
        let i = this.waypoints.findIndex(wp => wp.number > number);
        if (i < 0) i = this.waypoints.length;
        this.waypoints.splice(i, 0, waypoint);
        this.waypointMarkers.splice(i, 0, this.renderWaypoint(waypoint));

        console.log(`[WaypointSystem] Added waypoint #${number} at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);

        return waypoint;
    }

    has(number) { return this.waypoints.some(wp => wp.number === number); }

    nextFreeNumber() {
        let n = 1;
        while (this.has(n)) n++;
        return n;
    }

    // Numbers below the highest waypoint that have no waypoint.
    missingNumbers() {
        const missing = [];
        for (let n = 1; n < (this.waypoints.at(-1)?.number ?? 0); n++) if (!this.has(n)) missing.push(n);
        return missing;
    }

    // Build a waypoint's marker, add it to the scene, and return it
    renderWaypoint(waypoint) {
        const group = new THREE.Group();

        // Sphere marker (green once reached in playback)
        const geometry = new THREE.SphereGeometry(waypoint.radius, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: waypoint.reached ? 0x00ff00 : waypoint.color,
            transparent: true,
            opacity: waypoint.reached ? 0.6 : 0.3,
            wireframe: false
        });
        const sphere = new THREE.Mesh(geometry, material);
        group.add(sphere);

        // Wireframe outline (yellow while selected)
        const wireframeGeo = new THREE.EdgesGeometry(geometry);
        const wireframeMat = new THREE.LineBasicMaterial({
            color: waypoint === this.selectedWaypoint ? SELECTED : waypoint.color,
            linewidth: 2
        });
        const wireframe = new THREE.LineSegments(wireframeGeo, wireframeMat);
        group.add(wireframe);

        // Number label (using sprite)
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 128;
        canvas.height = 128;
        context.fillStyle = '#ffffff';
        context.font = 'Bold 64px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(waypoint.number.toString(), 64, 64);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });   // never hidden by walls
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.renderOrder = 1;
        sprite.scale.set(waypoint.radius * 2, waypoint.radius * 2, 1);
        sprite.position.copy(this._labelOffset(waypoint));
        group.add(sprite);

        // Raised: a stem from the ball down to the clicked surface, so its spot on the map is visible
        if (waypoint.height > 0) {
            const r = waypoint.radius;
            const stem = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -r, 0), new THREE.Vector3(0, -r - waypoint.height, 0)]);
            group.add(new THREE.Line(stem, new THREE.LineBasicMaterial({ color: waypoint.color })));
        }

        // Position the group at the ball centre
        group.position.copy(this._center(waypoint));
        group.updateMatrixWorld(true);   // pickable (deleteAt) before the next render
        group.userData = { waypoint: waypoint };

        this.scene.add(group);
        return group;
    }

    // Ball centre in Three coordinates (y up): resting on the clicked surface point, lifted by the height
    _center(waypoint) {
        return new THREE.Vector3(waypoint.position.x, waypoint.position.z + waypoint.radius + waypoint.height, waypoint.position.y);
    }

    // The number label's offset from the ball centre (Three axes, y up): above the ball, or
    // beside it when the map is in the way (low ceiling, wall), so it sits in open space.
    _labelOffset(waypoint) {
        const r = waypoint.radius, d = r * 1.75;
        const offsets = [[0, d, 0], [d, r, 0], [-d, r, 0], [0, r, d], [0, r, -d]].map(o => new THREE.Vector3(...o));
        if (!this.map) return offsets[0];
        const center = this._center(waypoint);
        // Clear = no drawn map surface from the centre to half a label past the offset. Sky
        // surfaces don't count (not drawn as surfaces); near 1 skips the floor the ball was clicked on.
        const clear = o => !new THREE.Raycaster(center, o.clone().normalize(), 1, o.length() + r * 0.5)
            .intersectObject(this.map, true).some(h => !h.object.userData?.isSky);
        return offsets.find(clear) ?? offsets[0];
    }

    // Check if the player (origin, viewer convention) reached the next waypoint: its hitbox
    // touches the ball, the same test as the optimizer's (waypoint-optimizer.js hitboxTouches)
    checkWaypoint(playerPos, frame) {
        const current = this.waypoints[this.currentWaypoint];
        if (!current || current.reached) return false;

        const p = current.position, cz = p.z + current.radius + current.height;
        if (hitboxTouches(playerPos.x - p.x, playerPos.y - p.y, playerPos.z - cz, current.radius)) {
            current.reached = true;
            current.reachTime = frame;

            // Update marker appearance
            const marker = this.waypointMarkers[this.currentWaypoint];
            if (marker) {
                marker.children[0].material.color.setHex(0x00ff00); // Green when reached
                marker.children[0].material.opacity = 0.6;
            }

            console.log(`[WaypointSystem] Waypoint #${current.number} reached at frame ${frame} (${(frame / 125).toFixed(2)}s)`);

            this.currentWaypoint++;
            return true;
        }

        return false;
    }

    // Delete the waypoint at array position `index`. The others keep their numbers.
    deleteWaypoint(index) {
        if (index < 0 || index >= this.waypoints.length) return false;

        this._removeMarker(this.waypointMarkers[index]);
        if (this.waypoints[index] === this.selectedWaypoint) this.selectedWaypoint = null;

        // Remove from arrays
        this.waypoints.splice(index, 1);
        this.waypointMarkers.splice(index, 1);
        if (index < this.currentWaypoint) this.currentWaypoint--;

        return true;
    }

    // Take a marker out of the scene and free its GPU buffers and textures
    _removeMarker(marker) {
        if (!marker) return;
        this.scene.remove(marker);
        marker.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    }

    // Select a waypoint to edit (null: none). Its outline turns yellow.
    select(waypoint) {
        const old = this.selectedWaypoint;
        this.selectedWaypoint = waypoint;
        for (const wp of [old, waypoint]) {
            const marker = wp && this.waypointMarkers[this.waypoints.indexOf(wp)];
            marker?.children[1].material.color.setHex(wp === this.selectedWaypoint ? SELECTED : wp.color);
        }
    }

    // Change a waypoint's radius and height and redraw it at once (live editing)
    resize(waypoint, radius, height) {
        const i = this.waypoints.indexOf(waypoint);
        if (i < 0) return;
        waypoint.radius = radius;
        waypoint.height = height;
        this._removeMarker(this.waypointMarkers[i]);
        this.waypointMarkers[i] = this.renderWaypoint(waypoint);
    }

    // Reset all waypoints
    resetWaypoints() {
        this.waypoints.forEach((wp, i) => {
            wp.reached = false;
            wp.reachTime = null;

            // Reset appearance
            const marker = this.waypointMarkers[i];
            if (marker) {
                marker.children[0].material.color.setHex(wp.color);
                marker.children[0].material.opacity = 0.3;
            }
        });

        this.currentWaypoint = 0;
    }

    // Clear all waypoints
    clearAllWaypoints() {
        this.waypointMarkers.forEach(marker => this._removeMarker(marker));

        this.waypoints = [];
        this.waypointMarkers = [];
        this.currentWaypoint = 0;
        this.selectedWaypoint = null;
    }

    _aim(event, camera) {
        // Mouse position in normalized device coordinates, then a ray from the camera
        const rect = event.target.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, camera);
    }

    // The waypoint under the mouse (the nearest one the ray hits), or null
    pickAt(event, camera) {
        if (!this.isEditMode || !this.waypointMarkers.length) return null;
        this._aim(event, camera);
        let o = this.raycaster.intersectObjects(this.waypointMarkers, true)[0]?.object;
        while (o && !o.userData?.waypoint) o = o.parent;
        return o?.userData.waypoint ?? null;
    }

    // Delete the waypoint under the mouse. Returns its number or -1.
    deleteAt(event, camera) {
        const wp = this.pickAt(event, camera);
        if (!wp) return -1;
        this.deleteWaypoint(this.waypoints.indexOf(wp));
        return wp.number;
    }

    // Place waypoint `number` (default: the lowest free one) where the click hits the map
    handleClick(event, camera, number, radius, height) {
        if (!this.isEditMode) return null;
        this._aim(event, camera);

        // Check intersection with map
        if (this.map) {
            const intersects = this.raycaster.intersectObject(this.map, true);
            if (intersects.length > 0) {
                const point = intersects[0].point;
                // Convert from Three.js to Q3 coordinates
                const q3Pos = { x: point.x, y: point.z, z: point.y };
                return this.addWaypoint(q3Pos, number, radius, height);
            }
        }

        return null;
    }

    // Toggle edit mode
    toggleEditMode() {
        this.isEditMode = !this.isEditMode;
        console.log(`[WaypointSystem] Edit mode: ${this.isEditMode ? 'ON' : 'OFF'}`);
        return this.isEditMode;
    }

    setMap(newMap) {
        this.map = newMap;
    }
}