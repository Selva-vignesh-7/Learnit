using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Learnit.Server.Data;
using Learnit.Server.Models;
using Learnit.Server.Services;
using System.Security.Claims;
using System.IdentityModel.Tokens.Jwt;
using System;
using System.Globalization;

namespace Learnit.Server.Controllers
{
    [ApiController]
    [Route("api/progress")]
    [Authorize]
    public class ProgressController : ControllerBase
    {
        private readonly AppDbContext _db;
        private readonly ICourseScheduleGeneticService _scheduleGa;

        public ProgressController(AppDbContext db, ICourseScheduleGeneticService scheduleGa)
        {
            _db = db;
            _scheduleGa = scheduleGa;
        }

        private int GetUserId()
        {
            var userIdClaim = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;

            if (string.IsNullOrEmpty(userIdClaim) || !int.TryParse(userIdClaim, out int userId))
            {
                throw new UnauthorizedAccessException("Invalid user token");
            }

            return userId;
        }

        /// <summary>
        /// Genetic-algorithm optimized weekly study hours per active course (personalized from study history + deadlines).
        /// </summary>
        [HttpGet("ga")]
        [HttpGet("schedule/ga")]
        public async Task<IActionResult> GetGeneticSchedule(
            [FromQuery] int population = 48,
            [FromQuery] int generations = 60,
            CancellationToken cancellationToken = default)
        {
            var userId = GetUserId();
            var result = await _scheduleGa.OptimizeAsync(userId, population, generations, cancellationToken);
            return Ok(result);
        }

        [HttpGet("dashboard")]
        public async Task<IActionResult> GetProgressDashboard([FromQuery] int? timezoneOffsetMinutes, [FromQuery] int? weekOffset)
        {
            var userId = GetUserId();

            var weekOffsetValue = weekOffset ?? 0;
            if (weekOffsetValue > 0)
            {
                return BadRequest(new { message = "weekOffset cannot be in the future." });
            }
            if (weekOffsetValue < -520)
            {
                return BadRequest(new { message = "weekOffset is too far in the past." });
            }

            var offsetMinutes = timezoneOffsetMinutes ?? 0;
            if (offsetMinutes < -720 || offsetMinutes > 840)
            {
                return BadRequest(new { message = "Invalid timezone offset. Must be between -12 and +14 hours." });
            }
            var offsetSpan = TimeSpan.FromMinutes(offsetMinutes);
            DateTime ToLocal(DateTime utc) => utc - offsetSpan;
            DateTime ToUtc(DateTime local) => local + offsetSpan;

            // Calculate week boundaries (Monday to Sunday) in local time.
            // weekOffset = 0 => current week, -1 => previous week, etc.
            var todayLocal = ToLocal(DateTime.UtcNow).Date;
            var anchorLocal = todayLocal.AddDays(weekOffsetValue * 7);

            var dayOfWeek = (int)anchorLocal.DayOfWeek; // 0 = Sunday, 1 = Monday, etc.
            var daysFromMonday = dayOfWeek == 0 ? 6 : dayOfWeek - 1; // Convert Sunday (0) to 6
            var weekStartLocal = anchorLocal.AddDays(-daysFromMonday); // Monday of selected week (local)
            var weekEndLocal = weekStartLocal.AddDays(7); // Next Monday (exclusive, local)
            var weekStartUtc = ToUtc(weekStartLocal);
            var weekEndUtc = ToUtc(weekEndLocal);

            var userCourseIds = await _db.Courses
                .Where(c => c.UserId == userId)
                .Select(c => c.Id)
                .ToListAsync();

            // Get events that OVERLAP with the week (not just events that start in the week)
            // An event overlaps if: (eventEnd > weekStart) AND (eventStart < weekEnd)
            // We fetch a wider range to catch events that start before week but end during week
            // Fetch only events that overlap the local week window
            var weeklyEvents = await _db.ScheduleEvents
                .Include(e => e.CourseModule)
                .Where(e => e.UserId == userId)
                .Where(e => e.StartUtc < weekEndUtc)
                .Where(e => (e.EndUtc.HasValue ? e.EndUtc.Value : e.StartUtc.AddHours(1)) > weekStartUtc)
                .ToListAsync();

            // Get actual completed study sessions for the week (for accurate "completed" hours)
            // Pull study sessions that could fall within the local week window, then group by local date
            var weeklySessionsRaw = await _db.StudySessions
                .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id,
                    (s, _) => s)
                .Where(s => s.IsCompleted)
                .Where(s => s.StartTime >= weekStartUtc.AddDays(-1) && s.StartTime < weekEndUtc.AddDays(1))
                .Select(s => new { s.StartTime, s.DurationHours })
                .ToListAsync();

