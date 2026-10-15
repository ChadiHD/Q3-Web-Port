using Microsoft.AspNetCore.StaticFiles;
using System.Text.RegularExpressions;

namespace Q3BeamSearch
{
    public static class WebMain
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            builder.Services.AddHttpClient("defragProxy", c =>
            {
                c.Timeout = TimeSpan.FromSeconds(60);
                c.DefaultRequestHeaders.UserAgent.ParseAdd("Q3TASViewer/2.0");
            });

            var app = builder.Build();

            // The site opens on the v2 viewer (the run-statistics dashboard is /stats.html).
            // A redirect, not a rewrite, so the page's relative ../js/ paths resolve.
            app.MapGet("/", () => Results.Redirect("/html/viewer3d-v2.html"));

            var provider = new FileExtensionContentTypeProvider();
            provider.Mappings[".wasm"] = "application/wasm";

            app.UseStaticFiles(new StaticFileOptions
            {
                ContentTypeProvider = provider,
                // The ES modules import each other without version tags. Without this the browser
                // caches them heuristically (for days, from Last-Modified) and mixes old and new
                // modules after an edit. no-cache = revalidate every load (cheap 304 via ETag).
                OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache"
            });

            // The JSON runs saved under wwwroot/demos, for the stats dashboard's list
            // (it fetches each one as a static file, /demos/<name>).
            app.MapGet("/demos", () =>
            {
                var demosDir = Path.Combine(app.Environment.WebRootPath, "demos");
                if (!Directory.Exists(demosDir)) return Results.Json(Array.Empty<string>());
                return Results.Json(Directory.GetFiles(demosDir, "*.json").Select(Path.GetFileName).OrderByDescending(f => f).ToArray());
            });

            // Proxy endpoint: fetches a .pk3 from defrag.racing and streams it to the client.
            // Only the defrag.racing host is permitted to prevent SSRF.
            app.MapGet("/api/map-proxy", async (string mapname, IHttpClientFactory httpFactory) =>
            {
                // Strip any path separators to prevent directory traversal
                var safe = Regex.Replace(mapname.Trim(), @"[/\\]", "");
                if (string.IsNullOrEmpty(safe) || !Regex.IsMatch(safe, @"^[\w\-\.]+$", RegexOptions.IgnoreCase))
                    return Results.BadRequest("Invalid map name. Must be a valid *.pk3 filename.");

                var url = $"https://defrag.racing/maps/download/{safe.Replace(".pk3", "", StringComparison.OrdinalIgnoreCase)}";
                try
                {
                    using var client = httpFactory.CreateClient("defragProxy");
                    using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                    if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                        return Results.NotFound($"Map '{safe}' not found on defrag.racing");
                    response.EnsureSuccessStatusCode();
                    var bytes = await response.Content.ReadAsByteArrayAsync();
                    return Results.File(bytes, "application/octet-stream", safe);
                }
                catch (HttpRequestException ex)
                {
                    return Results.Problem($"Failed to fetch map: {ex.Message}");
                }
            });

            app.Run();
        }
    }
}
