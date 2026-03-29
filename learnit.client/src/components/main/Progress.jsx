import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { progressApi } from "../../services";
import { Loading, ErrorMessage } from "../ui/index";
import styles from "./Progress.module.css";

function Progress() {
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const [gaSchedule, setGaSchedule] = useState(null);
  const [gaLoading, setGaLoading] = useState(false);
  const [gaError, setGaError] = useState("");

  useEffect(() => {
    loadProgressData();

    // Refresh data every 30 seconds to show updated streaks (for the selected week)
    const interval = setInterval(() => {
      loadProgressData();
    }, 30000);

    return () => clearInterval(interval);
  }, [weekOffset]);

  const loadProgressData = async () => {
    try {
      // Avoid a full-page "loading" flash when switching weeks.
      if (!dashboardData) setLoading(true);
      setError("");
      const data = await progressApi.getProgressDashboard({
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        weekOffset,
      });

      const todayShort = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
      }).format(new Date());

      const weeklyData = (data.weeklyData || data.WeeklyData || []).map((d) => {
        const rawDay = String(d.day || d.Day || "").trim();
        const cleanedDay = rawDay.replace(/\.$/, "");
        const normalizedDay =
          cleanedDay.toLowerCase() === "today" ? todayShort : cleanedDay;
        return {
          day: normalizedDay,
          scheduled: Number(d.scheduled ?? d.Scheduled ?? 0),
          completed: Number(d.completed ?? d.Completed ?? 0),
        };
      });

      // Ensure we always render a stable 7-day chart (Mon..Sun).
      const canonicalDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const normalizedWeeklyData = canonicalDays.map((dayLabel) => {
        const found = weeklyData.find(
          (d) => (d.day || "").toLowerCase() === dayLabel.toLowerCase()
        );
        return found || { day: dayLabel, scheduled: 0, completed: 0 };
      });

      const derivedTotals = normalizedWeeklyData.reduce(
        (acc, d) => {
          acc.scheduled += d.scheduled;
          acc.completed += d.completed;
          return acc;
        },
        { scheduled: 0, completed: 0 }
      );

      const serverTotalScheduled = Number(
        data.stats?.totalScheduledHours ?? data.Stats?.TotalScheduledHours ?? 0
      );
      const serverTotalCompleted = Number(
        data.stats?.totalCompletedHours ?? data.Stats?.TotalCompletedHours ?? 0
      );
      const serverCompletionRate = Number(
        data.stats?.completionRate ?? data.Stats?.CompletionRate ?? 0
      );

      const stats = {
        currentStreak: Number(
          data.stats?.currentStreak ?? data.Stats?.CurrentStreak ?? 0
        ),
        longestStreak: Number(
          data.stats?.longestStreak ?? data.Stats?.LongestStreak ?? 0
        ),
        totalScheduledHours: serverTotalScheduled || derivedTotals.scheduled,
        totalCompletedHours: serverTotalCompleted || derivedTotals.completed,
        completionRate: serverCompletionRate,
        overallProgress: Number(
          data.stats?.overallProgress ?? data.Stats?.OverallProgress ?? 0
        ),
      };

      const courseProgress = (
        data.courseProgress ||
        data.CourseProgress ||
        []
      ).map((c) => ({
        id: c.id ?? c.Id,
        title: c.title ?? c.Title,
        progressPercentage: Number(
          c.progressPercentage ?? c.ProgressPercentage ?? 0
        ),
      }));

      const activityHeatmap =
        data.activityHeatmap || data.ActivityHeatmap || [];

      setDashboardData({
        stats,
        weeklyData: normalizedWeeklyData,
        courseProgress,
        activityHeatmap,
      });
    } catch (err) {
      setError("Failed to load progress data");
      console.error("Progress data error:", err);
    } finally {
      setLoading(false);
    }
  };

  const loadGeneticSchedule = async () => {
    try {
      setGaLoading(true);
      setGaError("");
      const raw = await progressApi.getGeneticSchedule({
        population: 48,
        generations: 60,
      });
      const cap = Number(
        raw.personalizedWeeklyCapacityHours ??
          raw.PersonalizedWeeklyCapacityHours ??
          0
      );
      const alloc = raw.allocations || raw.Allocations || [];
      const proj = raw.projections || raw.Projections || [];
      setGaSchedule({
        capacity: cap,
        fitness: Number(raw.bestFitness ?? raw.BestFitness ?? 0),
        generations: raw.generationsRun ?? raw.GenerationsRun ?? 0,
        population: raw.populationSize ?? raw.PopulationSize ?? 0,
        allocations: alloc.map((a) => ({
          courseId: a.courseId ?? a.CourseId,
          title: a.title ?? a.Title ?? "",
          fraction: Number(a.fraction ?? a.Fraction ?? 0),
          hoursPerWeek: Number(
            a.recommendedHoursPerWeek ?? a.RecommendedHoursPerWeek ?? 0
          ),
        })),
        projections: proj.map((p) => ({
          courseId: p.courseId ?? p.CourseId,
          title: p.title ?? p.Title ?? "",
          weeks: p.estimatedCompletionWeek ?? p.EstimatedCompletionWeek ?? 0,
          estDate:
            p.estimatedCompletionDateUtc ?? p.EstimatedCompletionDateUtc ?? null,
        })),
      });
    } catch (e) {
      console.error(e);
      const status = e?.status;
      const detail =
        e?.message ||
        (typeof e === "string" ? e : "Request failed");
      if (status === 404) {
        setGaError(
          "GA endpoint not found (404). Stop the API, run `dotnet run` from Learnit.Server again so the server picks up the latest code."
        );
      } else if (status === 401) {
        setGaError("Not signed in or session expired. Log in again.");
      } else {
        setGaError(detail);
      }
    } finally {
      setGaLoading(false);
    }
  };

  const getWeekRangeLabel = () => {
    const now = new Date();
    const anchor = new Date(now);
    anchor.setDate(anchor.getDate() + weekOffset * 7);

    const day = anchor.getDay(); // 0..6
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const weekStart = new Date(anchor);
    weekStart.setDate(anchor.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const fmt = (d) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(weekStart)} – ${fmt(weekEnd)}`;
  };

  const WeekNav = () => (
    <div className={styles.weekNav}>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => setWeekOffset((prev) => prev - 1)}
        disabled={loading}
      >
        ← Previous week
      </button>
      <span className={styles.weekLabel}>{getWeekRangeLabel()}</span>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => setWeekOffset((prev) => Math.min(0, prev + 1))}
        disabled={loading || weekOffset === 0}
      >
        Next week →
      </button>
    </div>
  );

  if (error || !dashboardData) {
    return (
      <section className={styles.page}>
        <div style={{ textAlign: "center", padding: "40px", color: "#c33" }}>
          {error || "Failed to load progress data"}
        </div>
      </section>
    );
  }

  const { stats, weeklyData, courseProgress, activityHeatmap } = dashboardData;

  const heatValues = Array.isArray(activityHeatmap)
    ? activityHeatmap.slice(-90)
    : [];

  const getHeatmapRangeLabel = () => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 89);
    const fmt = (d) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  };

  const weeklyScheduledTotal = weeklyData.reduce(
    (sum, d) => sum + d.scheduled,
    0
  );
  const weeklyCompletedTotal = weeklyData.reduce(
    (sum, d) => sum + d.completed,
    0
  );

  // Prefer server-computed stats for headline metrics to ensure consistency.
  const headlineScheduled =
    Number.isFinite(stats.totalScheduledHours) && stats.totalScheduledHours > 0
      ? stats.totalScheduledHours
      : weeklyScheduledTotal;
  const headlineCompleted =
    Number.isFinite(stats.totalCompletedHours) && stats.totalCompletedHours > 0
      ? stats.totalCompletedHours
      : weeklyCompletedTotal;
  const headlineCompletionRate =
    Number.isFinite(stats.completionRate) && stats.completionRate > 0
      ? Math.round(stats.completionRate)
      : headlineScheduled
      ? Math.round((headlineCompleted / headlineScheduled) * 100)
      : 0;

  const metricsData = [
    {
      icon: "🔥",
      label: "Current Streak",
      value: `${stats.currentStreak} days`,
    },
    {
      icon: "🏆",
      label: "Longest Streak",
      value: `${stats.longestStreak} days`,
    },
    {
      icon: "📅",
      label: "Week Target",
      value: `${Math.round(headlineScheduled * 10) / 10} hrs`,
    },
    {
      icon: "⏳",
      label: "Completed",
      value: `${Math.round(headlineCompleted * 10) / 10} hrs`,
    },
    {
      icon: "📊",
      label: "Completion Rate",
      value: `${headlineCompletionRate}%`,
    },
  ];

  if (loading && !dashboardData) {
    return (
      <section className={styles.page}>
        <Loading message="Loading progress data..." />
      </section>
    );
  }

  if (error && !dashboardData) {
    return (
      <section className={styles.page}>
        <ErrorMessage
          error={error}
          onRetry={loadProgressData}
          title="Failed to load progress data"
        />
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <ErrorMessage
        error={error}
        onRetry={loadProgressData}
        onDismiss={() => setError("")}
        title="Error loading data"
        variant="banner"
      />
      {/* Removed Progress Dashboard heading for compactness */}
      <div className={styles.dashboardGrid}>
        <div className={styles.leftCol}>
          <div className={styles.section}>
            <h2>Overall Progress</h2>
            <div className={styles.progressBarOuter}>
              <div
                className={styles.progressBarInner}
                style={{ width: `${stats.overallProgress}%` }}
              />
            </div>
            <p className={styles.progressLabel}>
              {stats.overallProgress}% Completed
            </p>
          </div>
          <div className={styles.metricsGrid}>
            {metricsData.map((metric) => (
              <div className={styles.metricCard} key={metric.label}>
                <span className={styles.metricIcon}>{metric.icon}</span>
                <div className={styles.metricText}>
                  <span className={styles.metricLabel}>{metric.label}</span>
                  <strong className={styles.metricValue}>{metric.value}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.rightCol}>
          <div className={styles.section}>
            <div className={styles.sectionHeaderRow}>
              <h2>Study Activity Heatmap</h2>
              <span className={styles.rangeLabel}>
                {getHeatmapRangeLabel()}
              </span>
            </div>
            {heatValues && heatValues.length > 0 ? (
              <>
                <div className={styles.heatmap}>
                  {heatValues.map((val, i) => {
                    const end = new Date();
                    const start = new Date(end);
                    start.setDate(end.getDate() - 89);
                    const date = new Date(start);
                    date.setDate(start.getDate() + i);
                    const dateStr = date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    });
                    const hours =
                      val === 0
                        ? "No activity"
                        : val === 1
                        ? "< 2 hours"
                        : val === 2
                        ? "2-4 hours"
                        : "4+ hours";

                    return (
                      <div
                        key={i}
                        className={`${styles.heatBox} ${
                          styles[`heatLevel${val}`]
                        }`}
                        title={`${dateStr}: ${hours}`}
                      />
                    );
                  })}
                </div>
                <div className={styles.heatmapLegend}>
                  <span className={styles.legendLabel}>Less</span>
                  <div className={styles.legendBoxes}>
                    <div
                      className={`${styles.legendBox} ${styles.heatLevel0}`}
                      title="No activity"
                    />
                    <div
                      className={`${styles.legendBox} ${styles.heatLevel1}`}
                      title="< 2 hours"
                    />
                    <div
                      className={`${styles.legendBox} ${styles.heatLevel2}`}
                      title="2-4 hours"
                    />
                    <div
                      className={`${styles.legendBox} ${styles.heatLevel3}`}
                      title="4+ hours"
                    />
                  </div>
                  <span className={styles.legendLabel}>More</span>
                </div>
              </>
            ) : (
              <div className={styles.noDataInline}>
                No activity data available yet. Start studying to see your
                activity heatmap!
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CHARTS */}
      <div className={styles.chartsRow}>
        <div className={styles.chartBox}>
          <h2 style={{ marginBottom: 4 }}>Weekly Trend</h2>
          <div style={{ marginBottom: 8 }}>
            <WeekNav />
          </div>
          {weeklyData && weeklyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={weeklyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" />
                <YAxis />
                <Tooltip
                  formatter={(value, name) => [`${value} hrs`, name]}
                  labelFormatter={(label) => `Day: ${label}`}
                />
                <Line
                  dataKey="scheduled"
                  stroke="var(--accent-dark)"
                  strokeWidth={2}
                  dot={{ fill: "var(--accent-dark)", r: 4 }}
                  name="Scheduled"
                />
                <Line
                  dataKey="completed"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  dot={{ fill: "var(--accent)", r: 4 }}
                  name="Completed"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles.noDataBlock}>
              No weekly data available yet
            </div>
          )}
        </div>
        <div className={styles.chartBox}>
          <h2 style={{ marginBottom: 4 }}>Scheduled vs Completed</h2>
          <div style={{ marginBottom: 8 }}>
            <WeekNav />
          </div>
          {weeklyData && weeklyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weeklyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" />
                <YAxis />
                <Tooltip
                  formatter={(value, name) => [`${value} hrs`, name]}
                  labelFormatter={(label) => `Day: ${label}`}
                />
                <Bar
                  dataKey="scheduled"
                  fill="var(--accent-dark)"
                  name="Scheduled"
                />
                <Bar
                  dataKey="completed"
                  fill="var(--accent)"
                  name="Completed"
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles.noDataBlock}>
              No weekly data available yet
            </div>
          )}
        </div>
      </div>

      {/* COURSE PROGRESS */}
      <div className={styles.section}>
        <h2>Course Progress</h2>
        <div className={styles.courseGrid}>
          {courseProgress && courseProgress.length > 0 ? (
            courseProgress.map((course) => (
              <div className={styles.courseCard} key={course.id}>
                <span className={styles.courseName}>{course.title}</span>
                <div className={styles.courseProgressBarOuter}>
                  <div
                    className={styles.courseProgressBarInner}
                    style={{ width: `${course.progressPercentage}%` }}
                  />
                </div>
                <span className={styles.coursePercent}>
                  {course.progressPercentage}%
                </span>
              </div>
            ))
          ) : (
            <p className={styles.noData}>No courses in progress</p>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <h2>GA study plan</h2>
        <p className={styles.gaMeta}>
          Evolves weekly hour splits across your active courses using deadlines,
          priorities, and your recent study-session history.
        </p>
        <div className={styles.gaActions}>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={loadGeneticSchedule}
            disabled={gaLoading}
          >
            {gaLoading ? "Running GA…" : "Compute optimized schedule"}
          </button>
          {gaError ? (
            <span style={{ color: "#c33", fontSize: "0.9rem" }}>{gaError}</span>
          ) : null}
        </div>
        {gaSchedule && gaSchedule.allocations.length > 0 ? (
          <>
            <p className={styles.gaMeta}>
              Model assumes ~{gaSchedule.capacity} hrs/week capacity (from your
              history, bounded 2–45). Fitness: {gaSchedule.fitness.toFixed(2)}{" "}
              ({gaSchedule.population}×{gaSchedule.generations} GA).
            </p>
            <div className={styles.gaTableWrap}>
              <table className={styles.gaTable}>
                <thead>
                  <tr>
                    <th>Course</th>
                    <th>Share</th>
                    <th>Hrs/week</th>
                    <th>~Weeks to finish</th>
                    <th>~Done by (UTC date)</th>
                  </tr>
                </thead>
                <tbody>
                  {gaSchedule.allocations.map((a) => {
                    const p = gaSchedule.projections.find(
                      (x) => x.courseId === a.courseId
                    );
                    const dateStr = p?.estDate
                      ? new Date(p.estDate).toLocaleDateString()
                      : "—";
                    return (
                      <tr key={a.courseId}>
                        <td>{a.title}</td>
                        <td>{(a.fraction * 100).toFixed(1)}%</td>
                        <td>{a.hoursPerWeek}</td>
                        <td>{p?.weeks ?? "—"}</td>
                        <td>{dateStr}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : gaSchedule && gaSchedule.allocations.length === 0 ? (
          <p className={styles.noData}>
            No active courses with hours remaining. Add or resume a course to
            get a schedule.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default Progress;
