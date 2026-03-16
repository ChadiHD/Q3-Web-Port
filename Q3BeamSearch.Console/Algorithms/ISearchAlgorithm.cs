namespace Q3BeamSearch.Algorithms
{
    public interface ISearchAlgorithm
    {
        string Name { get; }
        (double[] best, double score) Optimize(int frames, int seed);
    }
}