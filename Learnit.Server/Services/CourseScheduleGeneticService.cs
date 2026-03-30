using Learnit.Server.Data;
using Learnit.Server.Models;
using Microsoft.EntityFrameworkCore;

namespace Learnit.Server.Services
{
    public interface ICourseScheduleGeneticService
    {
        Task<GaScheduleResponseDto> OptimizeAsync(
            int userId,
            int populationSize,
            int generations,
            CancellationToken cancellationToken = default);
    }

    /// <summary>
    /// Evolves weekly hour allocations across active courses using a genetic algorithm.
    /// Fitness combines deadline adherence (TargetCompletionDate + Priority) with fit to
    /// historical hours-by-course from study sessions (personalized finishing behaviour).
    /// </summary>
    public sealed class CourseScheduleGeneticService : ICourseScheduleGeneticService
    {
        private const int DefaultLookbackWeeks = 8;
        private const double MinWeeklyCapacity = 2.0;
        private const double MaxWeeklyCapacity = 45.0;
        private const int MaxSimulationWeeks = 104;
        private const double CrossoverRate = 0.85;
        private const double MutationRate = 0.22;
        private const int TournamentSize = 3;
        private const int ElitismCount = 2;
        private const double DeadlineWeight = 12.0;
        private const double PersonalizationWeight = 4.0;

        private readonly AppDbContext _db;

        public CourseScheduleGeneticService(AppDbContext db)
        {
            _db = db;
        }

