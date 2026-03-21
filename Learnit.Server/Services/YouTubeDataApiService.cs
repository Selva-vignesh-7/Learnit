using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;

namespace Learnit.Server.Services
{
    public class YouTubeDataApiService
    {
        private readonly HttpClient _http;
        private readonly string _apiKey;

        public YouTubeDataApiService(HttpClient http, IConfiguration configuration)
        {
            _http = http;
            _http.Timeout = TimeSpan.FromSeconds(15);
            _apiKey = configuration["YouTube:ApiKey"] ?? string.Empty;
        }

        public async Task<UrlMetadata?> TryGetMetadataAsync(string url, CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(_apiKey))
            {
                Console.WriteLine("[YouTubeAPI] No API key configured — skipping Data API");
                return null;
            }
            if (string.IsNullOrWhiteSpace(url))
                return null;

            try
            {
                var playlistId = ExtractPlaylistId(url);
                if (!string.IsNullOrWhiteSpace(playlistId))
                {
                    Console.WriteLine($"[YouTubeAPI] Detected playlist ID: {playlistId}");
                    return await TryGetPlaylistMetadataAsync(playlistId, ct);
                }

                var videoId = ExtractVideoId(url);
                if (!string.IsNullOrWhiteSpace(videoId))
                {
                    Console.WriteLine($"[YouTubeAPI] Detected video ID: {videoId}");
                    return await TryGetVideoMetadataAsync(videoId, ct);
                }

                Console.WriteLine($"[YouTubeAPI] Could not extract video/playlist ID from URL: {url}");
                return null;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[YouTubeAPI] TryGetMetadataAsync failed: {ex.GetType().Name}: {ex.Message}");
                return null;
            }
        }

        private async Task<UrlMetadata?> TryGetVideoMetadataAsync(string videoId, CancellationToken ct)
        {
            var endpoint =
                $"https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id={Uri.EscapeDataString(videoId)}&key={Uri.EscapeDataString(_apiKey)}";

            using var resp = await _http.GetAsync(endpoint, ct);
            if (!resp.IsSuccessStatusCode)
            {
                var errBody = await resp.Content.ReadAsStringAsync(ct);
                Console.WriteLine($"[YouTubeAPI] videos endpoint returned {(int)resp.StatusCode} {resp.ReasonPhrase}: {errBody[..Math.Min(300, errBody.Length)]}");
                return null;
            }
            Console.WriteLine($"[YouTubeAPI] videos endpoint OK for videoId={videoId}");

            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

            var item = doc.RootElement
                .GetProperty("items")
                .EnumerateArray()
                .FirstOrDefault();

            if (item.ValueKind == JsonValueKind.Undefined)
                return null;

            var snippet = item.GetProperty("snippet");
            var contentDetails = item.GetProperty("contentDetails");

            var title = snippet.TryGetProperty("title", out var t) ? (t.GetString() ?? "YouTube Video") : "YouTube Video";
            var description = snippet.TryGetProperty("description", out var d) ? (d.GetString() ?? string.Empty) : string.Empty;
            var author = snippet.TryGetProperty("channelTitle", out var a) ? (a.GetString() ?? string.Empty) : string.Empty;
            var durationIso = contentDetails.TryGetProperty("duration", out var dur) ? (dur.GetString() ?? "PT0M") : "PT0M";
            var totalMinutes = Math.Max(1, ParseIsoDurationMinutes(durationIso));

            var chapters = ParseChaptersFromDescription(description);
            if (!chapters.Any())
            {
                chapters.Add(new ContentSection
                {
                    Title = title,
                    StartTimeSeconds = 0,
                    EstimatedMinutes = totalMinutes
                });
            }

            return new UrlMetadata
            {
                Title = title,
                Description = description,
                Author = author,
                Platform = "YouTube",
                DurationMinutes = totalMinutes,
                Headings = chapters.Select(c => c.Title).ToList(),
                Sections = chapters,
                ThumbnailUrl = TryGetThumbnail(snippet)
            };
        }

