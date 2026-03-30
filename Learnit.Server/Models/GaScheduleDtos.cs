using System;
using System.Collections.Generic;

namespace Learnit.Server.Models
{
    public class GaCourseWeeklyAllocationDto
    {
        public int CourseId { get; set; }
        public string Title { get; set; } = "";
        public decimal Fraction { get; set; }
        public decimal RecommendedHoursPerWeek { get; set; }
    }

    public class GaCourseProjectionDto
    {
        public int CourseId { get; set; }
        public string Title { get; set; } = "";
        public int EstimatedCompletionWeek { get; set; }
        public DateTime? EstimatedCompletionDateUtc { get; set; }
    }

    public class GaScheduleResponseDto
    {
        public decimal PersonalizedWeeklyCapacityHours { get; set; }
        public double BestFitness { get; set; }
        public int GenerationsRun { get; set; }
        public int PopulationSize { get; set; }
        public List<GaCourseWeeklyAllocationDto> Allocations { get; set; } = new();
        public List<GaCourseProjectionDto> Projections { get; set; } = new();
    }
}
