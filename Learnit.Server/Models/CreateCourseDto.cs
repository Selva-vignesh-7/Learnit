namespace Learnit.Server.Models
{
    public class CreateCourseDto
    {
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public string SubjectArea { get; set; } = "";
        public string LearningObjectives { get; set; } = "";
        public string Difficulty { get; set; } = "";
        public string Priority { get; set; } = "";
        public int TotalEstimatedHours { get; set; }
        public DateTime? TargetCompletionDate { get; set; }
        public string Notes { get; set; } = "";
        public string ReminderEmail { get; set; } = "";
        public bool IsQuizEnabled { get; set; } = true;
        public List<CreateCourseModuleDto> Modules { get; set; } = new();
        public List<CreateExternalLinkDto> ExternalLinks { get; set; } = new();
    }

    public class CreateExternalLinkDto
    {
        public string Platform { get; set; } = "";
        public string Title { get; set; } = "";
        public string Url { get; set; } = "";
    }

    public class CreateCourseModuleDto
    {
        public int? TempId { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; } = false;
        public List<CreateCourseSubModuleDto> SubModules { get; set; } = new();
    }

    public class CreateCourseSubModuleDto
    {
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; } = false;
    }
}

