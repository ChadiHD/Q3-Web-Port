## Plan

1. Inventory current viewer3d architecture, especially BSP loading, physics WASM integration, waypoint system, and rendering pipeline.
2. Define requirements and API surface for a new collision-detection WASM module that leverages BSP data for solid detection.
3. Audit waypoint mode workflow to understand current failure modes; design waypoint management updates that integrate collision checks.
4. Investigate lighting pipeline to support BSP lightmaps or map-defined light entities; outline options (lightmap textures vs. dynamic lights).
5. Identify duplicate UI control render paths causing doubled buttons and plan a refactor to centralize control creation.
6. Remove or conditionally hide default ground helpers (grid/axes) once a BSP map is loaded; ensure teardown logic handles resource disposal.
7. Re-evaluate orientation math for velocity, view direction, and wish direction arrows; determine correct coordinate transforms relative to BSP axes.
8. Prioritize tasks, sketch implementation milestones, and list open questions or required assets/tooling.
