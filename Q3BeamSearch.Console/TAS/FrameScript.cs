// TAS/FrameScript.cs - Core TAS script data structures for Q3 Arena
using System.Text.Json;

namespace Q3BeamSearch.TAS
{
    /// <summary>
    /// Represents a single frame's input and commands in a TAS script
    /// </summary>
    public class FrameBlock
    {
        public int Frame { get; set; } = 0;
        public bool Parsed { get; set; } = true;
        
        // Movement inputs for this frame
        public Dictionary<string, float> ConVars { get; set; } = new();
        public Dictionary<string, bool> Toggles { get; set; } = new();
        public List<string> Commands { get; set; } = new();
        
        // Q3-specific movement data
        public sbyte ForwardMove { get; set; } = 0;  // -1, 0, 1
        public sbyte RightMove { get; set; } = 0;    // -1, 0, 1
        public byte Jump { get; set; } = 0;          // 0, 1
        public double YawDelta { get; set; } = 0.0;  // degrees per frame
        
        public void AddCommand(string command)
        {
            Commands.Add(command);
        }
        
        public void SetMovement(sbyte forward, sbyte right, byte jump, double yawDelta)
        {
            ForwardMove = forward;
            RightMove = right;
            Jump = jump;
            YawDelta = yawDelta;
        }
        
        public void SetConVar(string name, float value)
        {
            ConVars[name] = value;
        }
        
        public void SetToggle(string name, bool value)
        {
            Toggles[name] = value;
        }
        
        public Input ToInput()
        {
            return new Input
            {
                Fwd = ForwardMove,
                Str = RightMove,
                Jump = Jump,
                YawDeltaDeg = YawDelta
            };
        }
        
        public string GetCommandString()
        {
            var parts = new List<string>();
            
            // Add movement
            if (ForwardMove != 0 || RightMove != 0 || Jump != 0 || Math.Abs(YawDelta) > 1e-6)
            {
                parts.Add($"move {ForwardMove} {RightMove} {Jump} {YawDelta:F3}");
            }
            
            // Add convars
            foreach (var cvar in ConVars)
            {
                parts.Add($"{cvar.Key} {cvar.Value}");
            }
            
            // Add toggles
            foreach (var toggle in Toggles)
            {
                parts.Add($"{(toggle.Value ? "+" : "-")}{toggle.Key}");
            }
            
            // Add custom commands
            parts.AddRange(Commands);
            
            return string.Join("; ", parts);
        }
    }
    
    /// <summary>
    /// A complete TAS script containing multiple frame blocks
    /// </summary>
    public class TASScript
    {
        public string FileName { get; set; } = "";
        public List<FrameBlock> Blocks { get; set; } = new();
        public DateTime LastEdited { get; set; } = DateTime.Now;
        
        public TASScript() { }
        
        public TASScript(string fileName)
        {
            FileName = fileName;
        }
        
        public bool LoadFromFile()
        {
            try
            {
                if (!File.Exists(FileName))
                    return false;
                    
                var json = File.ReadAllText(FileName);
                var script = JsonSerializer.Deserialize<TASScript>(json);
                if (script != null)
                {
                    Blocks = script.Blocks;
                    LastEdited = script.LastEdited;
                    return true;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error loading TAS script: {ex.Message}");
            }
            return false;
        }
        
        public void WriteToFile()
        {
            try
            {
                LastEdited = DateTime.Now;
                var options = new JsonSerializerOptions
                {
                    WriteIndented = true
                };
                var json = JsonSerializer.Serialize(this, options);
                
                // Ensure directory exists
                var dir = Path.GetDirectoryName(FileName);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                
                File.WriteAllText(FileName, json);
                Console.WriteLine($"TAS script saved to {FileName}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error saving TAS script: {ex.Message}");
            }
        }
        
        public void Prune(int minFrame, int maxFrame = int.MaxValue)
        {
            Blocks.RemoveAll(b => b.Frame < minFrame || b.Frame > maxFrame);
            LastEdited = DateTime.Now;
        }
        
        public void RemoveBlocksAfterFrame(int frame)
        {
            Blocks.RemoveAll(b => b.Frame > frame);
            LastEdited = DateTime.Now;
        }
        
        public FrameBlock? GetBlockForFrame(int frame)
        {
            return Blocks.FirstOrDefault(b => b.Frame == frame);
        }
        
        public int GetLastFrame()
        {
            return Blocks.Count > 0 ? Blocks.Max(b => b.Frame) : 0;
        }
        
        public void AddScript(TASScript other, int startFrame)
        {
            foreach (var block in other.Blocks)
            {
                var newBlock = new FrameBlock
                {
                    Frame = block.Frame + startFrame,
                    ForwardMove = block.ForwardMove,
                    RightMove = block.RightMove,
                    Jump = block.Jump,
                    YawDelta = block.YawDelta,
                    ConVars = new Dictionary<string, float>(block.ConVars),
                    Toggles = new Dictionary<string, bool>(block.Toggles),
                    Commands = new List<string>(block.Commands)
                };
                
                // Remove existing block at this frame if any
                Blocks.RemoveAll(b => b.Frame == newBlock.Frame);
                
                // Insert in sorted order
                var insertIndex = Blocks.FindIndex(b => b.Frame > newBlock.Frame);
                if (insertIndex == -1)
                    Blocks.Add(newBlock);
                else
                    Blocks.Insert(insertIndex, newBlock);
            }
            LastEdited = DateTime.Now;
        }
    }
}