            var weeklySessions = weeklySessionsRaw
                .GroupBy(s => ToLocal(s.StartTime).Date)
                .ToDictionary(g => g.Key, g => g.Sum(x => x.DurationHours));

            var weeklyData = new List<WeeklyDataPoint>();
            // Generate data for 7 days of the week (Monday to Sunday)
            for (int i = 0; i < 7; i++)
            {
                var dateLocal = weekStartLocal.AddDays(i);
                var dayStartUtc = ToUtc(dateLocal);
                var dayEndUtc = ToUtc(dateLocal.AddDays(1));

                // Scheduled hours from ScheduleEvents - count events that OVERLAP with this day
                // This matches the frontend logic (counts portion of event within the day)
                var scheduled = weeklyEvents
                    .Where(e =>
                    {
                        var eventStart = e.StartUtc;
                        var eventEnd = e.EndUtc ?? e.StartUtc.AddHours(1);
                        // Event overlaps with this day if: eventEnd > dayStart AND eventStart < dayEnd
                        return eventEnd > dayStartUtc && eventStart < dayEndUtc;
                    })
                    .Sum(e =>
                    {
                        var eventStart = e.StartUtc;
                        var eventEnd = e.EndUtc ?? e.StartUtc.AddHours(1);
                        
                        // Calculate the portion of event within this day
                        var eventStartInDay = eventStart < dayStartUtc ? dayStartUtc : eventStart;
                        var eventEndInDay = eventEnd > dayEndUtc ? dayEndUtc : eventEnd;
                        
                        return (decimal)Math.Max(0.25, (eventEndInDay - eventStartInDay).TotalHours);
                    });

                // Completed hours from actual StudySessions (more accurate than scheduled events)
                // Fall back to scheduled events if no study sessions for that day
                var completed = weeklySessions.TryGetValue(dateLocal, out var sessionHours) 
                    ? sessionHours 
                    : weeklyEvents
                    .Where(e =>
                    {
                        var eventStart = e.StartUtc;
                        var eventEnd = e.EndUtc ?? e.StartUtc.AddHours(1);
                        return eventEnd > dayStartUtc && eventStart < dayEndUtc;
                    })
                    .Sum(e =>
                    {
                        var eventStart = e.StartUtc;
                        var eventEnd = e.EndUtc ?? e.StartUtc.AddHours(1);
                        
                        // Calculate the portion of event within this day
                        var eventStartInDay = eventStart < dayStartUtc ? dayStartUtc : eventStart;
                        var eventEndInDay = eventEnd > dayEndUtc ? dayEndUtc : eventEnd;
                        
                        var hours = (decimal)Math.Max(0.25, (eventEndInDay - eventStartInDay).TotalHours);
                        var isDone = e.CourseModule?.IsCompleted == true;
                        return isDone ? hours : 0;
                    });

                // Format day label: "Mon", "Tue", etc. Only show "Today" when viewing current week.
                var dayLabel = weekOffsetValue == 0 && dateLocal == todayLocal
                    ? "Today"
                    : dateLocal.ToString("ddd", CultureInfo.InvariantCulture);

                weeklyData.Add(new WeeklyDataPoint
                {
                    Day = dayLabel,
                    Scheduled = Math.Round(scheduled, 1),
                    Completed = Math.Round(completed, 1)
                });
            }

            var currentStreak = await CalculateCurrentStreak(userId, ToLocal);
            var longestStreak = await CalculateLongestStreak(userId, ToLocal);

            var totalScheduled = weeklyData.Sum(d => d.Scheduled);
            var totalCompleted = weeklyData.Sum(d => d.Completed);
            var completionRate = totalScheduled > 0 ? (totalCompleted / totalScheduled) * 100 : 0;
            var efficiency = Math.Min(100, completionRate);

            var courses = await _db.Courses
                .Include(c => c.Modules)
                .Where(c => c.UserId == userId)
                .ToListAsync();

