using Learnit.Server.Models;
using Learnit.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace Learnit.Server.Controllers
{
    [ApiController]
    [Route("api/youtube")]
    [Authorize]
    public class YouTubeCourseController : ControllerBase
    {
        private readonly YouTubeCourseService _youtubeService;
        private readonly YouTubeDataApiService _youtubeApi;

        public YouTubeCourseController(YouTubeCourseService youtubeService, YouTubeDataApiService youtubeApi)
        {
            _youtubeService = youtubeService;
            _youtubeApi = youtubeApi;
        }

        private int GetUserId()
        {
            var userIdClaim = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;

            if (string.IsNullOrEmpty(userIdClaim) || !int.TryParse(userIdClaim, out int userId))
                throw new UnauthorizedAccessException("Invalid user token");

            return userId;
        }

        [HttpPost("create-course")]
        public async Task<ActionResult<AiCourseGenerateResponse>> CreateCourse(
            [FromBody] YouTubeCourseCreateRequest request, 
            CancellationToken cancellationToken)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(request.Url))
                {
                    return BadRequest(new { message = "YouTube URL is required" });
                }

                var response = await _youtubeService.CreateCourseFromUrlAsync(
                    request.Url,
                    request.Title,
                    request.Description,
                    cancellationToken);

                return Ok(response);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(new { message = ex.Message });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[YouTubeCourseController] Error creating course: {ex.Message}");
                Console.WriteLine($"[YouTubeCourseController] Stack trace: {ex.StackTrace}");
                return StatusCode(500, new { message = "Failed to create YouTube course", error = ex.Message });
            }
        }

        /// <summary>Debug endpoint: returns raw API metadata without creating a course.</summary>
        [HttpGet("debug-metadata")]
        [AllowAnonymous]
        public async Task<IActionResult> DebugMetadata([FromQuery] string url, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(url))
                return BadRequest("url query param required");

            var metadata = await _youtubeApi.TryGetMetadataAsync(url, ct);
            if (metadata == null)
                return Ok(new { source = "YouTubeDataApiService", result = (object?)null, message = "API returned null — check backend console for [YouTubeAPI] logs" });

            return Ok(new
            {
                source = "YouTubeDataApiService",
                platform = metadata.Platform,
                title = metadata.Title,
                author = metadata.Author,
                durationMinutes = metadata.DurationMinutes,
                sectionCount = metadata.Sections?.Count ?? 0,
                sections = metadata.Sections?.Take(10).Select(s => new { s.Title, s.EstimatedMinutes })
            });
        }
    }

    public class YouTubeCourseCreateRequest
    {
        public string Url { get; set; } = "";
        public string? Title { get; set; }
        public string? Description { get; set; }
    }
}

