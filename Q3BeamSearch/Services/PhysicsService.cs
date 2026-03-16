/*// Services/PhysicsService.cs
public partial class PhysicsService
{
    // Call into WebAssembly Q3 physics for accurate simulation
    [JSImport("simulateFrame", "q3physics")]
    public static partial void SimulateFrame(
        ref PlayerState state,
        ref Input input
    );

    [JSImport("simulateSequence", "q3physics")]
    public static partial string SimulateSequence(
        string initialState,
        string inputSequence
    );
}*/