        public async Task<GaScheduleResponseDto> OptimizeAsync(
            int userId,
            int populationSize,
            int generations,
            CancellationToken cancellationToken = default)
        {
            populationSize = Math.Clamp(populationSize, 10, 120);
            generations = Math.Clamp(generations, 10, 200);

            var now = DateTime.UtcNow;
            var lookbackStart = now.AddDays(-DefaultLookbackWeeks * 7);

            var courses = await _db.Courses
                .AsNoTracking()
                .Where(c => c.UserId == userId && c.IsActive && c.HoursRemaining > 0)
                .OrderBy(c => c.Id)
                .Select(c => new CourseGeneInfo(
                    c.Id,
                    c.Title,
                    c.HoursRemaining,
                    c.TargetCompletionDate,
                    c.Priority))
                .ToListAsync(cancellationToken);

            if (courses.Count == 0)
            {
                return new GaScheduleResponseDto
                {
                    PopulationSize = populationSize,
                    GenerationsRun = 0,
                    BestFitness = 0,
                    PersonalizedWeeklyCapacityHours = 0
                };
            }

            var sessionAgg = await _db.StudySessions
                .AsNoTracking()
                .Join(_db.Courses.Where(c => c.UserId == userId), s => s.CourseId, c => c.Id, (s, _) => s)
                .Where(s => s.IsCompleted && s.StartTime >= lookbackStart)
                .GroupBy(s => s.CourseId)
                .Select(g => new { CourseId = g.Key, Hours = g.Sum(s => s.DurationHours) })
                .ToListAsync(cancellationToken);

            var hoursByCourse = sessionAgg.ToDictionary(x => x.CourseId, x => (double)x.Hours);
            var totalHistHours = hoursByCourse.Values.Sum();
            var n = courses.Count;

            var historicalTarget = new double[n];
            for (var i = 0; i < n; i++)
            {
                var id = courses[i].Id;
                historicalTarget[i] = totalHistHours > 0 && hoursByCourse.TryGetValue(id, out var h)
                    ? h / totalHistHours
                    : 1.0 / n;
            }

            NormalizeInPlace(historicalTarget);

            var globalWeeklyHist = totalHistHours / DefaultLookbackWeeks;
            var weeklyCapacity = Math.Clamp(
                globalWeeklyHist > 0 ? globalWeeklyHist : MinWeeklyCapacity,
                MinWeeklyCapacity,
                MaxWeeklyCapacity);

            var rng = Random.Shared;
            var population = new double[populationSize][];
            for (var p = 0; p < populationSize; p++)
            {
                population[p] = new double[n];
                if (p == 0)
                {
                    Array.Copy(historicalTarget, population[p], n);
                }
                else
                {
                    RandomWeights(rng, population[p]);
                    BlendInPlace(population[p], historicalTarget, rng.NextDouble() * 0.35);
                    NormalizeInPlace(population[p]);
                }
            }

            var best = historicalTarget.ToArray();
            var bestFitness = Evaluate(best, courses, weeklyCapacity, historicalTarget, now, out _);

            var crossoverScratch = new double[n];

            for (var gen = 0; gen < generations; gen++)
            {
                var fitness = new double[populationSize];
                for (var i = 0; i < populationSize; i++)
                {
                    fitness[i] = Evaluate(
                        population[i],
                        courses,
                        weeklyCapacity,
                        historicalTarget,
                        now,
                        out _);
                    if (fitness[i] > bestFitness)
                    {
                        bestFitness = fitness[i];
                        Array.Copy(population[i], best, n);
                    }
                }

                var ordered = Enumerable.Range(0, populationSize)
                    .OrderByDescending(i => fitness[i])
                    .ToArray();

                var next = new double[populationSize][];
                var write = 0;
                for (var e = 0; e < ElitismCount; e++, write++)
                {
                    next[write] = (double[])population[ordered[e]].Clone();
                }

                while (write < populationSize)
                {
                    var pa = population[TournamentPick(rng, fitness, TournamentSize)];
                    var pb = population[TournamentPick(rng, fitness, TournamentSize)];
                    var child = new double[n];
                    if (rng.NextDouble() < CrossoverRate)
                    {
                        SimulatedBinaryCrossover(rng, pa, pb, child, crossoverScratch);
                    }
                    else
                    {
                        Array.Copy(rng.NextDouble() < 0.5 ? pa : pb, child, n);
                    }

                    Mutate(rng, child, MutationRate);
                    NormalizeInPlace(child);
                    next[write++] = child;
                }

                population = next;
            }

            var finalFitness = Evaluate(
                best,
                courses,
                weeklyCapacity,
                historicalTarget,
                now,
                out var completionWeeks);

            var allocations = new List<GaCourseWeeklyAllocationDto>(n);
            var projections = new List<GaCourseProjectionDto>(n);
            var todayDate = now.Date;

            for (var i = 0; i < n; i++)
            {
                var c = courses[i];
                var frac = (decimal)Math.Round(best[i], 4);
                allocations.Add(new GaCourseWeeklyAllocationDto
                {
                    CourseId = c.Id,
                    Title = c.Title,
                    Fraction = frac,
                    RecommendedHoursPerWeek = Math.Round((decimal)weeklyCapacity * frac, 2)
                });

                var wk = completionWeeks[i];
                projections.Add(new GaCourseProjectionDto
                {
                    CourseId = c.Id,
                    Title = c.Title,
                    EstimatedCompletionWeek = wk,
                    EstimatedCompletionDateUtc = wk < MaxSimulationWeeks
                        ? todayDate.AddDays(7 * wk)
                        : null
                });
            }

            return new GaScheduleResponseDto
            {
                PersonalizedWeeklyCapacityHours = (decimal)Math.Round(weeklyCapacity, 2),
                BestFitness = Math.Round(finalFitness, 6),
                GenerationsRun = generations,
                PopulationSize = populationSize,
                Allocations = allocations,
                Projections = projections
            };
        }

        private static void RandomWeights(Random rng, double[] w)
        {
            for (var i = 0; i < w.Length; i++)
            {
                w[i] = rng.NextDouble();
            }
        }

        private static void BlendInPlace(double[] w, double[] target, double amount)
        {
            for (var i = 0; i < w.Length; i++)
            {
                w[i] = w[i] * (1 - amount) + target[i] * amount;
            }
        }

        private static void NormalizeInPlace(double[] w)
        {
            var s = w.Sum();
            if (s <= 1e-12)
            {
                for (var i = 0; i < w.Length; i++) w[i] = 1.0 / w.Length;
            }
            else
            {
                for (var i = 0; i < w.Length; i++) w[i] /= s;
            }
        }

        private static int TournamentPick(Random rng, double[] fitness, int k)
        {
            var bestIdx = rng.Next(fitness.Length);
            var bestF = fitness[bestIdx];
            for (var j = 1; j < k; j++)
            {
                var idx = rng.Next(fitness.Length);
                if (fitness[idx] > bestF)
                {
                    bestF = fitness[idx];
                    bestIdx = idx;
                }
            }
            return bestIdx;
        }

