using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Learnit.Server.Data;
using Learnit.Server.Models;
using Learnit.Server.Services;
using System.Security.Claims;
using System.Collections.Generic;
using System.Net.Mail;

namespace Learnit.Server.Controllers
{
    [ApiController]
    [Route("api/courses")]
    [Authorize]
    public class CoursesController : ControllerBase
    {
        private readonly AppDbContext _db;
        private readonly AwardService _awardService;
        private readonly IEmailSender _emailSender;

        public CoursesController(AppDbContext db, AwardService awardService, IEmailSender emailSender)
        {
            _db = db;
            _awardService = awardService;
            _emailSender = emailSender;
        }

        private int GetUserId()
        {
            // JWT uses "sub" claim for user ID (from JwtRegisteredClaimNames.Sub)
            var userIdClaim = User.FindFirst("sub")?.Value 
                ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            
            if (string.IsNullOrEmpty(userIdClaim) || !int.TryParse(userIdClaim, out int userId))
            {
                throw new UnauthorizedAccessException("Invalid user token");
            }
            
            return userId;
        }

        private record CourseProgressSnapshot(
            int TotalModules,
            int CompletedModules,
            decimal ProgressPercentage,
            decimal ScheduledHours,
            decimal CompletedHours,
            decimal HoursRemaining);

        private async Task<Dictionary<int, decimal>> GetScheduledHoursByCourse(int userId, IEnumerable<int> courseIds)
        {
            var ids = courseIds.ToList();
            if (!ids.Any()) return new();

            return await _db.ScheduleEvents
                .Where(e => e.UserId == userId && e.CourseModuleId.HasValue && e.EndUtc.HasValue)
                .Include(e => e.CourseModule)
                .Where(e => e.CourseModule != null && ids.Contains(e.CourseModule!.CourseId))
                .GroupBy(e => e.CourseModule!.CourseId)
                .Select(g => new
                {
                    CourseId = g.Key,
                    Hours = g.Sum(e => (decimal)(e.EndUtc!.Value - e.StartUtc).TotalHours)
                })
                .ToDictionaryAsync(k => k.CourseId, v => v.Hours);
        }

        private async Task<Dictionary<int, decimal>> GetCompletedStudyHoursByCourse(int userId, IEnumerable<int> courseIds)
        {
            var ids = courseIds.ToList();
            if (!ids.Any()) return new();

            return await _db.StudySessions
                .Where(s => s.IsCompleted && ids.Contains(s.CourseId))
                .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id,
                    (s, _) => new { s.CourseId, s.DurationHours })
                .GroupBy(x => x.CourseId)
                .Select(g => new { CourseId = g.Key, Hours = g.Sum(x => x.DurationHours) })
                .ToDictionaryAsync(k => k.CourseId, v => v.Hours);
        }

        private CourseProgressSnapshot BuildCourseProgressSnapshot(
            Course course,
            IReadOnlyDictionary<int, decimal> scheduledLookup,
            IReadOnlyDictionary<int, decimal> completedLookup)
        {
            var totalModules = course.Modules.Count;
            var completedModules = course.Modules.Count(m => m.IsCompleted);
            var moduleHours = course.Modules.Sum(m => m.EstimatedHours);
            var subModuleHours = course.Modules.SelectMany(m => m.SubModules).Sum(sm => sm.EstimatedHours);

            var totalEstimated = moduleHours + subModuleHours;
            if (totalEstimated == 0 && course.TotalEstimatedHours > 0)
            {
                totalEstimated = course.TotalEstimatedHours;
            }

            var completedModuleHours = course.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
            var completedSubModuleHours = course.Modules
                .SelectMany(m => m.SubModules)
                .Where(sm => sm.IsCompleted)
                .Sum(sm => sm.EstimatedHours);

            var completedEstimated = completedModuleHours + completedSubModuleHours;

            var progressPct = totalModules > 0
                ? Math.Round((decimal)completedModules * 100 / totalModules, 1)
                : (totalEstimated > 0 && completedLookup.TryGetValue(course.Id, out var completedFromHours) && completedFromHours > 0)
                    ? Math.Round(completedFromHours * 100 / totalEstimated, 1)
                    : 0;

            var scheduledHours = scheduledLookup.TryGetValue(course.Id, out var sh) ? sh : 0;
            var completedHours = completedLookup.TryGetValue(course.Id, out var ch) ? ch : 0;

            var effectiveCompleted = Math.Max(completedEstimated, completedHours);
            var hoursRemaining = totalEstimated > 0
                ? Math.Max(0, totalEstimated - effectiveCompleted)
                : 0;

            return new CourseProgressSnapshot(
                totalModules,
                completedModules,
                progressPct,
                scheduledHours,
                completedHours,
                hoursRemaining);
        }

        private static int CalculateHoursRemainingFromModules(Course course)
        {
            // Materialize collections to prevent lazy loading and circular references
            var modules = course.Modules?.ToList() ?? new List<CourseModule>();
            var moduleHours = modules.Sum(m => m.EstimatedHours);
            var subModuleHours = modules
                .SelectMany(m => m.SubModules?.ToList() ?? new List<CourseSubModule>())
                .Sum(sm => sm.EstimatedHours);
            var totalEstimated = moduleHours + subModuleHours;

            var completedModuleHours = modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
            var completedSubModuleHours = modules
                .SelectMany(m => m.SubModules?.ToList() ?? new List<CourseSubModule>())
                .Where(sm => sm.IsCompleted)
                .Sum(sm => sm.EstimatedHours);

            var completedEstimated = completedModuleHours + completedSubModuleHours;

            return Math.Max(0, totalEstimated - completedEstimated);
        }

