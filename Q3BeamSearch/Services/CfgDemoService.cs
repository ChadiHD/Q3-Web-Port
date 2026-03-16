using Newtonsoft.Json;
using Q3BeamSearch.Models;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Q3BeamSearch.Services
{
    public class CfgDemoService
    {
        private readonly IWebHostEnvironment _env;

        public CfgDemoService(IWebHostEnvironment env)
        {
            _env = env;
        }

        /// <summary>
        /// Get demo frames for any supported file type
        /// </summary>
        public async Task<List<FrameDto>?> GetDemoFrames(string fileName)
        {
            string demosDir = Path.Combine(_env.ContentRootPath, "wwwroot", "demos");
            string filePath = Path.Combine(demosDir, fileName);
            
            if (!File.Exists(filePath)) return null;

            // Check if it's a CFG file or JSON file
            if (fileName.EndsWith(".cfg", StringComparison.OrdinalIgnoreCase))
            {
                return await ParseCfgToDemo(filePath);
            }
            else if (fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                var json = await File.ReadAllTextAsync(filePath);
                return JsonConvert.DeserializeObject<List<FrameDto>>(json) ?? new List<FrameDto>();
            }

            return null;
        }

        /// <summary>
        /// Get demo statistics
        /// </summary>
        public async Task<object> GetDemoStats(string fileName)
        {
            var frames = await GetDemoFrames(fileName);
            if (frames == null || frames.Count == 0)
            {
                return new { error = "No frames found" };
            }

            var maxSpeed = frames.Max(f => f.Speed);
            var finalSpeed = frames.Last().Speed;
            var totalDistance = Math.Sqrt(Math.Pow(frames.Last().X - frames.First().X, 2) + 
                                         Math.Pow(frames.Last().Y - frames.First().Y, 2));
            var jumps = CountJumps(frames);

            return new
            {
                totalFrames = frames.Count,
                duration = $"{frames.Count / 125.0:F2}s", // 125 FPS
                maxSpeed = $"{maxSpeed:F1} ups",
                finalSpeed = $"{finalSpeed:F1} ups",
                totalDistance = $"{totalDistance:F1} units",
                jumps,
                finalPosition = new { x = frames.Last().X, y = frames.Last().Y, z = frames.Last().Z }
            };
        }

        /// <summary>
        /// Parse a movement.cfg file and convert to demo frames
        /// </summary>
        private async Task<List<FrameDto>> ParseCfgToDemo(string cfgFilePath)
        {
            var lines = await File.ReadAllLinesAsync(cfgFilePath);
            var frames = new List<FrameDto>();
            
            // Parse the CFG and simulate the movement
            var inputs = ParseCfgToInputs(lines);

            // Simulate the movement to generate demo frames
            var ps = new PlayerState
            {
                Pos = new Vec3(0, 0, 0),
                Vel = new Vec3(0, 0, 0),
                YawDeg = 0,
                OnGround = true // ✅ Start on ground!
            };
            for (int i = 0; i < inputs.Count; i++)
            {
                var input = inputs[i];
                Physics.Step(ps, input);
                
                double speedXY = Math.Sqrt(ps.Vel.X * ps.Vel.X + ps.Vel.Y * ps.Vel.Y);
                var frameDto = new FrameDto
                {
                    Frame = i,
                    X = ps.Pos.X,
                    Y = ps.Pos.Y,
                    Z = ps.Pos.Z,
                    Speed = speedXY,
                    OnGround = ps.OnGround,
                    YawDeg = ps.YawDeg,

                    Buttons = 0, // No button info in Input, set to 0 or map if available
                    ForwardMove = input.Fwd,
                    RightMove = input.Str,
                    UpMove = input.Jump
                };
                frames.Add(frameDto);
            }
            
            return frames;
        }

        /// <summary>
        /// Parse CFG commands to Input sequence
        /// </summary>
        private List<Input> ParseCfgToInputs(string[] lines)
        {
            var inputs = new List<Input>();
            
            // State tracking
            bool forwardHeld = false, backHeld = false;
            bool moveLeftHeld = false, moveRightHeld = false;
            bool leftTurnHeld = false, rightTurnHeld = false;
            bool moveUpHeld = false, moveDownHeld = false;
            bool jumpPulseThisFrame = false; // NEW: Track jump pulse
            double currentYawSpeed = 140.0;
            
            foreach (var line in lines)
            {
                var trimmed = line.Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("//"))
                    continue;

                // Split commands separated by semicolons
                var commands = trimmed.Split(';', StringSplitOptions.RemoveEmptyEntries);
                
                foreach (var cmd in commands)
                {
                    var command = cmd.Trim();
                    
                    switch (command)
                    {
                        case String when command.StartsWith("seta cl_yawspeed "):
                            var match = Regex.Match(command, @"seta cl_yawspeed\s+([\d.]+)");
                            if (match.Success && double.TryParse(match.Groups[1].Value, out double yawSpeed))
                            {
                                currentYawSpeed = yawSpeed;
                            }
                            break;
                            
                        case "+forward":
                            forwardHeld = true;
                            break;
                        case "-forward":
                            forwardHeld = false;
                            break;
                        case "+back":
                            backHeld = true;
                            break;
                        case "-back":
                            backHeld = false;
                            break;
                        case "+moveleft":
                            moveLeftHeld = true;
                            break;
                        case "-moveleft":
                            moveLeftHeld = false;
                            break;
                        case "+moveright":
                            moveRightHeld = true;
                            break;
                        case "-moveright":
                            moveRightHeld = false;
                            break;
                        case "+left":
                            leftTurnHeld = true;
                            break;
                        case "-left":
                            leftTurnHeld = false;
                            break;
                        case "+right":
                            rightTurnHeld = true;
                            break;
                        case "-right":
                            rightTurnHeld = false;
                            break;
                            
                        // ============================================
                        // Handle +moveup as a PULSE
                        // ============================================
                        case "+moveup":
                            if (!moveUpHeld) // Only trigger on initial press
                            {
                                jumpPulseThisFrame = true;
                            }
                            moveUpHeld = true;
                            break;
                        case "-moveup":
                            moveUpHeld = false;
                            break;
                            
                        case "+movedown":
                            moveDownHeld = true;
                            break;
                        case "-movedown":
                            moveDownHeld = false;
                            break;
                            
                        case String when command.StartsWith("wait "):
                            var matchFound = Regex.Match(command, @"wait\s+(\d+)");
                            if (matchFound.Success && int.TryParse(matchFound.Groups[1].Value, out int waitUnits))
                            {
                                // Each wait unit is 2 frames in the CFG (wait 2 = 1 frame at 125fps)
                                int frameCount = Math.Max(1, waitUnits / 2);

                                // Calculate current input state
                                sbyte fwd = (sbyte)(forwardHeld ? 1 : (backHeld ? -1 : 0));
                                sbyte str = (sbyte)(moveRightHeld ? 1 : (moveLeftHeld ? -1 : 0));

                                // Calculate yaw delta
                                double yawDelta = 0;
                                if (leftTurnHeld || rightTurnHeld)
                                {
                                    double yawPerFrame = currentYawSpeed / Q3.FPS;
                                    yawDelta = leftTurnHeld ? yawPerFrame : -yawPerFrame;
                                }

                                // Add frames for the wait period
                                for (int i = 0; i < frameCount; i++)
                                {
                                    // ============================================
                                    // Apply jump pulse only to first frame of wait period
                                    // ============================================
                                    byte jump = (byte)((i == 0 && jumpPulseThisFrame) ? 1 : 0);
                                    
                                    inputs.Add(new Input
                                    {
                                        Fwd = fwd,
                                        Str = str,
                                        Jump = jump, // NOW CORRECTLY SET
                                        YawDeltaDeg = yawDelta
                                    });
                                }
                                
                                // Reset jump pulse after processing
                                jumpPulseThisFrame = false;
                            }
                            break;
                    }
                }
            }
            
            return inputs;
        }

        /// <summary>
        /// Convert exported CFG files from console app to web-compatible JSON demos
        /// </summary>
        public async Task ConvertConsoleCfgFiles()
        {
            var demosDir = Path.Combine(_env.ContentRootPath, "wwwroot", "demos");
            Directory.CreateDirectory(demosDir);
            
            // Look for movement.cfg in various locations
            var possiblePaths = new[]
            {
                Path.Combine(_env.ContentRootPath, "wwwroot", "movement.cfg"),
                Path.Combine(_env.ContentRootPath, "..", "Q3BeamSearch.Console", "movement.cfg"),
                Path.Combine(Directory.GetCurrentDirectory(), "movement.cfg"),
                Path.Combine(Environment.CurrentDirectory, "movement.cfg")
            };
            
            foreach (var cfgPath in possiblePaths)
            {
                if (File.Exists(cfgPath))
                {
                    try
                    {
                        Console.WriteLine($"Found CFG file: {cfgPath}");
                        var frames = await ParseCfgToDemo(cfgPath);
                        
                        var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss");
                        var jsonFileName = $"movement_{timestamp}.json";
                        var cfgFileName = $"movement_{timestamp}.cfg";
                        
                        // Save as JSON for web simulation
                        var jsonPath = Path.Combine(demosDir, jsonFileName);
                        var json = JsonConvert.SerializeObject(frames, Formatting.None);
                        await File.WriteAllTextAsync(jsonPath, json);
                        
                        // Copy original CFG for direct access
                        var cfgDestPath = Path.Combine(demosDir, cfgFileName);
                        File.Copy(cfgPath, cfgDestPath, true);
                        
                        Console.WriteLine($"Converted {Path.GetFileName(cfgPath)} to {jsonFileName} ({frames.Count} frames)");
                        Console.WriteLine($"Copied original CFG to {cfgFileName}");
                    }  
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Error converting {cfgPath}: {ex.Message}");
                    }
                }
            }
        }

        /// <summary>
        /// Convert a specific CFG file to JSON demo format
        /// </summary>
        public async Task ConvertCfgToJson(string cfgPath, string jsonPath)
        {
            var frames = await ParseCfgToDemo(cfgPath);
            var json = JsonConvert.SerializeObject(frames, Formatting.None);
            await File.WriteAllTextAsync(jsonPath, json);
        }

        /// <summary>
        /// Count the number of jumps in the demo frames
        /// </summary>
        public int CountJumps(List<FrameDto> frames)
        {
            int jumpCount = 0;
            bool wasJumping = false;
            
            foreach (var frame in frames)
            {
                // Count when upMove transitions from 0 to positive (new jump press)
                bool isJumping = frame.UpMove > 0;
                
                if (isJumping && !wasJumping)
                {
                    jumpCount++;
                }
                
                wasJumping = isJumping;
            }
            
            return jumpCount;
        }
    }
}