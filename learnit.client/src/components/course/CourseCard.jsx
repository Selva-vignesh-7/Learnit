import { FaTrash } from "react-icons/fa";
import styles from "./CourseCard.module.css";

function CourseCard({ course, onNavigate, onEdit, onDelete }) {
  const handleCardClick = (e) => {
    e.stopPropagation();
    onNavigate(course.id);
  };
  const {
    id,
    title,
    description,
    hoursRemaining,
    totalEstimatedHours,
    progressPercentage,
    completedModules,
    totalModules,
    completedHours,
    priority,
    difficulty,
    reminderEmail,
    lastReminderSentAt,
  } = course;

  const safeTotalHours = totalEstimatedHours ?? 0;
  const safeHoursRemaining =
    hoursRemaining ?? Math.max(0, safeTotalHours - (completedHours ?? 0));

  const derivedFromHours =
    safeTotalHours > 0
      ? ((safeTotalHours - safeHoursRemaining) / safeTotalHours) * 100
      : 0;

  const hasServerProgress =
    progressPercentage !== null && progressPercentage !== undefined;

  const progress = hasServerProgress
    ? progressPercentage === 0 && derivedFromHours > 0
      ? derivedFromHours
      : progressPercentage
    : derivedFromHours;

  const moduleLabel =
    totalModules !== undefined
      ? `${completedModules ?? 0}/${totalModules} modules`
      : `${Math.round(progress)}%`;

  const hoursDone =
    completedHours ?? Math.max(0, safeTotalHours - safeHoursRemaining);

  const handleDelete = (e) => {
    e.stopPropagation();
    if (confirm("Delete this course?")) {
      onDelete(id);
    }
  };

  const lastReminderText = lastReminderSentAt
    ? new Date(lastReminderSentAt).toLocaleString()
    : "Not sent yet";

  return (
    <div
      className={styles.card}
      onClick={handleCardClick}
      tabIndex={0}
      role="button"
    >
      <div className={styles.content}>
        <div className={styles.metaRow}>
          {priority && (
            <span
              className={`${styles.pill} ${
                styles[`pill_${priority.toLowerCase()}`]
              }`}
            >
              {priority}
            </span>
          )}
          {difficulty && (
            <span
              className={`${styles.pill} ${
                styles[`pill_${difficulty.toLowerCase()}`]
              }`}
            >
              {difficulty}
            </span>
          )}
        </div>
        <div className={styles.headerRow}>
          <h3 className={styles.title}>{title}</h3>
          <button
            className={styles.deleteBtn}
            onClick={handleDelete}
            title="Delete course"
            aria-label="Delete course"
          >
            <FaTrash size={13} />
          </button>
        </div>
        <p className={styles.description}>{description || "No description"}</p>
        <p className={styles.reminderInfo}>
          Reminder: {reminderEmail || "Not set"} · Last sent: {lastReminderText}
        </p>
        <div className={styles.progress}>
          <div className={styles.bar}>
            <div className={styles.fill} style={{ width: `${progress}%` }} />
          </div>
          <div className={styles.text}>
            <span className={styles.percent}>{Math.round(progress)}%</span>
            <span className={styles.remaining}>{moduleLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CourseCard;