        [HttpGet]
        public async Task<IActionResult> GetCourses(
            [FromQuery] string? search,
            [FromQuery] string? priority,
            [FromQuery] string? difficulty,
            [FromQuery] string? duration,
            [FromQuery] string? sortBy = "createdAt",
            [FromQuery] string? sortOrder = "desc")
        {
            var userId = GetUserId();
            var userFullName = await _db.Users
                .Where(u => u.Id == userId)
                .Select(u => u.FullName)
                .FirstOrDefaultAsync() ?? "";
            sortBy = string.IsNullOrWhiteSpace(sortBy) ? "createdAt" : sortBy;
            sortOrder = string.IsNullOrWhiteSpace(sortOrder) ? "desc" : sortOrder;
            var query = _db.Courses
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .Include(c => c.ExternalLinks)
                .Include(c => c.StudySessions)
                .Where(c => c.UserId == userId)
                .AsQueryable();

            // Search filter
            if (!string.IsNullOrEmpty(search))
            {
                query = query.Where(c => 
                    c.Title.ToLower().Contains(search.ToLower()) ||
                    c.Description.ToLower().Contains(search.ToLower()));
            }

            // Priority filter
            if (!string.IsNullOrEmpty(priority))
            {
                var priorities = priority.Split(',');
                query = query.Where(c => priorities.Contains(c.Priority));
            }

            // Difficulty filter
            if (!string.IsNullOrEmpty(difficulty))
            {
                var difficulties = difficulty.Split(',');
                query = query.Where(c => difficulties.Contains(c.Difficulty));
            }

            // Duration filter
            if (!string.IsNullOrEmpty(duration))
            {
                if (duration == "< 1 hour")
                    query = query.Where(c => c.TotalEstimatedHours < 1);
                else if (duration == "1-3 hours")
                    query = query.Where(c => c.TotalEstimatedHours >= 1 && c.TotalEstimatedHours <= 3);
                else if (duration == "> 3 hours")
                    query = query.Where(c => c.TotalEstimatedHours > 3);
            }

            // Sorting
            query = sortBy.ToLower() switch
            {
                "title" => sortOrder == "asc" 
                    ? query.OrderBy(c => c.Title)
                    : query.OrderByDescending(c => c.Title),
                "priority" => sortOrder == "asc"
                    ? query.OrderBy(c => c.Priority)
                    : query.OrderByDescending(c => c.Priority),
                "difficulty" => sortOrder == "asc"
                    ? query.OrderBy(c => c.Difficulty)
                    : query.OrderByDescending(c => c.Difficulty),
                "hours" => sortOrder == "asc"
                    ? query.OrderBy(c => c.TotalEstimatedHours)
                    : query.OrderByDescending(c => c.TotalEstimatedHours),
                _ => sortOrder == "asc"
                    ? query.OrderBy(c => c.CreatedAt)
                    : query.OrderByDescending(c => c.CreatedAt)
            };

            // Use AsNoTracking to prevent circular references during serialization
            var courses = await query.AsNoTracking().ToListAsync();

            var courseIds = courses.Select(c => c.Id).ToList();
            var scheduledLookup = await GetScheduledHoursByCourse(userId, courseIds);
            var completedLookup = await GetCompletedStudyHoursByCourse(userId, courseIds);

            var response = courses.Select(c =>
            {
                // Materialize collections to prevent lazy loading issues
                var modulesList = c.Modules?.ToList() ?? new List<CourseModule>();
                var externalLinksList = c.ExternalLinks?.ToList() ?? new List<ExternalLink>();
                var studySessionsList = c.StudySessions?.ToList() ?? new List<StudySession>();

                var snapshot = BuildCourseProgressSnapshot(c, scheduledLookup, completedLookup);

                return new CourseResponseDto
                {
                    Id = c.Id,
                    Title = c.Title,
                    Description = c.Description,
                    SubjectArea = c.SubjectArea,
                    LearningObjectives = c.LearningObjectives,
                    Difficulty = c.Difficulty,
                    Priority = c.Priority,
                    TotalEstimatedHours = c.TotalEstimatedHours,
                    HoursRemaining = (int)snapshot.HoursRemaining,
                    TotalModules = snapshot.TotalModules,
                    CompletedModules = snapshot.CompletedModules,
                    ProgressPercentage = snapshot.ProgressPercentage,
                    ScheduledHours = snapshot.ScheduledHours,
                    CompletedHours = snapshot.CompletedHours,
                    TargetCompletionDate = c.TargetCompletionDate,
                    CreatedAt = c.CreatedAt,
                    UpdatedAt = c.UpdatedAt,
                    Notes = c.Notes,
                    IsActive = c.IsActive,
                    LastStudiedAt = c.LastStudiedAt,
                    ReminderEmail = c.ReminderEmail,
                    LastReminderSentAt = c.LastReminderSentAt,
                    UserFullName = userFullName,
                    CertificateIssuedAt = c.CertificateIssuedAt,
                    IsQuizEnabled = c.IsQuizEnabled,
                    Modules = modulesList.OrderBy(m => m.Order).Select(m => 
                    {
                        var subModulesList = m.SubModules?.ToList() ?? new List<CourseSubModule>();
                        return new CourseModuleDto
                        {
                            Id = m.Id,
                            Title = m.Title,
                            Description = m.Description,
                            EstimatedHours = m.EstimatedHours,
                            Order = m.Order,
                            Notes = m.Notes,
                            IsCompleted = m.IsCompleted,
                            SubModules = subModulesList
                                .OrderBy(sm => sm.Order)
                                .Select(sm => new CourseSubModuleDto
                                {
                                    Id = sm.Id,
                                    Title = sm.Title,
                                    Description = sm.Description,
                                    EstimatedHours = sm.EstimatedHours,
                                    Order = sm.Order,
                                    Notes = sm.Notes,
                                    IsCompleted = sm.IsCompleted
                                }).ToList()
                        };
                    }).ToList(),
                    ExternalLinks = externalLinksList.Select(l => new ExternalLinkDto
                    {
                        Id = l.Id,
                        Platform = l.Platform,
                        Title = l.Title,
                        Url = l.Url,
                        CreatedAt = l.CreatedAt
                    }).ToList(),
                    ActiveSession = studySessionsList
                        .Where(s => !s.IsCompleted && s.EndTime == null)
                        .OrderByDescending(s => s.StartTime)
                        .Select(s => new StudySessionDto
                        {
                            Id = s.Id,
                            CourseModuleId = s.CourseModuleId,
                            StartTime = s.StartTime,
                            EndTime = s.EndTime,
                            DurationHours = s.DurationHours,
                            Notes = s.Notes,
                            IsCompleted = s.IsCompleted
                        })
                        .FirstOrDefault()
                };
            }).ToList();

            return Ok(response);
        }

        [HttpGet("{id}")]
        public async Task<IActionResult> GetCourse(int id)
        {
            var userId = GetUserId();
            var userFullName = await _db.Users
                .Where(u => u.Id == userId)
                .Select(u => u.FullName)
                .FirstOrDefaultAsync() ?? "";
            // Use AsNoTracking to prevent circular references during serialization
            var course = await _db.Courses
                .AsNoTracking()
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .Include(c => c.ExternalLinks)
                .Include(c => c.StudySessions)
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId);

            if (course == null)
                return NotFound();

            // Materialize collections to prevent lazy loading issues
            var modulesList = course.Modules?.ToList() ?? new List<CourseModule>();
            var externalLinksList = course.ExternalLinks?.ToList() ?? new List<ExternalLink>();
            var studySessionsList = course.StudySessions?.ToList() ?? new List<StudySession>();

            var scheduledLookup = await GetScheduledHoursByCourse(userId, new[] { course.Id });
            var completedLookup = await GetCompletedStudyHoursByCourse(userId, new[] { course.Id });
            var snapshot = BuildCourseProgressSnapshot(course, scheduledLookup, completedLookup);

            var response = new CourseResponseDto
            {
                Id = course.Id,
                Title = course.Title,
                Description = course.Description,
                SubjectArea = course.SubjectArea,
                LearningObjectives = course.LearningObjectives,
                Difficulty = course.Difficulty,
                Priority = course.Priority,
                TotalEstimatedHours = course.TotalEstimatedHours,
                HoursRemaining = (int)snapshot.HoursRemaining,
                TotalModules = snapshot.TotalModules,
                CompletedModules = snapshot.CompletedModules,
                ProgressPercentage = snapshot.ProgressPercentage,
                ScheduledHours = snapshot.ScheduledHours,
                CompletedHours = snapshot.CompletedHours,
                TargetCompletionDate = course.TargetCompletionDate,
                CreatedAt = course.CreatedAt,
                UpdatedAt = course.UpdatedAt,
                Notes = course.Notes,
                IsActive = course.IsActive,
                LastStudiedAt = course.LastStudiedAt,
                ReminderEmail = course.ReminderEmail,
                LastReminderSentAt = course.LastReminderSentAt,
                UserFullName = userFullName,
                CertificateIssuedAt = course.CertificateIssuedAt,
                IsQuizEnabled = course.IsQuizEnabled,
                Modules = modulesList.OrderBy(m => m.Order).Select(m => 
                {
                    var subModulesList = m.SubModules?.ToList() ?? new List<CourseSubModule>();
                    return new CourseModuleDto
                    {
                        Id = m.Id,
                        Title = m.Title,
                        Description = m.Description,
                        EstimatedHours = m.EstimatedHours,
                        Order = m.Order,
                        Notes = m.Notes,
                        IsCompleted = m.IsCompleted,
                        SubModules = subModulesList
                            .OrderBy(sm => sm.Order)
                            .Select(sm => new CourseSubModuleDto
                            {
                                Id = sm.Id,
                                Title = sm.Title,
                                Description = sm.Description,
                                EstimatedHours = sm.EstimatedHours,
                                Order = sm.Order,
                                Notes = sm.Notes,
                                IsCompleted = sm.IsCompleted
                            }).ToList()
                    };
                }).ToList(),
                ExternalLinks = externalLinksList.Select(l => new ExternalLinkDto
                {
                    Id = l.Id,
                    Platform = l.Platform,
                    Title = l.Title,
                    Url = l.Url,
                    CreatedAt = l.CreatedAt
                }).ToList(),
                ActiveSession = studySessionsList
                    .Where(s => !s.IsCompleted && s.EndTime == null)
                    .OrderByDescending(s => s.StartTime)
                    .Select(s => new StudySessionDto
                    {
                        Id = s.Id,
                        CourseModuleId = s.CourseModuleId,
                        StartTime = s.StartTime,
                        EndTime = s.EndTime,
                        DurationHours = s.DurationHours,
                        Notes = s.Notes,
                        IsCompleted = s.IsCompleted
                    })
                    .FirstOrDefault()
            };

