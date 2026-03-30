namespace Learnit.Server.Models
{
    public class CourseSubModule
    {
        public int Id { get; set; }
        public int CourseModuleId { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public int Order { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; }
        public int DifficultyScore { get; set; }

        public CourseModule? CourseModule { get; set; }
    }
}