            var scheduledLookup = await _db.ScheduleEvents
                .Where(e => e.UserId == userId && e.CourseModuleId.HasValue)
                .Include(e => e.CourseModule)
                .Where(e => e.CourseModule != null)
                .GroupBy(e => e.CourseModule!.CourseId)
                .Select(g => new
                {
                    CourseId = g.Key,
                    Hours = g.Sum(e => (decimal)((e.EndUtc ?? e.StartUtc.AddHours(1)) - e.StartUtc).TotalHours)
                })
                .ToDictionaryAsync(k => k.CourseId, v => v.Hours);

            var completedLookup = await _db.StudySessions
                .Where(s => s.IsCompleted && userCourseIds.Contains(s.CourseId))
                .GroupBy(s => s.CourseId)
                .Select(g => new { CourseId = g.Key, Hours = g.Sum(s => s.DurationHours) })
                .ToDictionaryAsync(k => k.CourseId, v => v.Hours);

            var courseProgress = courses.Select(c =>
            {
                var totalModules = c.Modules.Count;
                var completedModules = c.Modules.Count(m => m.IsCompleted);
                var totalHours = (decimal)Math.Max(0, c.TotalEstimatedHours);
                var completedEstimated = (decimal)Math.Max(0, c.TotalEstimatedHours - c.HoursRemaining);
                var progressPct = totalModules > 0
                    ? (decimal)Math.Round((double)completedModules * 100 / totalModules, 1)
                    : 0;

                var scheduledHours = scheduledLookup.TryGetValue(c.Id, out var sh) ? sh : 0;
                var completedHours = completedLookup.TryGetValue(c.Id, out var ch) ? ch : 0;

                return new CourseProgressDto
                {
                    Id = c.Id,
                    Title = c.Title,
                    TotalHours = totalHours,
                    CompletedHours = completedHours > 0 ? completedHours : completedEstimated,
                    ProgressPercentage = progressPct
                };
            }).ToList();

            var overallProgress = courseProgress.Any()
                ? courseProgress.Average(c => c.ProgressPercentage)
                : 0;

            var heatmapData = await GenerateHeatmapData(userId, ToLocal, anchorLocal);

            var dashboard = new ProgressDashboardDto
            {
                Stats = new ProgressStatsDto
                {
                    CurrentStreak = currentStreak,
                    LongestStreak = longestStreak,
                    TotalScheduledHours = Math.Round(totalScheduled, 1),
                    TotalCompletedHours = Math.Round(totalCompleted, 1),
                    CompletionRate = Math.Round((decimal)completionRate, 1),
                    Efficiency = Math.Round((decimal)efficiency, 1),
                    OverallProgress = Math.Round((decimal)overallProgress, 1),
                    LastUpdated = DateTime.UtcNow
                },
                WeeklyData = weeklyData,
                CourseProgress = courseProgress,
                ActivityHeatmap = heatmapData
            };

            return Ok(dashboard);
        }

        private async Task<int> CalculateCurrentStreak(int userId, Func<DateTime, DateTime> toLocal)
        {
            var today = toLocal(DateTime.UtcNow).Date;
            var streak = 0;

            // Get all completed study sessions for this user (distinct dates only)
            // This data is PERSISTENT in the database and will survive logouts
            var completedStartTimes = await _db.StudySessions
                .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id,
                    (s, _) => s)
                .Where(s => s.IsCompleted) // Only count completed sessions (persisted in DB)
                .Select(s => s.StartTime)
                .ToListAsync();

            var completedDates = completedStartTimes
                .Select(s => toLocal(s).Date)
                .Distinct()
                .OrderByDescending(d => d)
                .ToList();

            if (!completedDates.Any())
            {
                Console.WriteLine($"[Progress] No completed study sessions found for user {userId} (data is persistent in DB)");
                return 0;
            }

            Console.WriteLine($"[Progress] Found {completedDates.Count} days with completed sessions (PERSISTENT). Latest: {completedDates.First()}, Today: {today}");

            // Convert to HashSet for O(1) lookup
            var dateSet = completedDates.ToHashSet();

            // Count consecutive days backward from today
            // If no activity today, start from yesterday (or most recent activity)
            var checkDate = dateSet.Contains(today) ? today : today.AddDays(-1);
            
            // Count backward until we hit a gap
            while (dateSet.Contains(checkDate))
            {
                streak++;
                checkDate = checkDate.AddDays(-1);
            }