            return Ok(response);
        }

        private static DateTime? EnsureUtc(DateTime? value)
        {
            if (!value.HasValue)
                return null;

            return value.Value.Kind switch
            {
                DateTimeKind.Utc => value,
                DateTimeKind.Local => value.Value.ToUniversalTime(),
                _ => DateTime.SpecifyKind(value.Value, DateTimeKind.Utc)
            };
        }

        private static bool TryNormalizeEmail(string? value, out string normalized)
        {
            normalized = string.Empty;
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            try
            {
                var mail = new MailAddress(value.Trim());
                normalized = mail.Address;
                return true;
            }
            catch
            {
                return false;
            }
        }

        [HttpPost]
        public async Task<IActionResult> CreateCourse(CreateCourseDto dto)
        {
            var userId = GetUserId();
            if (!TryNormalizeEmail(dto.ReminderEmail, out var reminderEmail))
            {
                return BadRequest(new { message = "A valid reminder email is required." });
            }

            var course = new Course
            {
                UserId = userId,
                Title = dto.Title,
                Description = dto.Description,
                SubjectArea = dto.SubjectArea,
                LearningObjectives = dto.LearningObjectives,
                Difficulty = dto.Difficulty,
                Priority = dto.Priority,
                TotalEstimatedHours = dto.TotalEstimatedHours,
                HoursRemaining = dto.TotalEstimatedHours,
                TargetCompletionDate = EnsureUtc(dto.TargetCompletionDate),
                Notes = dto.Notes,
                ReminderEmail = reminderEmail,
                IsQuizEnabled = dto.IsQuizEnabled,
                IsActive = true, // New courses are active by default
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };

            _db.Courses.Add(course);
            await _db.SaveChangesAsync();

            // Add modules and submodules (fixed one-level depth via separate table)
            var createdModules = new List<(CourseModule Module, CreateCourseModuleDto Dto)>();
            for (int i = 0; i < dto.Modules.Count; i++)
            {
                var m = dto.Modules[i];
                var module = new CourseModule
                {
                    CourseId = course.Id,
                    Title = m.Title,
                    Description = m.Description,
                    EstimatedHours = m.EstimatedHours,
                    Order = i,
                    Notes = m.Notes,
                    IsCompleted = m.IsCompleted
                };
                createdModules.Add((module, m));
                _db.CourseModules.Add(module);
            }

            await _db.SaveChangesAsync();

            foreach (var pair in createdModules)
            {
                var module = pair.Module;
                var subs = pair.Dto.SubModules ?? new List<CreateCourseSubModuleDto>();
                for (int i = 0; i < subs.Count; i++)
                {
                    var sm = subs[i];
                    _db.CourseSubModules.Add(new CourseSubModule
                    {
                        CourseModuleId = module.Id,
                        Title = sm.Title,
                        Description = sm.Description,
                        EstimatedHours = sm.EstimatedHours,
                        Order = i,
                        Notes = sm.Notes,
                        IsCompleted = sm.IsCompleted
                    });
                }
            }

            await _db.SaveChangesAsync();

            // Add external links
            foreach (var linkDto in dto.ExternalLinks)
            {
                var link = new ExternalLink
                {
                    CourseId = course.Id,
                    Platform = linkDto.Platform,
                    Title = linkDto.Title,
                    Url = linkDto.Url,
                    CreatedAt = DateTime.UtcNow
                };
                _db.ExternalLinks.Add(link);
            }

            await _db.SaveChangesAsync();

            // Reload with modules and external links for calculation (use AsNoTracking to prevent circular references)
            var courseForCalculation = await _db.Courses
                .AsNoTracking()
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .Include(c => c.ExternalLinks)
                .FirstOrDefaultAsync(c => c.Id == course.Id);

            if (courseForCalculation != null)
            {
                // Calculate hours remaining using the no-tracking entity
                var hoursRemaining = CalculateHoursRemainingFromModules(courseForCalculation);
                
                // Update the tracked entity
                course.HoursRemaining = hoursRemaining;
                await _db.SaveChangesAsync();
            }

            // Reload for response mapping (materialize collections to prevent lazy loading)
            var courseForResponse = await _db.Courses
                .AsNoTracking()
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .Include(c => c.ExternalLinks)
                .FirstOrDefaultAsync(c => c.Id == course.Id);

            if (courseForResponse == null)
            {
                return StatusCode(500, new { message = "Failed to load created course" });
            }

            // Materialize collections to prevent lazy loading issues
            var modulesList = courseForResponse.Modules?.ToList() ?? new List<CourseModule>();
            var externalLinksList = courseForResponse.ExternalLinks?.ToList() ?? new List<ExternalLink>();

            var response = new CourseResponseDto
            {
                Id = courseForResponse.Id,
                Title = courseForResponse.Title,
                Description = courseForResponse.Description,
                SubjectArea = courseForResponse.SubjectArea,
                LearningObjectives = courseForResponse.LearningObjectives,
                Difficulty = courseForResponse.Difficulty,
                Priority = courseForResponse.Priority,
                TotalEstimatedHours = courseForResponse.TotalEstimatedHours,
                HoursRemaining = courseForResponse.HoursRemaining,
                TargetCompletionDate = courseForResponse.TargetCompletionDate,
                CreatedAt = courseForResponse.CreatedAt,
                UpdatedAt = courseForResponse.UpdatedAt,
                Notes = courseForResponse.Notes,
                IsActive = courseForResponse.IsActive,
                LastStudiedAt = courseForResponse.LastStudiedAt,
                ReminderEmail = courseForResponse.ReminderEmail,
                LastReminderSentAt = courseForResponse.LastReminderSentAt,
                IsQuizEnabled = courseForResponse.IsQuizEnabled,
                Modules = modulesList.OrderBy(m => m.Order).Select(m => 
                {
                    var subModulesList = m.SubModules?.ToList() ?? new List<CourseSubModule>();
                    return new CourseModuleDto
                    {
                        Id = m.Id,
                        Title = m.Title,
                        EstimatedHours = m.EstimatedHours,
                        Order = m.Order,
                        Notes = m.Notes,
                        IsCompleted = m.IsCompleted,
                        SubModules = subModulesList
                            .OrderBy(sm => sm.Order)
                            .Select(sm => new CourseSubModuleDto
                            {
                                Id = sm.Id,
                                Title = sm.Title,
                                Description = sm.Description,
                                EstimatedHours = sm.EstimatedHours,
                                Order = sm.Order,
                                Notes = sm.Notes,
                                IsCompleted = sm.IsCompleted
                            }).ToList()
                    };
                }).ToList(),
                ExternalLinks = externalLinksList.Select(l => new ExternalLinkDto
                {
                    Id = l.Id,
                    Platform = l.Platform,
                    Title = l.Title,
                    Url = l.Url,
                    CreatedAt = l.CreatedAt
                }).ToList()
            };

            return CreatedAtAction(nameof(GetCourse), new { id = courseForResponse.Id }, response);
        }

        [HttpPut("{id}")]
        public async Task<IActionResult> UpdateCourse(int id, [FromBody] Dictionary<string, object> updates)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId);

            if (course == null)
                return NotFound();

            // Update only provided fields
            if (updates.ContainsKey("title") && updates["title"] != null)
                course.Title = updates["title"].ToString() ?? "";
            if (updates.ContainsKey("description") && updates["description"] != null)
                course.Description = updates["description"].ToString() ?? "";
            if (updates.ContainsKey("subjectArea") && updates["subjectArea"] != null)
                course.SubjectArea = updates["subjectArea"].ToString() ?? "";
            if (updates.ContainsKey("learningObjectives") && updates["learningObjectives"] != null)
                course.LearningObjectives = updates["learningObjectives"].ToString() ?? "";
            if (updates.ContainsKey("difficulty") && updates["difficulty"] != null)
                course.Difficulty = updates["difficulty"].ToString() ?? "";
            if (updates.ContainsKey("priority") && updates["priority"] != null)
                course.Priority = updates["priority"].ToString() ?? "";
            if (updates.ContainsKey("totalEstimatedHours") && updates["totalEstimatedHours"] != null)
            {
                if (int.TryParse(updates["totalEstimatedHours"].ToString(), out int hours))
                {
                    course.TotalEstimatedHours = hours;
                    // Recalculate hours remaining
                    var completedHours = await _db.StudySessions
                        .Where(s => s.CourseId == id && s.IsCompleted)
                        .SumAsync(s => s.DurationHours);
                    course.HoursRemaining = Math.Max(0, course.TotalEstimatedHours - (int)completedHours);
                }
            }
            if (updates.ContainsKey("targetCompletionDate") && updates["targetCompletionDate"] != null)
            {
                if (DateTime.TryParse(updates["targetCompletionDate"].ToString(), out DateTime date))
                    course.TargetCompletionDate = EnsureUtc(date);
            }
            if (updates.ContainsKey("notes") && updates["notes"] != null)
                course.Notes = updates["notes"].ToString() ?? "";
            if (updates.ContainsKey("reminderEmail") && updates["reminderEmail"] != null)
            {
                if (!TryNormalizeEmail(updates["reminderEmail"].ToString(), out var reminderEmail))
                {
                    return BadRequest(new { message = "Reminder email is invalid." });
                }
                course.ReminderEmail = reminderEmail;
            }

            if (updates.ContainsKey("isQuizEnabled") && updates["isQuizEnabled"] != null)
            {
                if (bool.TryParse(updates["isQuizEnabled"].ToString(), out var isQuizEnabled))
                {
                    course.IsQuizEnabled = isQuizEnabled;
                }
            }

            course.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new { message = "Course updated successfully" });
        }

        [HttpDelete("{id}")]
        public async Task<IActionResult> DeleteCourse(int id)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .Include(c => c.Modules)
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId);

            if (course == null)
                return NotFound();

            var moduleIds = course.Modules.Select(m => m.Id).ToList();

            if (moduleIds.Count > 0)
            {
                var subModules = await _db.CourseSubModules
                    .Where(sm => moduleIds.Contains(sm.CourseModuleId))
                    .ToListAsync();
                _db.CourseSubModules.RemoveRange(subModules);
            }

            if (moduleIds.Count > 0)
            {
                var scheduled = await _db.ScheduleEvents
                    .Where(e => e.UserId == userId && e.CourseModuleId.HasValue && moduleIds.Contains(e.CourseModuleId.Value))
                    .ToListAsync();
                _db.ScheduleEvents.RemoveRange(scheduled);
            }

            _db.CourseModules.RemoveRange(course.Modules);
            _db.Courses.Remove(course);
            await _db.SaveChangesAsync();

            return Ok(new { message = "Course deleted successfully" });
        }

        [HttpPost("{courseId}/reminder/test")]
        public async Task<IActionResult> SendTestReminder(int courseId)
        {
            var userId = GetUserId();
            var course = await _db.Courses.FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);
            if (course == null)
            {
                return NotFound(new { message = "Course not found" });
            }

            if (string.IsNullOrWhiteSpace(course.ReminderEmail))
            {
                return BadRequest(new { message = "Reminder email is not set for this course." });
            }

            try
            {
                var subject = $"Test reminder: '{course.Title}'";
                var body =
                    $"Hi,\n\n" +
                    $"This is a test reminder email for your course '{course.Title}'.\n\n" +
                    $"- Learnit";

                await _emailSender.SendAsync(course.ReminderEmail, subject, body, HttpContext.RequestAborted);
                course.LastReminderSentAt = DateTime.UtcNow;
                course.UpdatedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();
                return Ok(new { message = "Test reminder email sent." });
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(new { message = ex.Message });
            }
        }

        [HttpPost("{courseId}/certificate/issue")]
        public async Task<IActionResult> IssueCertificate(int courseId)
        {
            var userId = GetUserId();

            var course = await _db.Courses
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);

            if (course == null)
            {
                return NotFound(new { message = "Course not found" });
            }

            var totalModules = course.Modules?.Count ?? 0;
            var completedModules = course.Modules?.Count(m => m.IsCompleted) ?? 0;
            var progressPct = totalModules > 0
                ? (decimal)completedModules * 100m / totalModules
                : 0m;

            if (progressPct < 100m)
            {
                return BadRequest(new
                {
                    message = "Course is not completed yet.",
                    progressPercentage = progressPct
                });
            }

            if (course.CertificateIssuedAt.HasValue)
            {
                return Ok(new
                {
                    message = "Certificate already issued.",
                    certificateIssuedAt = course.CertificateIssuedAt
                });
            }

            course.CertificateIssuedAt = DateTime.UtcNow;
            course.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new
            {
                message = "Certificate issued.",
                certificateIssuedAt = course.CertificateIssuedAt
            });
        }

        // Course Editing Methods
        [HttpPatch("modules/{moduleId}/toggle-completion")]
        public async Task<IActionResult> ToggleModuleCompletion(int moduleId)
        {
            var userId = GetUserId();

            var module = await _db.CourseModules
                .Include(m => m.SubModules)
                .Include(m => m.Course)
                    .ThenInclude(c => c.ExternalLinks)
                .FirstOrDefaultAsync(m => m.Id == moduleId && m.Course!.UserId == userId);

            if (module == null)
            {
                var sub = await _db.CourseSubModules
                    .Include(sm => sm.CourseModule)!
                        .ThenInclude(cm => cm.Course)
                    .FirstOrDefaultAsync(sm => sm.Id == moduleId && sm.CourseModule!.Course!.UserId == userId);

                if (sub == null)
                    return NotFound();

                // Allow manual toggle for submodules
                sub.IsCompleted = !sub.IsCompleted;
                var course = sub.CourseModule!.Course!;
                await _db.Entry(course).Collection(c => c.Modules).LoadAsync();
                var completedEstimated = course.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
                course.HoursRemaining = Math.Max(0, course.TotalEstimatedHours - completedEstimated);
                course.UpdatedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();
                return Ok(new { sub.IsCompleted, course.HoursRemaining });
            }

            // Check if this is an external course (has external links, not YouTube)
            var isExternalCourse = module.Course!.ExternalLinks != null && 
                module.Course.ExternalLinks.Any() &&
                !module.Course.ExternalLinks.Any(l => 
                    l.Platform.Contains("YouTube", StringComparison.OrdinalIgnoreCase) ||
                    l.Url.Contains("youtube.com", StringComparison.OrdinalIgnoreCase) ||
                    l.Url.Contains("youtu.be", StringComparison.OrdinalIgnoreCase));

            // For external courses: Check if user has passed the quiz before allowing completion
            if (module.Course!.IsQuizEnabled && isExternalCourse && !module.IsCompleted)
            {
                // Check if user has a passing quiz attempt
                var hasPassedQuiz = await _db.QuizAttempts
                    .Include(qa => qa.Quiz)
                    .Where(qa => qa.Quiz.CourseModuleId == moduleId && 
                                qa.UserId == userId && 
                                qa.Passed)
                    .AnyAsync();

                if (!hasPassedQuiz)
                {
                    // Check if quiz exists
                    var quizExists = await _db.Quizzes.AnyAsync(q => q.CourseModuleId == moduleId);
                    return BadRequest(new 
                    { 
                        message = "You must pass the module quiz before marking it as complete.",
                        requiresQuiz = true,
                        quizExists = quizExists,
                        moduleId = moduleId
                    });
                }
            }

            // Allow manual toggle for modules
            module.IsCompleted = !module.IsCompleted;

            // If a top-level module is completed, ensure all its submodules are also completed
            if (module.IsCompleted && module.SubModules != null && module.SubModules.Count > 0)
            {
                foreach (var sub in module.SubModules)
                {
                    sub.IsCompleted = true;
                }
            }

            var parentCourse = module.Course!;
            await _db.Entry(parentCourse).Collection(c => c.Modules).LoadAsync();
            var completedEstimatedHours = parentCourse.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
            parentCourse.HoursRemaining = Math.Max(0, parentCourse.TotalEstimatedHours - completedEstimatedHours);
            parentCourse.UpdatedAt = DateTime.UtcNow;

            await _db.SaveChangesAsync();

            // Check for new awards after toggle
            if (module.IsCompleted)
            {
                try
                {
                    await _awardService.CheckAndGrantAwards(userId);
                }
                catch (Exception awardEx)
                {
                    Console.WriteLine($"Error checking awards: {awardEx.Message}");
                }
            }

            return Ok(new { module.IsCompleted, parentCourse.HoursRemaining });
        }
        
        // New endpoint: Set module completion state (for auto-tracking)
        [HttpPatch("modules/{moduleId}/set-completion")]
        public async Task<IActionResult> SetModuleCompletion(int moduleId, [FromBody] SetCompletionDto dto)
        {
            try
            {
                var userId = GetUserId();

                var module = await _db.CourseModules
                    .Include(m => m.SubModules)
                    .Include(m => m.Course)!
                        .ThenInclude(c => c.ExternalLinks) // Include ExternalLinks for the check
                    .FirstOrDefaultAsync(m => m.Id == moduleId && m.Course!.UserId == userId);

                if (module == null)
                {
                    // Check if it's a submodule
                    var sub = await _db.CourseSubModules
                        .Include(sm => sm.CourseModule)!
                            .ThenInclude(cm => cm.Course)!
                                .ThenInclude(c => c.ExternalLinks)
                        .FirstOrDefaultAsync(sm => sm.Id == moduleId && sm.CourseModule!.Course!.UserId == userId);

                    if (sub == null)
                        return NotFound();

                    // Allow manual set for submodules (no quiz required)
                    sub.IsCompleted = dto.IsCompleted;
                    var course = sub.CourseModule!.Course!;
                    await _db.Entry(course).Collection(c => c.Modules).LoadAsync();
                    var completedEstimated = course.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
                    course.HoursRemaining = Math.Max(0, course.TotalEstimatedHours - completedEstimated);
                    course.UpdatedAt = DateTime.UtcNow;
                    await _db.SaveChangesAsync();
                    
                    // Check for new awards
                    if (dto.IsCompleted)
                    {
                        try
                        {
                            await _awardService.CheckAndGrantAwards(userId);
                        }
                        catch (Exception awardEx)
                        {
                            Console.WriteLine($"Error checking awards: {awardEx.Message}");
                        }
                    }
                    
                    return Ok(new { isCompleted = sub.IsCompleted, course.HoursRemaining });
                }

                // Check if this is an external course (has external links, not YouTube)
                var isExternalCourse = module.Course!.ExternalLinks != null && 
                    module.Course.ExternalLinks.Any() &&
                    !module.Course.ExternalLinks.Any(l => 
                        l.Platform.Contains("YouTube", StringComparison.OrdinalIgnoreCase) ||
                        l.Url.Contains("youtube.com", StringComparison.OrdinalIgnoreCase) ||
                        l.Url.Contains("youtu.be", StringComparison.OrdinalIgnoreCase));

                // For external courses: Check if user has passed the quiz before allowing completion
                if (module.Course!.IsQuizEnabled && isExternalCourse && dto.IsCompleted && !module.IsCompleted)
                {
                    // Check if user has a passing quiz attempt
                    var hasPassedQuiz = await _db.QuizAttempts
                        .Include(qa => qa.Quiz) // Ensure Quiz is included for the CourseModuleId check
                        .AnyAsync(qa => qa.Quiz!.CourseModuleId == moduleId && 
                                       qa.UserId == userId && 
                                       qa.Passed);

                    if (!hasPassedQuiz)
                    {
                        // Check if quiz exists
                        var quizExists = await _db.Quizzes.AnyAsync(q => q.CourseModuleId == moduleId);
                        return BadRequest(new 
                        { 
                            message = "You must pass the module quiz before marking it as complete.",
                            requiresQuiz = true,
                            quizExists = quizExists,
                            moduleId = moduleId
                        });
                    }
                }

                // Set completion state (for auto-tracking based on video playback)
                var wasCompleted = module.IsCompleted;
                module.IsCompleted = dto.IsCompleted;

                // If a top-level module is completed, ensure all its submodules are also completed
                if (dto.IsCompleted && module.SubModules != null && module.SubModules.Count > 0)
                {
                    foreach (var sub in module.SubModules)
                    {
                        sub.IsCompleted = true;
                    }
                }

                var parentCourse = module.Course!;
                await _db.Entry(parentCourse).Collection(c => c.Modules).LoadAsync();
                var completedEstimatedHours = parentCourse.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
                parentCourse.HoursRemaining = Math.Max(0, parentCourse.TotalEstimatedHours - completedEstimatedHours);
                parentCourse.UpdatedAt = DateTime.UtcNow;

                await _db.SaveChangesAsync();

                // Check for new awards after completion
                if (dto.IsCompleted && !wasCompleted)
                {
                    try
                    {
                        await _awardService.CheckAndGrantAwards(userId);
                    }
                    catch (Exception awardEx)
                    {
                        // Log but don't fail the request
                        Console.WriteLine($"Error checking awards: {awardEx.Message}");
                    }
                }

                return Ok(new { module.IsCompleted, parentCourse.HoursRemaining });
            }
            catch (OperationCanceledException)
            {
                // Request was canceled (e.g., user navigated away) - return success to avoid error logs
                return Ok(new { message = "Operation canceled" });
            }
            catch (Exception ex)
            {
                // Log other errors but don't crash
                Console.WriteLine($"Error setting module completion: {ex.Message}");
                return StatusCode(500, new { message = "Failed to update module completion" });
            }
        }

        [HttpPut("{id}/edit")]
        public async Task<IActionResult> EditCourse(int id, CreateCourseDto dto)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .Include(c => c.ExternalLinks)
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId);

            if (course == null)
                return NotFound();

            // Update course fields
            course.Title = dto.Title;
            course.Description = dto.Description;
            course.SubjectArea = dto.SubjectArea;
            course.LearningObjectives = dto.LearningObjectives;
            course.Difficulty = dto.Difficulty;
            course.Priority = dto.Priority;
            course.TotalEstimatedHours = dto.TotalEstimatedHours;
            course.TargetCompletionDate = EnsureUtc(dto.TargetCompletionDate);
            course.Notes = dto.Notes;
            if (!TryNormalizeEmail(dto.ReminderEmail, out var reminderEmail))
            {
                return BadRequest(new { message = "A valid reminder email is required." });
            }
            course.ReminderEmail = reminderEmail;
            course.IsQuizEnabled = dto.IsQuizEnabled;
            course.UpdatedAt = DateTime.UtcNow;


            // Replace modules and submodules
            // Materialize collections to prevent lazy loading issues
            var modulesList = course.Modules?.ToList() ?? new List<CourseModule>();
            var moduleIds = modulesList.Select(m => m.Id).ToList();

            // Delete all ScheduleEvents that reference these modules (to avoid FK constraint violation)
            var eventsToDelete = await _db.ScheduleEvents
                .Where(e => e.CourseModuleId.HasValue && moduleIds.Contains(e.CourseModuleId.Value))
                .ToListAsync();
            _db.ScheduleEvents.RemoveRange(eventsToDelete);

            var subModulesList = modulesList
                .SelectMany(m => m.SubModules?.ToList() ?? new List<CourseSubModule>())
                .ToList();
            _db.CourseSubModules.RemoveRange(subModulesList);
            _db.CourseModules.RemoveRange(modulesList);

            var newModules = new List<(CourseModule Module, CreateCourseModuleDto Dto)>();
            for (int i = 0; i < dto.Modules.Count; i++)
            {
                var m = dto.Modules[i];
                var module = new CourseModule
                {
                    CourseId = course.Id,
                    Title = m.Title,
                    Description = m.Description,
                    EstimatedHours = m.EstimatedHours,
                    Order = i,
                    Notes = m.Notes,
                    IsCompleted = m.IsCompleted
                };
                newModules.Add((module, m));
                _db.CourseModules.Add(module);
            }

            await _db.SaveChangesAsync();

            foreach (var pair in newModules)
            {
                var module = pair.Module;
                var subs = pair.Dto.SubModules ?? new List<CreateCourseSubModuleDto>();
                for (int i = 0; i < subs.Count; i++)
                {
                    var sm = subs[i];
                    _db.CourseSubModules.Add(new CourseSubModule
                    {
                        CourseModuleId = module.Id,
                        Title = sm.Title,
                        Description = sm.Description,
                        EstimatedHours = sm.EstimatedHours,
                        Order = i,
                        Notes = sm.Notes,
                        IsCompleted = sm.IsCompleted
                    });
                }
            }

            await _db.SaveChangesAsync();

            // Update external links
            // Materialize collection to prevent lazy loading issues
            var externalLinksList = course.ExternalLinks?.ToList() ?? new List<ExternalLink>();
            _db.ExternalLinks.RemoveRange(externalLinksList);
            foreach (var linkDto in dto.ExternalLinks)
            {
                var link = new ExternalLink
                {
                    CourseId = course.Id,
                    Platform = linkDto.Platform,
                    Title = linkDto.Title,
                    Url = linkDto.Url,
                    CreatedAt = DateTime.UtcNow
                };
                _db.ExternalLinks.Add(link);
            }

            // Reload course with modules and submodules for calculation (use AsNoTracking to prevent circular references)
            var courseForCalculation = await _db.Courses
                .AsNoTracking()
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .FirstOrDefaultAsync(c => c.Id == course.Id);

            if (courseForCalculation != null)
            {
                course.HoursRemaining = CalculateHoursRemainingFromModules(courseForCalculation);
            }

            await _db.SaveChangesAsync();

            return Ok(new { message = "Course updated successfully" });
        }

        // Session Management Methods
        [HttpPost("{courseId}/sessions/start")]
        public async Task<IActionResult> StartStudySession(int courseId, [FromQuery] int? moduleId)
        {
            var userId = GetUserId();

            // Check if course belongs to user
            var course = await _db.Courses.FindAsync(courseId);
            if (course == null || course.UserId != userId)
                return NotFound();

            // Check if there's already an active session
            var activeSession = await _db.StudySessions
                .FirstOrDefaultAsync(s => s.CourseId == courseId && !s.IsCompleted && s.EndTime == null);

            if (activeSession != null)
                return BadRequest(new { message = "An active study session already exists for this course" });

            var session = new StudySession
            {
                CourseId = courseId,
                CourseModuleId = moduleId,
                StartTime = DateTime.UtcNow,
                DurationHours = 0,
                Notes = "",
                IsCompleted = false,
                CreatedAt = DateTime.UtcNow
            };

            _db.StudySessions.Add(session);
            await _db.SaveChangesAsync();

            return Ok(new StudySessionDto
            {
                Id = session.Id,
                CourseModuleId = session.CourseModuleId,
                StartTime = session.StartTime,
                DurationHours = session.DurationHours,
                Notes = session.Notes,
                IsCompleted = session.IsCompleted
            });
        }

        [HttpPut("sessions/{sessionId}/stop")]
        public async Task<IActionResult> StopStudySession(int sessionId, [FromBody] string notes = "")
        {
            var userId = GetUserId();

            var session = await _db.StudySessions
                .Include(s => s.Course)
                .FirstOrDefaultAsync(s => s.Id == sessionId && s.Course!.UserId == userId);

            if (session == null)
                return NotFound();

            if (session.IsCompleted)
                return BadRequest(new { message = "Session is already completed" });

            var endTime = DateTime.UtcNow;
            var duration = (decimal)(endTime - session.StartTime).TotalHours;

            session.EndTime = endTime;
            session.DurationHours = Math.Round(duration, 2);
            session.Notes = notes;
            session.IsCompleted = true; // Mark as completed - this is PERSISTENT in database

            // Update course's last studied time
            session.Course!.LastStudiedAt = endTime;
            session.Course.UpdatedAt = endTime;

            // Save to database - this ensures data persists across logouts
            await _db.SaveChangesAsync();

            // Update ActivityLog (persistent aggregated data for heatmap)
            // This ensures heatmap data persists even after logout
            await UpdateActivityLog(userId, session.StartTime.Date, duration);

            return Ok(new StudySessionDto
            {
                Id = session.Id,
                CourseModuleId = session.CourseModuleId,
                StartTime = session.StartTime,
                EndTime = session.EndTime,
                DurationHours = session.DurationHours,
                Notes = session.Notes,
                IsCompleted = session.IsCompleted
            });
        }

        [HttpGet("{courseId}/sessions")]
        public async Task<IActionResult> GetCourseSessions(int courseId)
        {
            var userId = GetUserId();

            var course = await _db.Courses.FindAsync(courseId);
            if (course == null || course.UserId != userId)
                return NotFound();

            var sessions = await _db.StudySessions
                .Where(s => s.CourseId == courseId)
                .OrderByDescending(s => s.StartTime)
                .Select(s => new StudySessionDto
                {
                    Id = s.Id,
                    CourseModuleId = s.CourseModuleId,
                    StartTime = s.StartTime,
                    EndTime = s.EndTime,
                    DurationHours = s.DurationHours,
                    Notes = s.Notes,
                    IsCompleted = s.IsCompleted
                })
                .ToListAsync();

            return Ok(sessions);
        }

        private async Task UpdateActivityLog(int userId, DateTime date, decimal hours)
        {
            var activityLog = await _db.ActivityLogs
                .FirstOrDefaultAsync(a => a.UserId == userId && a.Date.Date == date.Date);

            if (activityLog == null)
            {
                activityLog = new ActivityLog
                {
                    UserId = userId,
                    Date = date.Date,
                    HoursCompleted = hours,
                    ActivityLevel = GetActivityLevel(hours)
                };
                _db.ActivityLogs.Add(activityLog);
            }
            else
            {
                activityLog.HoursCompleted += hours;
                activityLog.ActivityLevel = GetActivityLevel(activityLog.HoursCompleted);
            }

            await _db.SaveChangesAsync();
        }

        private int GetActivityLevel(decimal hours)
        {
            if (hours == 0) return 0;
            if (hours < 2) return 1;
            if (hours < 4) return 2;
            return 3;
        }

        [HttpGet("stats")]
        public async Task<IActionResult> GetStats()
        {
            var userId = GetUserId();
            var courses = await _db.Courses
                .Where(c => c.UserId == userId)
                .ToListAsync();

            var activeCourses = courses.Count;
            var totalHours = courses.Sum(c => c.TotalEstimatedHours);
            var weeklyFocus = totalHours / 4; // Rough estimate

            return Ok(new
            {
                activeCourses = activeCourses.ToString("D2"),
                weeklyFocus = $"{weeklyFocus} hrs",
                nextMilestone = courses.OrderBy(c => c.TargetCompletionDate ?? DateTime.MaxValue)
                    .FirstOrDefault()?.Title ?? "No upcoming milestones"
            });
        }

        // Module Management
        [HttpPost("{courseId}/modules")]
        public async Task<IActionResult> CreateModule(int courseId, [FromBody] CreateModuleDto dto)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .Include(c => c.Modules)
                .FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);

            if (course == null)
                return NotFound();

            if (string.IsNullOrWhiteSpace(dto.Title))
                return BadRequest(new { message = "Title is required" });

            if (dto.ParentModuleId.HasValue)
            {
                var parent = course.Modules.FirstOrDefault(m => m.Id == dto.ParentModuleId.Value);
                if (parent == null)
                    return BadRequest(new { message = "Parent module not found" });

                var nextSubOrder = parent.SubModules.Any() ? parent.SubModules.Max(s => s.Order) + 1 : 0;
                var sub = new CourseSubModule
                {
                    CourseModuleId = parent.Id,
                    Title = dto.Title,
                    Description = dto.Description ?? "",
                    EstimatedHours = dto.EstimatedHours ?? 0,
                    Order = nextSubOrder,
                    Notes = dto.Notes ?? "",
                    IsCompleted = false
                };

                _db.CourseSubModules.Add(sub);
                course.UpdatedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();

                return Ok(new CourseSubModuleDto
                {
                    Id = sub.Id,
                    Title = sub.Title,
                    Description = sub.Description,
                    EstimatedHours = sub.EstimatedHours,
                    Order = sub.Order,
                    Notes = sub.Notes,
                    IsCompleted = sub.IsCompleted
                });
            }

            var nextOrder = course.Modules.Any() ? course.Modules.Max(m => m.Order) + 1 : 0;

            var module = new CourseModule
            {
                CourseId = courseId,
                Title = dto.Title,
                Description = dto.Description ?? "",
                EstimatedHours = dto.EstimatedHours ?? 0,
                Order = nextOrder,
                Notes = dto.Notes ?? "",
                IsCompleted = false
            };

            _db.CourseModules.Add(module);
            course.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new CourseModuleDto
            {
                Id = module.Id,
                Title = module.Title,
                Description = module.Description,
                EstimatedHours = module.EstimatedHours,
                Order = module.Order,
                Notes = module.Notes,
                IsCompleted = module.IsCompleted,
                SubModules = new List<CourseSubModuleDto>()
            });
        }

        [HttpPut("modules/{moduleId}")]
        public async Task<IActionResult> UpdateModule(int moduleId, [FromBody] UpdateModuleDto dto)
        {
            var userId = GetUserId();
            var module = await _db.CourseModules
                .Include(m => m.Course)
                .Include(m => m.SubModules)
                .FirstOrDefaultAsync(m => m.Id == moduleId && m.Course!.UserId == userId);

            if (module != null)
            {
                if (!string.IsNullOrEmpty(dto.Title))
                    module.Title = dto.Title;
                if (!string.IsNullOrEmpty(dto.Description))
                    module.Description = dto.Description;
                if (dto.EstimatedHours.HasValue)
                    module.EstimatedHours = dto.EstimatedHours.Value;
                if (!string.IsNullOrEmpty(dto.Notes))
                    module.Notes = dto.Notes;

                module.Course!.UpdatedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();

                return Ok(new CourseModuleDto
                {
                    Id = module.Id,
                    Title = module.Title,
                    Description = module.Description,
                    EstimatedHours = module.EstimatedHours,
                    Order = module.Order,
                    Notes = module.Notes,
                    IsCompleted = module.IsCompleted,
                    SubModules = module.SubModules.OrderBy(sm => sm.Order).Select(sm => new CourseSubModuleDto
                    {
                        Id = sm.Id,
                        Title = sm.Title,
                        Description = sm.Description,
                        EstimatedHours = sm.EstimatedHours,
                        Order = sm.Order,
                        Notes = sm.Notes,
                        IsCompleted = sm.IsCompleted
                    }).ToList()
                });
            }

            var sub = await _db.CourseSubModules
                .Include(sm => sm.CourseModule)!
                    .ThenInclude(cm => cm.Course)
                .FirstOrDefaultAsync(sm => sm.Id == moduleId && sm.CourseModule!.Course!.UserId == userId);

            if (sub == null)
                return NotFound();

            if (!string.IsNullOrEmpty(dto.Title))
                sub.Title = dto.Title;
            if (!string.IsNullOrEmpty(dto.Description))
                sub.Description = dto.Description;
            if (dto.EstimatedHours.HasValue)
                sub.EstimatedHours = dto.EstimatedHours.Value;
            if (!string.IsNullOrEmpty(dto.Notes))
                sub.Notes = dto.Notes;

            sub.CourseModule!.Course!.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new CourseSubModuleDto
            {
                Id = sub.Id,
                Title = sub.Title,
                Description = sub.Description,
                EstimatedHours = sub.EstimatedHours,
                Order = sub.Order,
                Notes = sub.Notes,
                IsCompleted = sub.IsCompleted
            });
        }

        // External Links Management
        [HttpPost("{courseId}/external-links")]
        public async Task<IActionResult> AddExternalLink(int courseId, [FromBody] CreateExternalLinkDto dto)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);

            if (course == null)
                return NotFound();

            var link = new ExternalLink
            {
                CourseId = courseId,
                Platform = dto.Platform,
                Title = dto.Title,
                Url = dto.Url,
                CreatedAt = DateTime.UtcNow
            };

            _db.ExternalLinks.Add(link);
            course.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new ExternalLinkDto
            {
                Id = link.Id,
                Platform = link.Platform,
                Title = link.Title,
                Url = link.Url,
                CreatedAt = link.CreatedAt
            });
        }

        [HttpPut("external-links/{linkId}")]
        public async Task<IActionResult> UpdateExternalLink(int linkId, [FromBody] UpdateExternalLinkDto dto)
        {
            var userId = GetUserId();
            var link = await _db.ExternalLinks
                .Include(l => l.Course)
                .FirstOrDefaultAsync(l => l.Id == linkId && l.Course!.UserId == userId);

            if (link == null)
                return NotFound();

            if (!string.IsNullOrEmpty(dto.Platform))
                link.Platform = dto.Platform;
            if (!string.IsNullOrEmpty(dto.Title))
                link.Title = dto.Title;
            if (!string.IsNullOrEmpty(dto.Url))
                link.Url = dto.Url;

            link.Course!.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();

            return Ok(new ExternalLinkDto
            {
                Id = link.Id,
                Platform = link.Platform,
                Title = link.Title,
                Url = link.Url,
                CreatedAt = link.CreatedAt
            });
        }

        [HttpDelete("external-links/{linkId}")]
        public async Task<IActionResult> DeleteExternalLink(int linkId)
        {
            var userId = GetUserId();
            var link = await _db.ExternalLinks
                .Include(l => l.Course)
                .FirstOrDefaultAsync(l => l.Id == linkId && l.Course!.UserId == userId);

            if (link == null)
                return NotFound();

            link.Course!.UpdatedAt = DateTime.UtcNow;
            _db.ExternalLinks.Remove(link);
            await _db.SaveChangesAsync();

            return Ok(new { message = "External link deleted successfully" });
        }

        // Active Time Tracking
        [HttpPost("{courseId}/active-time")]
        public async Task<IActionResult> UpdateActiveTime(int courseId, [FromBody] UpdateActiveTimeDto dto)
        {
            var userId = GetUserId();
            var course = await _db.Courses
                .FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);

            if (course == null)
                return NotFound();

            // Update last studied time
            course.LastStudiedAt = DateTime.UtcNow;
            course.UpdatedAt = DateTime.UtcNow;

            // Create or update study session for active time tracking
            var activeSession = await _db.StudySessions
                .FirstOrDefaultAsync(s => s.CourseId == courseId && !s.IsCompleted && s.EndTime == null);

            var normalizedHours = Math.Max(0, dto.Hours);
            var normalizedDuration = Math.Round(normalizedHours, 2);
            var normalizedStart = DateTime.UtcNow.AddHours(-(double)normalizedHours);

            if (activeSession != null)
            {
                // Align the active session with the reported watch time instead of wall-clock elapsed time
                activeSession.StartTime = normalizedStart;
                activeSession.DurationHours = normalizedDuration;
            }
            else
            {
                // Create new session for tracking
                activeSession = new StudySession
                {
                    CourseId = courseId,
                    StartTime = normalizedStart,
                    DurationHours = normalizedDuration,
                    Notes = "",
                    IsCompleted = false,
                    CreatedAt = DateTime.UtcNow
                };
                _db.StudySessions.Add(activeSession);
            }

            // Update course progress based on active time
            var totalCompletedHours = await _db.StudySessions
                .Where(s => s.CourseId == courseId && s.IsCompleted)
                .SumAsync(s => s.DurationHours);

            // Add current active session time
            totalCompletedHours += activeSession.DurationHours;

            // Also calculate based on completed modules/submodules (more accurate)
            var courseWithModules = await _db.Courses
                .Include(c => c.Modules)
                    .ThenInclude(m => m.SubModules)
                .FirstOrDefaultAsync(c => c.Id == courseId);
            
            if (courseWithModules != null)
            {
                var moduleHours = courseWithModules.Modules.Sum(m => m.EstimatedHours);
                var subModuleHours = courseWithModules.Modules.SelectMany(m => m.SubModules).Sum(sm => sm.EstimatedHours);
                var totalEstimated = moduleHours + subModuleHours;
                
                if (totalEstimated == 0 && courseWithModules.TotalEstimatedHours > 0)
                {
                    totalEstimated = courseWithModules.TotalEstimatedHours;
                }

                var completedModuleHours = courseWithModules.Modules.Where(m => m.IsCompleted).Sum(m => m.EstimatedHours);
                var completedSubModuleHours = courseWithModules.Modules
                    .SelectMany(m => m.SubModules)
                    .Where(sm => sm.IsCompleted)
                    .Sum(sm => sm.EstimatedHours);
                var completedEstimated = completedModuleHours + completedSubModuleHours;

                // Use the higher of the two (study sessions vs module completion)
                var effectiveCompleted = Math.Max(totalCompletedHours, completedEstimated);
                var hoursRemaining = Math.Max(0, totalEstimated - effectiveCompleted);
                course.HoursRemaining = (int)Math.Ceiling(hoursRemaining);
            }
            else
            {
                var hoursRemaining = Math.Max(0, (decimal)course.TotalEstimatedHours - totalCompletedHours);
                course.HoursRemaining = (int)Math.Ceiling(hoursRemaining);
            }

            // Update last studied timestamp
            course.LastStudiedAt = DateTime.UtcNow;
            course.UpdatedAt = DateTime.UtcNow;

            await _db.SaveChangesAsync();

            return Ok(new { 
                message = "Active time updated",
                hoursRemaining = course.HoursRemaining,
                activeTime = activeSession.DurationHours
            });
        }

        /// <summary>
        /// Save playback position for a course video (YouTube)
        /// This persists across logout/login
        /// </summary>
        [HttpPost("{courseId}/playback-position")]
        public async Task<IActionResult> SavePlaybackPosition(int courseId, [FromBody] SavePlaybackPositionDto dto)
        {
            try
            {
                var userId = GetUserId();
                
                // Verify course belongs to user
                var course = await _db.Courses.FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);
                if (course == null)
                {
                    return NotFound("Course not found");
                }

                // Find or create playback position
                var playback = await _db.PlaybackPositions
                    .FirstOrDefaultAsync(p => 
                        p.UserId == userId && 
                        p.CourseId == courseId && 
                        p.VideoId == dto.VideoId &&
                        (dto.ModuleId == null || p.ModuleId == dto.ModuleId));

                // CRITICAL: Don't save positions that are too close to 0 (initial load)
                // Only save meaningful positions (>= 2 seconds) to avoid overwriting good positions
                const double MIN_SAVE_TIME = 2.0;
                if (dto.CurrentTimeSeconds < MIN_SAVE_TIME && dto.CurrentTimeSeconds > 0)
                {
                    // If we have an existing position that's better, don't overwrite it with a small value
                    if (playback != null && playback.CurrentTimeSeconds >= MIN_SAVE_TIME)
                    {
                        // Keep the existing better position
                        return Ok(new { message = "Playback position not updated (too small, existing position is better)" });
                    }
                    // If no existing position or existing is also small, we can still save it
                    // (but it will be ignored on resume if < 2 seconds)
                }

                if (playback == null)
                {
                    playback = new PlaybackPosition
                    {
                        UserId = userId,
                        CourseId = courseId,
                        ModuleId = dto.ModuleId,
                        VideoId = dto.VideoId,
                        PlaylistId = dto.PlaylistId ?? "",
                        CurrentTimeSeconds = dto.CurrentTimeSeconds,
                        DurationSeconds = dto.DurationSeconds,
                        LastUpdatedAt = DateTime.UtcNow
                    };
                    _db.PlaybackPositions.Add(playback);
                }
                else
                {
                    // Only update if new position is better (higher) or if old position was invalid (< 2s)
                    if (dto.CurrentTimeSeconds >= MIN_SAVE_TIME || playback.CurrentTimeSeconds < MIN_SAVE_TIME)
                    {
                        playback.CurrentTimeSeconds = dto.CurrentTimeSeconds;
                        playback.DurationSeconds = dto.DurationSeconds;
                        playback.LastUpdatedAt = DateTime.UtcNow;
                        if (!string.IsNullOrEmpty(dto.PlaylistId))
                        {
                            playback.PlaylistId = dto.PlaylistId;
                        }
                    }
                }

                try
                {
                    await _db.SaveChangesAsync();
                    return Ok(new { message = "Playback position saved" });
                }
                catch (OperationCanceledException)
                {
                    // Request was canceled (e.g., user navigated away) - this is expected, return success
                    return Ok(new { message = "Playback position save canceled" });
                }
                catch (Exception ex)
                {
                    // Log other errors but don't crash
                    Console.WriteLine($"Error saving playback position: {ex.Message}");
                    Console.WriteLine($"Stack trace: {ex.StackTrace}");
                    if (ex.InnerException != null)
                    {
                        Console.WriteLine($"Inner exception: {ex.InnerException.Message}");
                    }
                    return StatusCode(500, new { message = "Failed to save playback position", error = ex.Message });
                }
            }
            catch (OperationCanceledException)
            {
                // Request was canceled at an earlier stage - return success
                return Ok(new { message = "Playback position save canceled" });
            }
            catch (Exception ex)
            {
                // Log other errors but don't crash
                Console.WriteLine($"Error saving playback position: {ex.Message}");
                Console.WriteLine($"Stack trace: {ex.StackTrace}");
                if (ex.InnerException != null)
                {
                    Console.WriteLine($"Inner exception: {ex.InnerException.Message}");
                }
                return StatusCode(500, new { message = "Failed to save playback position", error = ex.Message });
            }
        }

        /// <summary>
        /// Get saved playback position for a course video (YouTube)
        /// </summary>
        [HttpGet("{courseId}/playback-position")]
        public async Task<IActionResult> GetPlaybackPosition(int courseId, [FromQuery] string? videoId, [FromQuery] int? moduleId = null)
        {
            try
            {
                var userId = GetUserId();
                
                // Verify course belongs to user
                var course = await _db.Courses.FirstOrDefaultAsync(c => c.Id == courseId && c.UserId == userId);
                if (course == null)
                {
                    return NotFound("Course not found");
                }

                // If videoId is empty, return default position
                if (string.IsNullOrWhiteSpace(videoId))
                {
                    return Ok(new PlaybackPositionDto 
                    { 
                        CurrentTimeSeconds = 0, 
                        DurationSeconds = 0,
                        LastUpdatedAt = DateTime.UtcNow
                    });
                }

                // Try to find playback position with exact match (videoId + moduleId if provided)
                // Order by LastUpdatedAt descending to get the most recent position
                var playback = await _db.PlaybackPositions
                    .Where(p => 
                        p.UserId == userId && 
                        p.CourseId == courseId && 
                        p.VideoId == videoId &&
                        (moduleId == null || p.ModuleId == moduleId))
                    .OrderByDescending(p => p.LastUpdatedAt)
                    .FirstOrDefaultAsync();

                // If not found with moduleId, try without moduleId (for course-level position)
                // Also get the most recent one
                if (playback == null && moduleId.HasValue)
                {
                    playback = await _db.PlaybackPositions
                        .Where(p => 
                            p.UserId == userId && 
                            p.CourseId == courseId && 
                            p.VideoId == videoId &&
                            p.ModuleId == null)
                        .OrderByDescending(p => p.LastUpdatedAt)
                        .FirstOrDefaultAsync();
                }
                
                // If still not found, try to find ANY position for this course and videoId (most recent)
                // This handles cases where videoId might have slight variations
                if (playback == null)
                {
                    playback = await _db.PlaybackPositions
                        .Where(p => 
                            p.UserId == userId && 
                            p.CourseId == courseId && 
                            p.VideoId == videoId)
                        .OrderByDescending(p => p.LastUpdatedAt)
                        .ThenByDescending(p => p.CurrentTimeSeconds) // Prefer positions with more progress
                        .FirstOrDefaultAsync();
                }

                if (playback == null)
                {
                    return Ok(new PlaybackPositionDto 
                    { 
                        CurrentTimeSeconds = 0, 
                        DurationSeconds = 0,
                        LastUpdatedAt = DateTime.UtcNow
                    });
                }

                // CRITICAL: Ignore positions that are 0.0s (likely initial load, not a real position)
                // Only return positions that are meaningful (>= 2 seconds)
                if (playback.CurrentTimeSeconds >= 2.0)
                {
                    // Log for debugging
                    Console.WriteLine($"[GetPlaybackPosition] Found position: {playback.CurrentTimeSeconds}s ({playback.CurrentTimeSeconds/60:F1} min) for videoId={videoId}, moduleId={moduleId}, courseId={courseId}, userId={userId}, lastUpdated={playback.LastUpdatedAt}");
                    return Ok(new PlaybackPositionDto
                    {
                        CurrentTimeSeconds = playback.CurrentTimeSeconds,
                        DurationSeconds = playback.DurationSeconds,
                        LastUpdatedAt = playback.LastUpdatedAt
                    });
                }
                
                // Log when position is too small
                Console.WriteLine($"[GetPlaybackPosition] Position too small: {playback.CurrentTimeSeconds}s for videoId={videoId}, moduleId={moduleId}, courseId={courseId}");
                return Ok(new PlaybackPositionDto 
                { 
                    CurrentTimeSeconds = 0, 
                    DurationSeconds = 0,
                    LastUpdatedAt = DateTime.UtcNow
                });
            }
            catch (OperationCanceledException)
            {
                // Request was canceled (e.g., user navigated away) - return default position
                return Ok(new PlaybackPositionDto 
                { 
                    CurrentTimeSeconds = 0, 
                    DurationSeconds = 0,
                    LastUpdatedAt = DateTime.UtcNow
                });
            }
            catch (Exception ex)
            {
                // Log other errors but don't crash
                Console.WriteLine($"Error getting playback position: {ex.Message}");
                return Ok(new PlaybackPositionDto 
                { 
                    CurrentTimeSeconds = 0, 
                    DurationSeconds = 0,
                    LastUpdatedAt = DateTime.UtcNow
                });
            }
        }
    }

    // DTOs for module and external link updates
    public class UpdateModuleDto
    {
        public string? Title { get; set; }
        public string? Description { get; set; }
        public int? EstimatedHours { get; set; }
        public string? Notes { get; set; }
        public int? ParentModuleId { get; set; }
    }
    
    public class SetCompletionDto
    {
        public bool IsCompleted { get; set; }
    }

    public class CreateModuleDto
    {
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public int? EstimatedHours { get; set; }
        public int? ParentModuleId { get; set; }
        public string? Notes { get; set; }
    }

    public class UpdateExternalLinkDto
    {
        public string? Platform { get; set; }
        public string? Title { get; set; }
        public string? Url { get; set; }
    }

    public class UpdateActiveTimeDto
    {
        public decimal Hours { get; set; }
    }

    public class SavePlaybackPositionDto
    {
        public int? ModuleId { get; set; }
        public string VideoId { get; set; } = "";
        public string PlaylistId { get; set; } = "";
        public double CurrentTimeSeconds { get; set; }
        public double DurationSeconds { get; set; }
    }

    public class PlaybackPositionDto
    {
        public double CurrentTimeSeconds { get; set; }
        public double DurationSeconds { get; set; }
        public DateTime LastUpdatedAt { get; set; }
    }
}

