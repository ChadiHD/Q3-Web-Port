# Build oDFe WebAssembly

Write-Host "Building oDFe WebAssembly..."

# Ensure output directory exists
if (-not (Test-Path "output")) {
    New-Item -ItemType Directory -Path "output" | Out-Null
}

# Source files
$sources = @(
    "src/wrapper.c",
    "src/odfe/bg_pmove.c",
    "src/odfe/bg_slidemove.c",
    "src/odfe/bg_misc.c",
    "src/odfe/bg_lib.c",
    "src/odfe/q_math.c",
    "src/odfe/browser_stubs.c",
    # ioq3 collision model (real world geometry for Pmove traces)
    "src/cm/cm_load.c",
    "src/cm/cm_trace.c",
    "src/cm/cm_test.c",
    "src/cm/cm_patch.c",
    "src/cm/cm_polylib.c",
    "src/cm/cm_bridge.c"
)

# Exported functions — StepPhysics replaces PmoveSingle.
# LoadCollisionMap / HasCollisionMap added for the CM world-loading path.
$exportedFunctions = '["_InitPhysics","_StepPhysics","_IsPlayerOnGround","_GetHorizontalSpeed","_SetPlayerSpeed","_SetGravity","_GetPlayerPosition","_GetPlayerVelocity","_GetPlayerAngles","_SimulateFrames","_LoadCollisionMap","_HasCollisionMap","_malloc","_free"]'
$exportedRuntimeMethods = '["ccall","cwrap","getValue","setValue","HEAPF32","HEAP32","HEAPU8"]'

# Build command arguments
$emccArgs = @(
    "-O3"
    "-s", "WASM=1"
    "-s", "ALLOW_MEMORY_GROWTH=1"
    "-s", "EXPORTED_FUNCTIONS=$exportedFunctions"
    "-s", "EXPORTED_RUNTIME_METHODS=$exportedRuntimeMethods"
    "-s", "MODULARIZE=1"
    "-s", "EXPORT_NAME=Q3PhysicsModule"
    "-s", "ENVIRONMENT=web"
    "-s", "SINGLE_FILE=0"
    # 256 MB: the collision model reserves a 64 MB hunk for map data on top of
    # the physics working set. ALLOW_MEMORY_GROWTH is on, so this is a ceiling.
    "-s", "TOTAL_MEMORY=268435456"
    "-s", "ASSERTIONS=0"
    "-s", "NO_FILESYSTEM=1"
    "-msimd128"
    "-ffast-math"
    "-I", "src/odfe"
    "-I", "src/cm"
    "-D", "GAME_INCLUDE"
    "-D", "NDEBUG"
    "-D", "ID_INLINE=inline"
    "-D", "MAC_STATIC="
    "-D", "CPUSTRING=""wasm-emscripten"""
    "-D", "PATH_SEP='/'"
    # NOTE: ENTITYNUM_NONE / ENTITYNUM_WORLD / MASK_PLAYERSOLID are intentionally
    # NOT -D'd here. q_shared.h defines ENTITYNUM_* (via MAX_GENTITIES) and
    # bg_public.h defines the correct MASK_PLAYERSOLID
    # (CONTENTS_SOLID|CONTENTS_PLAYERCLIP|CONTENTS_BODY). The old build forced
    # "-D ENTITYNUM_NONE=1023" and "-D MASK_PLAYERSOLID=1", which both just
    # produced macro-redefinition warnings (the headers won anyway). Dropping
    # them keeps the build warning-clean now that real world collision is wired in.
) + $sources + @("-o", "output/q3physics.js")

# Run emcc
Write-Host "Running: emcc $($emccArgs -join ' ')"
& emcc @emccArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful!" -ForegroundColor Green
    Get-ChildItem output/ | Format-Table Name, Length

    # Copy to wwwroot/js
    $jsDir = "../../wwwroot/js"
    if (-not (Test-Path $jsDir)) {
        New-Item -ItemType Directory -Path $jsDir | Out-Null
    }

    Copy-Item "output/q3physics.js" -Destination "$jsDir/q3physics.js" -Force
    Copy-Item "output/q3physics.wasm" -Destination "$jsDir/q3physics.wasm" -Force
    Write-Host "Copied to wwwroot/js/" -ForegroundColor Green
}
else {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}