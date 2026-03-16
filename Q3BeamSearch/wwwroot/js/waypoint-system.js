// wwwroot/js/waypoint-system.js
// Waypoint System for TAS optimization with Q3 Physics

import * as THREE from 'three';

export class WaypointSystem {
    constructor(scene, map) {
        this.scene = scene;
        this.map = map;
        this.waypoints = [];
        this.currentWaypoint = 0;
        this.waypointMarkers = [];
        this.isEditMode = false;
        this.selectedWaypoint = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
    }

    // Add waypoint by clicking on map
    addWaypoint(position, radius = 32, color = 0xff0000) {
        const waypoint = {
            index: this.waypoints.length,
            position: { x: position.x, y: position.y, z: position.z },
            radius: radius,
            reached: false,
            reachTime: null,
            color: color
        };

        this.waypoints.push(waypoint);
        this.renderWaypoint(waypoint);

        console.log(`[WaypointSystem] Added waypoint #${waypoint.index} at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);

        return waypoint;
    }

    // Render waypoint marker in 3D scene
    renderWaypoint(waypoint) {
        const group = new THREE.Group();

        // Sphere marker
        const geometry = new THREE.SphereGeometry(waypoint.radius, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: waypoint.color,
            transparent: true,
            opacity: 0.3,
            wireframe: false
        });
        const sphere = new THREE.Mesh(geometry, material);
        group.add(sphere);

        // Wireframe outline
        const wireframeGeo = new THREE.EdgesGeometry(geometry);
        const wireframeMat = new THREE.LineBasicMaterial({
            color: waypoint.color,
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
        context.fillText((waypoint.index + 1).toString(), 64, 64);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(waypoint.radius * 2, waypoint.radius * 2, 1);
        sprite.position.set(0, 0, waypoint.radius * 1.5);
        group.add(sprite);

        // Position the group
        group.position.set(waypoint.position.x, waypoint.position.z, waypoint.position.y);
        group.userData = { waypoint: waypoint };

        this.waypointMarkers.push(group);
        this.scene.add(group);
    }

    // Check if player reached waypoint
    checkWaypoint(playerPos, frame) {
        const current = this.waypoints[this.currentWaypoint];
        if (!current || current.reached) return false;

        const distance = this.distance3D(
            playerPos,
            current.position
        );

        if (distance <= current.radius) {
            current.reached = true;
            current.reachTime = frame;

            // Update marker appearance
            const marker = this.waypointMarkers[current.index];
            if (marker) {
                marker.children[0].material.color.setHex(0x00ff00); // Green when reached
                marker.children[0].material.opacity = 0.6;
            }

            console.log(`[WaypointSystem] Waypoint #${current.index} reached at frame ${frame} (${(frame / 125).toFixed(2)}s)`);

            this.currentWaypoint++;
            return true;
        }

        return false;
    }

    // Delete waypoint
    deleteWaypoint(index) {
        if (index < 0 || index >= this.waypoints.length) return false;

        // Remove from scene
        const marker = this.waypointMarkers[index];
        if (marker) {
            this.scene.remove(marker);
        }

        // Remove from arrays
        this.waypoints.splice(index, 1);
        this.waypointMarkers.splice(index, 1);

        // Reindex
        this.waypoints.forEach((wp, i) => {
            wp.index = i;
            // Update label
            if (this.waypointMarkers[i]) {
                const sprite = this.waypointMarkers[i].children[2]; // Sprite is 3rd child
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = 128;
                canvas.height = 128;
                context.fillStyle = '#ffffff';
                context.font = 'Bold 64px Arial';
                context.textAlign = 'center';
                context.textBaseline = 'middle';
                context.fillText((i + 1).toString(), 64, 64);
                sprite.material.map = new THREE.CanvasTexture(canvas);
                sprite.material.map.needsUpdate = true;
            }
        });

        return true;
    }

    // Move waypoint
    moveWaypoint(index, newPosition) {
        if (index < 0 || index >= this.waypoints.length) return false;

        this.waypoints[index].position = newPosition;
        const marker = this.waypointMarkers[index];
        if (marker) {
            marker.position.set(newPosition.x, newPosition.z, newPosition.y);
        }

        return true;
    }

    // Calculate total time to reach all waypoints
    getTotalTime() {
        if (this.waypoints.length === 0) return null;

        const lastReached = this.waypoints.filter(wp => wp.reached).pop();
        if (!lastReached) return null;

        return {
            frames: lastReached.reachTime,
            seconds: (lastReached.reachTime / 125).toFixed(2)
        };
    }

    // Get route statistics
    getRouteStats() {
        const stats = {
            totalWaypoints: this.waypoints.length,
            reachedWaypoints: this.waypoints.filter(wp => wp.reached).length,
            totalTime: this.getTotalTime(),
            splits: []
        };

        let lastTime = 0;
        this.waypoints.forEach((wp, i) => {
            if (wp.reached) {
                const split = {
                    waypoint: i + 1,
                    time: (wp.reachTime / 125).toFixed(2) + 's',
                    splitTime: ((wp.reachTime - lastTime) / 125).toFixed(2) + 's'
                };
                stats.splits.push(split);
                lastTime = wp.reachTime;
            }
        });

        return stats;
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
        this.waypointMarkers.forEach(marker => {
            this.scene.remove(marker);
        });

        this.waypoints = [];
        this.waypointMarkers = [];
        this.currentWaypoint = 0;
    }

    // Handle mouse click for waypoint placement/selection
    handleClick(event, camera) {
        if (!this.isEditMode) return null;

        // Calculate mouse position in normalized device coordinates
        const rect = event.target.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Raycast from camera
        this.raycaster.setFromCamera(this.mouse, camera);

        // Check intersection with map
        if (this.map) {
            const intersects = this.raycaster.intersectObject(this.map, true);
            if (intersects.length > 0) {
                const point = intersects[0].point;
                // Convert from Three.js to Q3 coordinates
                const q3Pos = { x: point.x, y: point.z, z: point.y };
                return this.addWaypoint(q3Pos);
            }
        }

        return null;
    }

    // Export waypoints to JSON
    exportToJSON() {
        return JSON.stringify({
            waypoints: this.waypoints.map(wp => ({
                index: wp.index,
                position: wp.position,
                radius: wp.radius,
                color: wp.color
            }))
        }, null, 2);
    }

    // Import waypoints from JSON
    importFromJSON(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            this.clearAllWaypoints();

            data.waypoints.forEach(wpData => {
                this.addWaypoint(
                    wpData.position,
                    wpData.radius || 32,
                    wpData.color || 0xff0000
                );
            });

            return true;
        } catch (error) {
            console.error('[WaypointSystem] Import failed:', error);
            return false;
        }
    }

    // Utility functions
    distance3D(pos1, pos2) {
        return Math.sqrt(
            Math.pow(pos1.x - pos2.x, 2) +
            Math.pow(pos1.y - pos2.y, 2) +
            Math.pow(pos1.z - pos2.z, 2)
        );
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