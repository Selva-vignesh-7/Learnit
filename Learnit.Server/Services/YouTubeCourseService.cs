using Learnit.Server.Models;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Learnit.Server.Services
{
    public class YouTubeCourseService
    {
        private readonly UrlMetadataService _urlMetadata;
        private readonly YouTubeDataApiService _youtubeApi;

        public YouTubeCourseService(UrlMetadataService urlMetadata, YouTubeDataApiService youtubeApi)
        {
            _urlMetadata = urlMetadata;
            _youtubeApi = youtubeApi;
        }

        public async Task<AiCourseGenerateResponse> CreateCourseFromUrlAsync(
            string url, 
            string? userTitle = null, 
            string? userDescription = null,
            CancellationToken cancellationToken = default)
        {
            // Prefer official YouTube Data API v3 metadata; fallback to existing extractor.
            var metadata = await _youtubeApi.TryGetMetadataAsync(url, cancellationToken)
                ?? await _urlMetadata.TryGetMetadataAsync(url, cancellationToken);
            
            if (metadata == null)
            {
                throw new InvalidOperationException($"Failed to extract metadata from YouTube URL: {url}");
            }

            var isYouTube = metadata.Platform == "YouTube" || metadata.Platform == "YouTube Playlist";
            if (!isYouTube)
            {
                throw new InvalidOperationException($"URL is not a YouTube video or playlist: {url}");
            }

            var response = new AiCourseGenerateResponse
            {
                Title = userTitle ?? metadata.Title ?? "YouTube Course",
                Description = userDescription ?? (metadata.Description?.Length > 500 
                    ? metadata.Description.Substring(0, 500) + "..." 
                    : metadata.Description ?? ""),
                SubjectArea = "Other",
                LearningObjectives = "Complete the YouTube course content",
                Difficulty = "Intermediate",
                Priority = "Medium",
                TargetCompletionDate = DateTime.UtcNow.AddDays(28).ToString("yyyy-MM-dd"),
                Notes = "",
                Modules = new List<AiModuleDraft>()
            };

            var isPlaylist = metadata.Platform == "YouTube Playlist";
            var videoId = ExtractYouTubeVideoId(url);
            var playlistId = ExtractYouTubePlaylistId(url);

            if (isPlaylist)
            {
                // PLAYLIST: Each video = 1 module (NO submodules)
                if (metadata.Sections == null || !metadata.Sections.Any())
                {
                    // Fallback: Create single module for entire playlist
                    var totalMinutes = metadata.DurationMinutes ?? 30;
                    var studyMinutes = totalMinutes * 1.15; // 15% buffer
                    var studyHours = Math.Max(1, (int)Math.Round(studyMinutes / 60.0));

                    var videoMetadata = new
                    {
                        videoUrl = url,
                        videoId = (string?)null,
                        playlistId = playlistId,
                        durationSeconds = (int)(totalMinutes * 60),
                        order = 0
                    };

                    response.Modules.Add(new AiModuleDraft
                    {
                        Title = CleanText(metadata.Title) ?? "Playlist",
                        Description = $"YouTube Playlist: {CleanText(metadata.Title) ?? "Complete playlist"}",
                        EstimatedHours = studyHours,
                        Notes = JsonSerializer.Serialize(videoMetadata),
                        SubModules = new List<AiSubModuleDraft>() // NO submodules for YouTube
                    });

                    response.TotalEstimatedHours = studyHours;
                }
                else
                {
                    // Create one module per video in playlist
                    var totalPlaylistMinutes = metadata.Sections.Sum(s => s.EstimatedMinutes ?? 15);
                    var totalStudyMinutes = totalPlaylistMinutes * 1.15; // 15% buffer
                    var totalStudyHours = Math.Max(0.1, totalStudyMinutes / 60.0);

                    for (int sectionIdx = 0; sectionIdx < metadata.Sections.Count; sectionIdx++)
                    {
                        var section = metadata.Sections[sectionIdx];
                        var videoMinutes = section.EstimatedMinutes ?? 15;
                        var videoDurationSeconds = (videoMinutes * 60);
                        var videoProportion = (double)videoMinutes / totalPlaylistMinutes;
                        var studyHours = Math.Max(0.1, totalStudyHours * videoProportion);
                        var moduleHours = Math.Max(1, (int)Math.Round(studyHours));

                        // Extract video ID from section title if available
                        string? sectionVideoId = null;
                        if (!string.IsNullOrWhiteSpace(section.Title))
                        {
                            var videoIdMatch = Regex.Match(
                                section.Title,
                                @"(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})",
                                RegexOptions.IgnoreCase
                            );
                            if (videoIdMatch.Success)
                            {
                                sectionVideoId = videoIdMatch.Groups[1].Value;
                            }
                        }

                        var moduleTitle = NormalizeModuleTitle(section.Title, $"Video {sectionIdx + 1}");

                        var videoMetadata = new
                        {
                            videoUrl = playlistId != null ? $"https://www.youtube.com/playlist?list={playlistId}" : url,
                            videoId = sectionVideoId,
                            playlistId = playlistId,
                            durationSeconds = (int)videoDurationSeconds,
                            order = response.Modules.Count
                        };

                        response.Modules.Add(new AiModuleDraft
                        {
                            Title = moduleTitle,
                            Description = $"Video: {moduleTitle}",
                            EstimatedHours = moduleHours,
                            Notes = JsonSerializer.Serialize(videoMetadata),
                            SubModules = new List<AiSubModuleDraft>() // NO submodules for YouTube
                        });
                    }

                    response.TotalEstimatedHours = Math.Max(1, (int)Math.Round(totalStudyMinutes / 60.0));
                }
            }
            else
            {
                // SINGLE VIDEO: Each chapter/section = 1 module (NO submodules)
                var totalVideoMinutes = metadata.DurationMinutes ?? 30;
                var totalVideoDurationSeconds = (totalVideoMinutes * 60);
                var totalStudyMinutes = totalVideoMinutes * 1.15; // 15% buffer
                var totalStudyHours = Math.Max(0.1, totalStudyMinutes / 60.0);

                if (metadata.Sections != null && metadata.Sections.Any())
                {
                    // Create 1 module per chapter/section
                    var validSections = metadata.Sections
                        .Select((s, idx) => new { Section = s, Index = idx })
                        .Where(x => !string.IsNullOrWhiteSpace(x.Section.Title) || x.Section.StartTimeSeconds.HasValue)
                        .ToList();

                    if (validSections.Count == 0)
                    {
                        validSections = metadata.Sections.Select((s, idx) => new { Section = s, Index = idx }).ToList();
                    }

                    // Calculate section durations
                    var sectionDurations = new List<int>();
                    for (int i = 0; i < validSections.Count; i++)
                    {
                        var section = validSections[i].Section;
                        int sectionMinutes;
                        if (section.EstimatedMinutes.HasValue && section.EstimatedMinutes.Value > 0)
                        {
                            sectionMinutes = section.EstimatedMinutes.Value;
                        }
                        else if (i < validSections.Count - 1 && section.StartTimeSeconds.HasValue && validSections[i + 1].Section.StartTimeSeconds.HasValue)
                        {
                            var durationSeconds = validSections[i + 1].Section.StartTimeSeconds.Value - section.StartTimeSeconds.Value;
                            sectionMinutes = Math.Max(1, (int)Math.Ceiling(durationSeconds / 60.0));
                        }
                        else if (section.StartTimeSeconds.HasValue && i == validSections.Count - 1)
                        {
                            // Last section: use remaining time
                            var remainingSeconds = totalVideoDurationSeconds - section.StartTimeSeconds.Value;
                            sectionMinutes = Math.Max(1, (int)Math.Ceiling(remainingSeconds / 60.0));
                        }
                        else
                        {
                            sectionMinutes = Math.Max(1, (int)Math.Ceiling((double)totalVideoMinutes / validSections.Count));
                        }
                        sectionDurations.Add(sectionMinutes);
                    }

                    var totalSectionMinutes = sectionDurations.Sum();
                    if (totalSectionMinutes == 0) totalSectionMinutes = totalVideoMinutes;

                    for (int i = 0; i < validSections.Count; i++)
                    {
                        var section = validSections[i].Section;
                        var sectionMinutes = sectionDurations[i];
                        var sectionDurationSeconds = sectionMinutes * 60;

                        var sectionProportion = totalSectionMinutes > 0 ? (double)sectionMinutes / totalSectionMinutes : (1.0 / validSections.Count);
                        var studyHours = Math.Max(0.1, totalStudyHours * sectionProportion);
                        var moduleHours = Math.Max(1, (int)Math.Round(studyHours));

                        var videoMetadata = new
                        {
                            videoUrl = url,
                            videoId = videoId ?? "",
                            playlistId = (string?)null,
                            durationSeconds = sectionDurationSeconds,
                            startTimeSeconds = section.StartTimeSeconds,
                            order = i
                        };

                        var moduleTitle = CleanText(section.Title);
                        if (string.IsNullOrWhiteSpace(moduleTitle))
                        {
                            moduleTitle = section.StartTimeSeconds.HasValue 
                                ? $"Chapter {i + 1} ({TimeSpan.FromSeconds(section.StartTimeSeconds.Value):hh\\:mm\\:ss})"
                                : $"Chapter {i + 1}";
                        }

                        response.Modules.Add(new AiModuleDraft
                        {
                            Title = moduleTitle,
                            Description = $"Chapter {i + 1}: {moduleTitle}",
                            EstimatedHours = moduleHours,
                            Notes = JsonSerializer.Serialize(videoMetadata),
                            SubModules = new List<AiSubModuleDraft>() // NO submodules for YouTube
                        });
                    }

                    response.TotalEstimatedHours = Math.Max(1, (int)Math.Round(totalStudyMinutes / 60.0));
                }
                else
                {
                    // No chapters found - create 1 module for entire video
                    var studyHours = Math.Max(1, (int)Math.Round(totalStudyHours));

                    var videoMetadata = new
                    {
                        videoUrl = url,
                        videoId = videoId ?? "",
                        playlistId = (string?)null,
                        durationSeconds = (int)totalVideoDurationSeconds,
                        order = 0
                    };

                    response.Modules.Add(new AiModuleDraft
                    {
                        Title = CleanText(metadata.Title) ?? "Complete Video",
                        Description = $"YouTube Video: {CleanText(metadata.Title) ?? "Watch the entire video"}",
                        EstimatedHours = studyHours,
                        Notes = JsonSerializer.Serialize(videoMetadata),
                        SubModules = new List<AiSubModuleDraft>() // NO submodules for YouTube
                    });

                    response.TotalEstimatedHours = studyHours;
                }
            }

            // Ensure at least one module exists
            if (response.Modules == null || !response.Modules.Any())
            {
                var totalMinutes = metadata.DurationMinutes ?? 30;
                var studyMinutes = totalMinutes * 1.15;
                var studyHours = Math.Max(1, (int)Math.Round(studyMinutes / 60.0));

                var videoMetadata = new
                {
                    videoUrl = url,
                    videoId = videoId ?? "",
                    playlistId = playlistId,
                    durationSeconds = (int)(totalMinutes * 60),
                    order = 0
                };

                response.Modules = new List<AiModuleDraft>
                {
                    new AiModuleDraft
                    {
                        Title = CleanText(metadata.Title) ?? "Complete Video",
                        Description = $"YouTube Video: {CleanText(metadata.Title) ?? "Watch the entire video"}",
                        EstimatedHours = studyHours,
                        Notes = JsonSerializer.Serialize(videoMetadata),
                        SubModules = new List<AiSubModuleDraft>() // NO submodules for YouTube
                    }
                };
                response.TotalEstimatedHours = studyHours;
            }

            return response;
        }

        private static string? ExtractYouTubeVideoId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var match = Regex.Match(url, @"(?:v=|\/embed\/|youtu\.be\/)([\w-]{11})");
            return match.Success ? match.Groups[1].Value : null;
        }

        private static string? ExtractYouTubePlaylistId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var match = Regex.Match(url, @"[?&]list=([a-zA-Z0-9_-]+)");
            return match.Success ? match.Groups[1].Value : null;
        }

        private static string NormalizeModuleTitle(string? text, string fallback)
        {
            var cleaned = CleanText(text);
            if (string.IsNullOrWhiteSpace(cleaned))
                return fallback;

            var lowered = cleaned.Trim().ToLowerInvariant();
            if (lowered is "private video" or "deleted video" or "video unavailable")
                return fallback;

            return cleaned;
        }

        private static string CleanText(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return text ?? "";

            var decoded = WebUtility.HtmlDecode(text).Trim();

            // Strip leading bullet markers
            decoded = Regex.Replace(decoded, @"^[-*•]\s+", string.Empty);

            // Strip leading timestamp prefixes like 00:00, 0:00 - Intro, 01:02:03 | Topic
            decoded = Regex.Replace(
                decoded,
                @"^(?:\d{1,2}:)?[0-5]?\d:[0-5]\d\s*(?:[-–—|:]\s*)?",
                string.Empty,
                RegexOptions.IgnoreCase);

            // Normalize whitespace
            decoded = Regex.Replace(decoded, @"\s+", " ").Trim();
            return decoded;
        }
    }
}

