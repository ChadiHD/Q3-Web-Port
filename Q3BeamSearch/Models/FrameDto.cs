namespace Q3BeamSearch.Models
{
    public sealed class FrameDto
    {
        public int Frame { get; init; }
        public double X { get; init; }
        public double Y { get; init; }
        public double Z { get; init; }
        public double Speed { get; init; }
        public bool OnGround { get; init; }
        public double YawDeg { get; init; }
        public int Buttons { get; set; }        // Button bitmask from usercmd_t
        public sbyte ForwardMove { get; set; }  // Forward/back input
        public sbyte RightMove { get; set; }    // Left/right strafe input
        public byte UpMove { get; set; }       // Jump/crouch input
    }
}
