namespace Learnit.Server.Models
{
    public class CourseResponseDto
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public string SubjectArea { get; set; } = "";
        public string LearningObjectives { get; set; } = "";
        public string Difficulty { get; set; } = "";
        public string Priority { get; set; } = "";
        public int TotalEstimatedHours { get; set; }
        public int HoursRemaining { get; set; }
        public int TotalModules { get; set; }
        public int CompletedModules { get; set; }
        public decimal ProgressPercentage { get; set; }
        public decimal ScheduledHours { get; set; }
        public decimal CompletedHours { get; set; }
        public DateTime? TargetCompletionDate { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
        public string Notes { get; set; } = "";
        public bool IsActive { get; set; }
        public DateTime? LastStudiedAt { get; set; }
        public string ReminderEmail { get; set; } = "";
        public DateTime? LastReminderSentAt { get; set; }
        public string UserFullName { get; set; } = "";
        public DateTime? CertificateIssuedAt { get; set; }
        public bool IsQuizEnabled { get; set; }
        public List<CourseModuleDto> Modules { get; set; } = new();
        public List<ExternalLinkDto> ExternalLinks { get; set; } = new();
        public StudySessionDto? ActiveSession { get; set; } // Current active study session if any
    }

    public class ExternalLinkDto
    {
        public int Id { get; set; }
        public string Platform { get; set; } = "";
        public string Title { get; set; } = "";
        public string Url { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    public class StudySessionDto
    {
        public int Id { get; set; }
        public int? CourseModuleId { get; set; }
        public DateTime StartTime { get; set; }
        public DateTime? EndTime { get; set; }
        public decimal DurationHours { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; }
    }

    public class CourseModuleDto
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public int Order { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; }
        public List<CourseSubModuleDto> SubModules { get; set; } = new();
    }

    public class CourseSubModuleDto
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public int Order { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; }
    }
}

