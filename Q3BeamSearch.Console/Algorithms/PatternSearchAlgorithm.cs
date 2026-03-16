using Q3BeamSearch.Algorithms;

namespace Q3BeamSearch.Algorithms
{
    public class PatternSearchAlgorithm : ISearchAlgorithm
    {
        public string Name => "PatternSearch";
        public (double[] best, double score) Optimize(int frames, int seed)
        {
            return Q3BeamSearch.PatternSearch.Optimize(frames, targetJumps: 30, maxEvals: 1000, seed: seed);
        }
    }
}