        private async Task<UrlMetadata?> TryGetPlaylistMetadataAsync(string playlistId, CancellationToken ct)
        {
            var playlistEndpoint =
                $"https://www.googleapis.com/youtube/v3/playlists?part=snippet&id={Uri.EscapeDataString(playlistId)}&key={Uri.EscapeDataString(_apiKey)}";

            using var playlistResp = await _http.GetAsync(playlistEndpoint, ct);
            if (!playlistResp.IsSuccessStatusCode)
            {
                var errBody = await playlistResp.Content.ReadAsStringAsync(ct);
                Console.WriteLine($"[YouTubeAPI] playlists endpoint returned {(int)playlistResp.StatusCode} {playlistResp.ReasonPhrase}: {errBody[..Math.Min(300, errBody.Length)]}");
                return null;
            }
            Console.WriteLine($"[YouTubeAPI] playlists endpoint OK for playlistId={playlistId}");

            await using var playlistStream = await playlistResp.Content.ReadAsStreamAsync(ct);
            using var playlistDoc = await JsonDocument.ParseAsync(playlistStream, cancellationToken: ct);
            var playlistItem = playlistDoc.RootElement
                .GetProperty("items")
                .EnumerateArray()
                .FirstOrDefault();

            if (playlistItem.ValueKind == JsonValueKind.Undefined)
                return null;

            var playlistSnippet = playlistItem.GetProperty("snippet");
            var playlistTitle = playlistSnippet.TryGetProperty("title", out var t) ? (t.GetString() ?? "YouTube Playlist") : "YouTube Playlist";
            var playlistDescription = playlistSnippet.TryGetProperty("description", out var d) ? (d.GetString() ?? string.Empty) : string.Empty;
            var playlistAuthor = playlistSnippet.TryGetProperty("channelTitle", out var a) ? (a.GetString() ?? string.Empty) : string.Empty;

            var videoItems = await FetchPlaylistItemsAsync(playlistId, ct);
            if (!videoItems.Any())
            {
                return new UrlMetadata
                {
                    Title = playlistTitle,
                    Description = playlistDescription,
                    Author = playlistAuthor,
                    Platform = "YouTube Playlist",
                    DurationMinutes = 0,
                    Headings = new List<string>(),
                    Sections = new List<ContentSection>(),
                    ThumbnailUrl = TryGetThumbnail(playlistSnippet)
                };
            }

            var durationsById = await FetchVideoDurationsAsync(videoItems.Select(v => v.VideoId).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList(), ct);

            var sections = new List<ContentSection>();
            int totalMinutes = 0;

            foreach (var item in videoItems)
            {
                var minutes = durationsById.TryGetValue(item.VideoId, out var m) ? Math.Max(1, m) : 10;
                totalMinutes += minutes;
                sections.Add(new ContentSection
                {
                    Title = item.Title,
                    StartTimeSeconds = null,
                    EstimatedMinutes = minutes
                });
            }

            Console.WriteLine($"[YouTubeAPI] Playlist '{playlistTitle}' built with {sections.Count} sections, {totalMinutes} min total");
            return new UrlMetadata
            {
                Title = playlistTitle,
                Description = playlistDescription,
                Author = playlistAuthor,
                Platform = "YouTube Playlist",
                DurationMinutes = totalMinutes,
                Headings = sections.Select(s => s.Title).ToList(),
                Sections = sections,
                ThumbnailUrl = TryGetThumbnail(playlistSnippet)
            };
        }

        private async Task<List<(string VideoId, string Title)>> FetchPlaylistItemsAsync(string playlistId, CancellationToken ct)
        {
            var results = new List<(string VideoId, string Title)>();
            string? pageToken = null;

            while (results.Count < 200)
            {
                var endpoint =
                    $"https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId={Uri.EscapeDataString(playlistId)}&key={Uri.EscapeDataString(_apiKey)}" +
                    (string.IsNullOrWhiteSpace(pageToken) ? string.Empty : $"&pageToken={Uri.EscapeDataString(pageToken)}");

                using var resp = await _http.GetAsync(endpoint, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var errBody = await resp.Content.ReadAsStringAsync(ct);
                    Console.WriteLine($"[YouTubeAPI] playlistItems endpoint returned {(int)resp.StatusCode}: {errBody[..Math.Min(300, errBody.Length)]}");
                    break;
                }

                await using var stream = await resp.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

                var pageCount = 0;
                foreach (var item in doc.RootElement.GetProperty("items").EnumerateArray())
                {
                    if (!item.TryGetProperty("snippet", out var snippet))
                        continue;

                    var title = snippet.TryGetProperty("title", out var t) ? (t.GetString() ?? "Untitled") : "Untitled";
                    string? videoId = null;

                    if (snippet.TryGetProperty("resourceId", out var resourceId) &&
                        resourceId.TryGetProperty("videoId", out var vid))
                    {
                        videoId = vid.GetString();
                    }

                    if (!string.IsNullOrWhiteSpace(videoId))
                    {
                        results.Add((videoId, title));
                        pageCount++;
                        Console.WriteLine($"[YouTubeAPI]   [{results.Count}] {videoId} => \"{title}\"");
                    }
                }
                Console.WriteLine($"[YouTubeAPI] Fetched {pageCount} items (total so far: {results.Count})");

                pageToken = doc.RootElement.TryGetProperty("nextPageToken", out var token)
                    ? token.GetString()
                    : null;

                if (string.IsNullOrWhiteSpace(pageToken))
                    break;
            }

            return results;
        }