        private static void SimulatedBinaryCrossover(Random rng, double[] p1, double[] p2, double[] c1, double[] c2)
        {
            var eta = 2.0 + rng.NextDouble() * 3.0;
            for (var i = 0; i < p1.Length; i++)
            {
                if (rng.NextDouble() > 0.5 || Math.Abs(p1[i] - p2[i]) < 1e-12)
                {
                    c1[i] = p1[i];
                    c2[i] = p2[i];
                    continue;
                }

                var u = rng.NextDouble();
                var beta = u <= 0.5
                    ? Math.Pow(2.0 * u, 1.0 / (eta + 1))
                    : Math.Pow(1.0 / (2.0 * (1.0 - u)), 1.0 / (eta + 1));

                var x1 = 0.5 * ((1 + beta) * p1[i] + (1 - beta) * p2[i]);
                var x2 = 0.5 * ((1 - beta) * p1[i] + (1 + beta) * p2[i]);
                c1[i] = Math.Max(1e-9, x1);
                c2[i] = Math.Max(1e-9, x2);
            }
            NormalizeInPlace(c1);
            NormalizeInPlace(c2);
        }

        private static void Mutate(Random rng, double[] w, double rate)
        {
            for (var i = 0; i < w.Length; i++)
            {
                if (rng.NextDouble() > rate)
                {
                    continue;
                }

                var delta = (rng.NextDouble() - 0.5) * 0.45;
                w[i] = Math.Max(1e-9, w[i] + delta);
            }
        }

        private static double Evaluate(
            double[] weights,
            List<CourseGeneInfo> courses,
            double weeklyCapacity,
            double[] historicalTarget,
            DateTime nowUtc,
            out int[] completionWeeks)
        {
            var n = courses.Count;
            completionWeeks = new int[n];
            var remaining = new double[n];
            for (var i = 0; i < n; i++)
            {
                remaining[i] = Math.Max(0, courses[i].HoursRemaining);
            }

            var done = new bool[n];

            for (var week = 0; week < MaxSimulationWeeks; week++)
            {
                var allDone = true;
                for (var i = 0; i < n; i++)
                {
                    if (!done[i])
                    {
                        allDone = false;
                        break;
                    }
                }
                if (allDone)
                {
                    break;
                }

                for (var i = 0; i < n; i++)
                {
                    if (done[i])
                    {
                        continue;
                    }

                    remaining[i] -= weeklyCapacity * weights[i];
                    if (remaining[i] <= 1e-6)
                    {
                        done[i] = true;
                        completionWeeks[i] = week + 1;
                    }
                }
            }

            for (var i = 0; i < n; i++)
            {
                if (!done[i])
                {
                    completionWeeks[i] = MaxSimulationWeeks;
                }
            }

            double deadlinePenalty = 0;
            var today = nowUtc.Date;

            for (var i = 0; i < n; i++)
            {
                var target = courses[i].TargetCompletionDate;
                if (!target.HasValue)
                {
                    continue;
                }

                var due = target.Value.Date;
                var weeksBudget = Math.Max(0.25, (due - today).TotalDays / 7.0);
                var lateness = completionWeeks[i] - weeksBudget;
                var pw = PriorityMultiplier(courses[i].Priority);
                if (lateness > 0)
                {
                    deadlinePenalty += pw * lateness * lateness;
                }
                else
                {
                    deadlinePenalty += pw * 0.02 * -lateness;
                }
            }

            double personalizationPenalty = 0;
            for (var i = 0; i < n; i++)
            {
                var d = weights[i] - historicalTarget[i];
                personalizationPenalty += d * d;
            }

            return 1000.0
                - DeadlineWeight * deadlinePenalty
                - PersonalizationWeight * personalizationPenalty;
        }

        private static double PriorityMultiplier(string? priority)
        {
            if (string.Equals(priority, "High", StringComparison.OrdinalIgnoreCase))
            {
                return 2.5;
            }
            if (string.Equals(priority, "Medium", StringComparison.OrdinalIgnoreCase))
            {
                return 1.5;
            }
            return 1.0;
        }

        private sealed record CourseGeneInfo(
            int Id,
            string Title,
            int HoursRemaining,
            DateTime? TargetCompletionDate,
            string Priority);
    }
}
