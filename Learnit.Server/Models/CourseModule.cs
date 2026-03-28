namespace Learnit.Server.Models
{
    public class CourseModule
    {
        public int Id { get; set; }
        public int CourseId { get; set; }
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public int EstimatedHours { get; set; }
        public int Order { get; set; }
        public string Notes { get; set; } = "";
        public bool IsCompleted { get; set; } = false;
        public int DifficultyScore { get; set; }
        
        // Navigation properties
        public Course? Course { get; set; }
        public List<CourseSubModule> SubModules { get; set; } = new();
    }
}

