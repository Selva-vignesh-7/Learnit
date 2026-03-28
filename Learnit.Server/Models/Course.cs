namespace Learnit.Server.Models
{
    public class Course
    {
        public int Id { get; set; }
        public int UserId { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public string SubjectArea { get; set; } = "";
        public string LearningObjectives { get; set; } = "";
        public string Difficulty { get; set; } = ""; // Beginner, Intermediate, Advanced
        public string Priority { get; set; } = ""; // Low, Medium, High
        public int TotalEstimatedHours { get; set; }
        public int HoursRemaining { get; set; }
        public DateTime? TargetCompletionDate { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

        // New fields for enhanced course management
        public string Notes { get; set; } = "";
        public bool IsActive { get; set; } = true; // Whether the course is currently being studied
        public DateTime? LastStudiedAt { get; set; } // When the user last studied this course
        public string ReminderEmail { get; set; } = "";
        public DateTime? LastReminderSentAt { get; set; }
        public DateTime? CertificateIssuedAt { get; set; }

        // Per-course setting: allow disabling quizzes entirely (default enabled)
        public bool IsQuizEnabled { get; set; } = true;

        // Navigation properties
        public List<CourseModule> Modules { get; set; } = new();
        public List<ExternalLink> ExternalLinks { get; set; } = new();
        public List<StudySession> StudySessions { get; set; } = new();
    }
}