            Console.WriteLine($"[Progress] Current streak calculated (PERSISTENT): {streak} days");
            return streak;
        }

        private async Task<int> CalculateLongestStreak(int userId, Func<DateTime, DateTime> toLocal)
        {
            // Calculate longest streak from all completed study sessions
            // This data is PERSISTENT in the database and will survive logouts
            var completedStartTimes = await _db.StudySessions
                .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id,
                    (s, _) => s)
                .Where(s => s.IsCompleted) // Only count completed sessions (persisted in DB)
                .Select(s => s.StartTime)
                .ToListAsync();

            var completedSessions = completedStartTimes
                .Select(s => toLocal(s).Date)
                .Distinct()
                .OrderBy(d => d)
                .ToList();

            if (!completedSessions.Any())
            {
                Console.WriteLine($"[Progress] No completed study sessions found for longest streak calculation (user {userId}) - data is persistent in DB");
                return 0;
            }

            Console.WriteLine($"[Progress] Calculating longest streak from {completedSessions.Count} days with activity (PERSISTENT)");

            var longestStreak = 1;
            var currentStreak = 1;

            for (int i = 1; i < completedSessions.Count; i++)
            {
                var daysDiff = (completedSessions[i] - completedSessions[i - 1]).TotalDays;
                
                if (daysDiff == 1)
                {
                    // Consecutive day
                    currentStreak++;
                    longestStreak = Math.Max(longestStreak, currentStreak);
                }
                else
                {
                    // Gap in streak - reset current streak
                    currentStreak = 1;
                }
            }

            Console.WriteLine($"[Progress] Longest streak calculated (PERSISTENT): {longestStreak} days");
            return longestStreak;
        }

        private async Task<List<int>> GenerateHeatmapData(int userId, Func<DateTime, DateTime> toLocal, DateTime anchorLocal)
        {
            var heatmap = new List<int>();
            var today = anchorLocal.Date;

            // Use ActivityLogs if available (more efficient, pre-aggregated, PERSISTENT), otherwise fall back to StudySessions
            var startDate = today.AddDays(-89);
            
            // Try to get from ActivityLogs first (persistent, aggregated data stored in database)
            // Query a slightly wider range to cover timezone shifts
            var activityLogsList = await _db.ActivityLogs
                .Where(a => a.UserId == userId && a.Date >= startDate.AddDays(-1) && a.Date <= today.AddDays(1))
                .ToListAsync();

            Dictionary<DateTime, decimal> dailyHours;
            if (activityLogsList.Any())
            {
                // Map stored dates into local dates
                var activityLogs = activityLogsList
                    .GroupBy(a => toLocal(DateTime.SpecifyKind(a.Date.Date, DateTimeKind.Utc)).Date)
                    .ToDictionary(g => g.Key, g => g.Sum(x => x.HoursCompleted));
                Console.WriteLine($"[Progress] Heatmap: Using ActivityLogs (PERSISTENT) - Found {activityLogs.Count} days with activity");
                dailyHours = activityLogs;
            }
            else
            {
                // Fall back to StudySessions (for backward compatibility and to ensure data is shown)
                var utcToday = DateTime.UtcNow.Date;
                var utcStart = utcToday.AddDays(-92);
                var utcEnd = utcToday.AddDays(2);

                var sessionsRaw = await _db.StudySessions
                    .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id,
                        (s, _) => s)
                    .Where(s => s.IsCompleted)
                    .Where(s => s.StartTime >= utcStart && s.StartTime <= utcEnd)
                    .Select(s => new { s.StartTime, s.DurationHours })
                    .ToListAsync();

                var sessions = sessionsRaw
                    .GroupBy(s => toLocal(s.StartTime).Date)
                    .ToDictionary(g => g.Key, g => g.Sum(x => x.DurationHours));

                Console.WriteLine($"[Progress] Heatmap: Using StudySessions (PERSISTENT) - Found {sessions.Count} days with activity");
                dailyHours = sessions;
            }

            // Generate heatmap for last 90 days (3 months)
            for (int i = 89; i >= 0; i--)
            {
                var date = today.AddDays(-i);

                // Get hours for this date (default to 0 if no activity)
                var hours = dailyHours.TryGetValue(date, out var h) ? h : 0;

                int activityLevel;
                if (hours == 0) activityLevel = 0;
                else if (hours < 2) activityLevel = 1;
                else if (hours < 4) activityLevel = 2;
                else activityLevel = 3;

                heatmap.Add(activityLevel);
            }

            var daysWithActivity = heatmap.Count(v => v > 0);
            Console.WriteLine($"[Progress] Heatmap generated: {heatmap.Count} days total, {daysWithActivity} days with activity");
            return heatmap;
        }

        [HttpPost("submodule/{subModuleId}/complete")]
        public async Task<IActionResult> MarkSubModuleComplete(int subModuleId, [FromBody] SubModuleProgressRequest request)
        {
            var userId = GetUserId();

            var subModule = await _db.CourseSubModules
                .Include(sm => sm.CourseModule)
                    .ThenInclude(m => m.Course)
                .FirstOrDefaultAsync(sm => sm.Id == subModuleId);

            if (subModule == null)
                return NotFound("SubModule not found");

            if (subModule.CourseModule == null || subModule.CourseModule.Course == null || subModule.CourseModule.Course.UserId != userId)
                return Unauthorized();

            subModule.IsCompleted = request.IsCompleted ?? true;
            await _db.SaveChangesAsync();

            // Update module completion if all submodules are complete
            var module = subModule.CourseModule;
            if (module != null)
            {
                var allSubModules = await _db.CourseSubModules
                    .Where(sm => sm.CourseModuleId == module.Id)
                    .ToListAsync();

                module.IsCompleted = allSubModules.All(sm => sm.IsCompleted);
                await _db.SaveChangesAsync();
            }

            return Ok(new { subModuleId, isCompleted = subModule.IsCompleted });
        }

        [HttpPost("chapter-progress")]
        public async Task<IActionResult> UpdateChapterProgress([FromBody] ChapterProgressRequest request)
        {
            var userId = GetUserId();

            // Find SubModule by matching title with chapter title
            // Load into memory first, then filter with case-insensitive comparison
            // (EF Core cannot translate Contains with StringComparison to SQL)
            var allSubModulesForCourse = await _db.CourseSubModules
                .Include(sm => sm.CourseModule)
                    .ThenInclude(m => m.Course)
                .Where(sm => sm.CourseModule != null && 
                            sm.CourseModule!.Course != null &&
                            sm.CourseModule!.Course!.UserId == userId && 
                            sm.CourseModule!.Course!.Id == request.CourseId)
                .ToListAsync();
            
            // Filter out any null references (shouldn't happen, but safety check)
            allSubModulesForCourse = allSubModulesForCourse
                .Where(sm => sm.CourseModule != null && sm.CourseModule.Course != null)
                .ToList();
            
            // Filter in memory with case-insensitive comparison
            var subModule = allSubModulesForCourse.FirstOrDefault(sm => 
                !string.IsNullOrWhiteSpace(sm.Title) && 
                !string.IsNullOrWhiteSpace(request.ChapterTitle) &&
                (sm.Title.Contains(request.ChapterTitle, StringComparison.OrdinalIgnoreCase) ||
                 request.ChapterTitle.Contains(sm.Title, StringComparison.OrdinalIgnoreCase)));

            if (subModule == null)
            {
                // Try to find by order/index if title doesn't match
                var course = await _db.Courses
                    .Include(c => c.Modules)
                        .ThenInclude(m => m.SubModules)
                    .FirstOrDefaultAsync(c => c.Id == request.CourseId && c.UserId == userId);

                if (course != null)
                {
                    // Find SubModule by index (assuming chapters are in order)
                    var orderedSubModules = course.Modules
                        .OrderBy(m => m.Order)
                        .SelectMany(m => m.SubModules.OrderBy(sm => sm.Order))
                        .ToList();

                    if (request.ChapterIndex >= 0 && request.ChapterIndex < orderedSubModules.Count)
                    {
                        subModule = orderedSubModules[request.ChapterIndex];
                    }
                }
            }

            if (subModule == null)
                return NotFound("SubModule not found for this chapter");

            // Mark as completed if watched >= 90%
            var shouldComplete = request.WatchedPercent >= 90;
            if (shouldComplete && !subModule.IsCompleted)
            {
                subModule.IsCompleted = true;
                await _db.SaveChangesAsync();

                // Check if module is complete
                var module = subModule.CourseModule;
                if (module != null)
                {
                    var moduleSubModules = await _db.CourseSubModules
                        .Where(sm => sm.CourseModuleId == module.Id)
                        .ToListAsync();

                    var wasModuleComplete = module.IsCompleted;
                    module.IsCompleted = moduleSubModules.All(sm => sm.IsCompleted);
                    await _db.SaveChangesAsync();

                    // If module just became complete, log it
                    if (module.IsCompleted && !wasModuleComplete)
                    {
                        Console.WriteLine($"[Progress] Module '{module.Title}' completed (all SubModules done)");
                    }
                }
            }

            // Always recalculate course progress to ensure HoursRemaining is accurate
            // Reload course with modules to get fresh data after SubModule completion
            var courseId = subModule.CourseModule?.CourseId;
            if (courseId.HasValue)
            {
                var course = await _db.Courses
                    .Include(c => c.Modules)
                        .ThenInclude(m => m.SubModules)
                    .FirstOrDefaultAsync(c => c.Id == courseId.Value);

                if (course != null)
                {
                    // Recalculate based on all completed modules/submodules
                    var totalModuleHours = course.Modules.Sum(m => m.EstimatedHours);
                    var totalSubModuleHours = course.Modules
                        .SelectMany(m => m.SubModules)
                        .Sum(sm => sm.EstimatedHours);
                    var totalEstimated = totalModuleHours + totalSubModuleHours;

                    if (totalEstimated == 0 && course.TotalEstimatedHours > 0)
                    {
                        totalEstimated = course.TotalEstimatedHours;
                    }

                    var completedModuleHours = course.Modules
                        .Where(m => m.IsCompleted)
                        .Sum(m => m.EstimatedHours);
                    var completedSubModuleHours = course.Modules
                        .SelectMany(m => m.SubModules)
                        .Where(sm => sm.IsCompleted)
                        .Sum(sm => sm.EstimatedHours);
                    var completedEstimated = completedModuleHours + completedSubModuleHours;

                    // Update course hours remaining
                    var oldHoursRemaining = course.HoursRemaining;
                    course.HoursRemaining = Math.Max(0, (int)(totalEstimated - completedEstimated));
                    
                    // Update last studied timestamp
                    course.LastStudiedAt = DateTime.UtcNow;
                    course.UpdatedAt = DateTime.UtcNow;
                    
                    // Check if course is complete (all modules done)
                    var courseCompletedModules = course.Modules.Count(m => m.IsCompleted);
                    var courseTotalModules = course.Modules.Count;
                    var isCourseComplete = courseTotalModules > 0 && courseCompletedModules == courseTotalModules;
                    
                    // If course is complete, ensure hours remaining is 0
                    if (isCourseComplete)
                    {
                        course.HoursRemaining = 0;
                        Console.WriteLine($"[Progress] ✅ Course '{course.Title}' COMPLETED! All {courseTotalModules} modules finished.");
                    }
                    
                    await _db.SaveChangesAsync();
                    
                    // Log progress update
                    var progressPercent = courseTotalModules > 0 
                        ? Math.Round((decimal)courseCompletedModules * 100 / courseTotalModules, 1) 
                        : 0;
                    Console.WriteLine($"[Progress] Course '{course.Title}' progress updated: {courseCompletedModules}/{courseTotalModules} modules ({progressPercent}%), {completedEstimated}/{totalEstimated} hours ({course.HoursRemaining} remaining, was {oldHoursRemaining})");
                }
            }

            // Get updated course info for response
            var updatedCourse = courseId.HasValue 
                ? await _db.Courses
                    .Include(c => c.Modules)
                    .FirstOrDefaultAsync(c => c.Id == courseId.Value)
                : null;

            var responseCompletedModules = updatedCourse?.Modules.Count(m => m.IsCompleted) ?? 0;
            var responseTotalModules = updatedCourse?.Modules.Count ?? 0;

            return Ok(new { 
                subModuleId = subModule.Id, 
                isCompleted = subModule.IsCompleted,
                watchedPercent = request.WatchedPercent,
                courseHoursRemaining = updatedCourse?.HoursRemaining ?? 0,
                completedModules = responseCompletedModules,
                totalModules = responseTotalModules,
                progressPercentage = responseTotalModules > 0 ? Math.Round((decimal)responseCompletedModules * 100 / responseTotalModules, 1) : 0
            });
        }
    }

    public class SubModuleProgressRequest
    {
        public bool? IsCompleted { get; set; }
    }

    public class ChapterProgressRequest
    {
        public int CourseId { get; set; }
        public string ChapterTitle { get; set; } = "";
        public int ChapterIndex { get; set; } = -1;
        public double WatchedPercent { get; set; }
    }
}