        private async Task<Dictionary<string, int>> FetchVideoDurationsAsync(List<string> videoIds, CancellationToken ct)
        {
            var result = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            if (!videoIds.Any())
                return result;

            for (int i = 0; i < videoIds.Count; i += 50)
            {
                var batch = videoIds.Skip(i).Take(50).ToList();
                var endpoint =
                    $"https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id={Uri.EscapeDataString(string.Join(",", batch))}&key={Uri.EscapeDataString(_apiKey)}";

                using var resp = await _http.GetAsync(endpoint, ct);
                if (!resp.IsSuccessStatusCode)
                    continue;

                await using var stream = await resp.Content.ReadAsStreamAsync(ct);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

                foreach (var item in doc.RootElement.GetProperty("items").EnumerateArray())
                {
                    var id = item.TryGetProperty("id", out var idProp) ? idProp.GetString() : null;
                    var durationIso = item.TryGetProperty("contentDetails", out var cd) && cd.TryGetProperty("duration", out var d)
                        ? d.GetString()
                        : null;

                    if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(durationIso))
                    {
                        result[id] = Math.Max(1, ParseIsoDurationMinutes(durationIso));
                    }
                }
            }

            return result;
        }

        private static int ParseIsoDurationMinutes(string isoDuration)
        {
            if (string.IsNullOrWhiteSpace(isoDuration))
                return 0;

            var match = Regex.Match(
                isoDuration,
                @"^PT(?:(?<h>\d+)H)?(?:(?<m>\d+)M)?(?:(?<s>\d+)S)?$",
                RegexOptions.IgnoreCase);

            if (!match.Success)
                return 0;

            int hours = match.Groups["h"].Success ? int.Parse(match.Groups["h"].Value) : 0;
            int minutes = match.Groups["m"].Success ? int.Parse(match.Groups["m"].Value) : 0;
            int seconds = match.Groups["s"].Success ? int.Parse(match.Groups["s"].Value) : 0;

            var totalMinutes = (hours * 60) + minutes + (int)Math.Ceiling(seconds / 60.0);
            return totalMinutes;
        }

        private static List<ContentSection> ParseChaptersFromDescription(string description)
        {
            var chapters = new List<ContentSection>();
            if (string.IsNullOrWhiteSpace(description))
                return chapters;

            var lines = description.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            var seen = new HashSet<int>();

            foreach (var raw in lines)
            {
                var line = raw.Trim();
                var match = Regex.Match(
                    line,
                    @"^(?:[-*•]\s*)?(?:(?<h>\d{1,2}):)?(?<m>[0-5]?\d):(?<s>[0-5]\d)\s*(?:[-–—|:]\s*)?(?<title>.+)?$",
                    RegexOptions.IgnoreCase);
                if (!match.Success)
                    continue;

                int h = match.Groups["h"].Success ? int.Parse(match.Groups["h"].Value) : 0;
                int m = int.Parse(match.Groups["m"].Value);
                int s = int.Parse(match.Groups["s"].Value);
                int startSeconds = h * 3600 + m * 60 + s;

                if (!seen.Add(startSeconds))
                    continue;

                var title = match.Groups["title"].Success
                    ? match.Groups["title"].Value.Trim()
                    : string.Empty;

                chapters.Add(new ContentSection
                {
                    Title = string.IsNullOrWhiteSpace(title) ? "Chapter" : title,
                    StartTimeSeconds = startSeconds,
                    EstimatedMinutes = null
                });
            }

            chapters = chapters.OrderBy(c => c.StartTimeSeconds ?? 0).ToList();
            for (int i = 0; i < chapters.Count - 1; i++)
            {
                var current = chapters[i];
                var next = chapters[i + 1];
                if (current.StartTimeSeconds.HasValue && next.StartTimeSeconds.HasValue)
                {
                    var mins = Math.Max(1, (int)Math.Ceiling((next.StartTimeSeconds.Value - current.StartTimeSeconds.Value) / 60.0));
                    current.EstimatedMinutes = mins;
                }
            }

            return chapters;
        }

        private static string? TryGetThumbnail(JsonElement snippet)
        {
            if (!snippet.TryGetProperty("thumbnails", out var thumbs))
                return null;

            foreach (var key in new[] { "maxres", "standard", "high", "medium", "default" })
            {
                if (thumbs.TryGetProperty(key, out var node) && node.TryGetProperty("url", out var url))
                    return url.GetString();
            }

            return null;
        }

        private static string? ExtractVideoId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var match = Regex.Match(url, @"(?:v=|/embed/|youtu\.be/)([\w-]{11})", RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value : null;
        }

        private static string? ExtractPlaylistId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var match = Regex.Match(url, @"[?&]list=([a-zA-Z0-9_-]+)", RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value : null;
        }
    }
}
