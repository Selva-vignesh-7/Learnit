import { useState, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import Button from "../ui/Button";
import Field from "../ui/Field";
import Modal from "../ui/Modal";
import ui from "../ui/ui.module.css";
import ModuleForm from "./ModuleForm";
import { aiApi } from "../../services";
import styles from "./EditCourseModal.module.css";
import Toggle from "../ui/Toggle";

function EditCourseModal({ course, onSave, onCancel }) {
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    subjectArea: "",
    learningObjectives: "",
    difficulty: "",
    priority: "",
    totalEstimatedHours: "",
    targetCompletionDate: "",
    notes: "",
    reminderEmail: "",
    isQuizEnabled: true,
  });
  const [modules, setModules] = useState([]);
  const [externalLinks, setExternalLinks] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("manual");

  useEffect(() => {
    if (course) {
      setFormData({
        title: course.title,
        description: course.description,
        subjectArea: course.subjectArea,
        learningObjectives: course.learningObjectives,
        difficulty: course.difficulty,
        priority: course.priority,
        totalEstimatedHours: course.totalEstimatedHours.toString(),
        targetCompletionDate: course.targetCompletionDate?.split("T")[0] || "",
        notes: course.notes || "",
        reminderEmail: course.reminderEmail || "",
        isQuizEnabled:
          typeof course.isQuizEnabled === "boolean"
            ? course.isQuizEnabled
            : true,
      });
      setModules(
        (course.modules || []).map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description || "",
          duration: m.estimatedHours.toString(),
          notes: m.notes || "",
          isCompleted: m.isCompleted || false,
          subModules: (m.subModules || []).map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description || "",
            duration: (s.estimatedHours ?? "").toString(),
            notes: s.notes || "",
            isCompleted: s.isCompleted || false,
          })),
        }))
      );
      setExternalLinks(course.externalLinks || []);
    }
  }, [course]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    const validModules = modules.filter((m) => m.title.trim() && m.duration);
    if (validModules.length === 0) {
      setError("Please add at least one module");
      return;
    }

    const modulesPayload = validModules.map((m, idx) => ({
      tempId: idx + 1,
      title: m.title,
      description: m.description || "",
      estimatedHours: parseFloat(m.duration) || 0,
      notes: m.notes || "",
      isCompleted: m.isCompleted || false,
      subModules: (m.subModules || [])
        .filter((s) => s.title.trim() && s.duration)
        .map((s, subIdx) => ({
          title: s.title,
          description: s.description || "",
          estimatedHours: parseFloat(s.duration) || 0,
          notes: s.notes || "",
          isCompleted: s.isCompleted || false,
          order: subIdx,
        })),
    }));

    setSubmitting(true);
    try {
      // Prepare payload with proper null handling for optional fields
      const payload = {
        ...formData,
        totalEstimatedHours: parseInt(formData.totalEstimatedHours) || 0,
        // Convert empty string to null for nullable DateTime fields
        targetCompletionDate: formData.targetCompletionDate?.trim() || null,
        modules: modulesPayload,
        externalLinks,
      };

      await onSave(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setError("");
    try {
      const draft = await aiApi.createCourse(aiPrompt.trim());
      console.log("AI course draft (edit)", draft);
      setFormData((prev) => ({
        ...prev,
        title: draft.title || prev.title,
        description: draft.description || prev.description,
        difficulty: draft.difficulty || prev.difficulty,
        priority: draft.priority || prev.priority,
        learningObjectives:
          draft.learningObjectives ||
          prev.learningObjectives ||
          "AI generated plan",
        subjectArea: draft.subjectArea || prev.subjectArea || "AI suggested",
        totalEstimatedHours:
          draft.totalEstimatedHours?.toString() || prev.totalEstimatedHours,
        targetCompletionDate:
          draft.targetCompletionDate || prev.targetCompletionDate,
        notes: draft.notes || prev.notes || "AI refreshed course structure",
      }));

      const mapped = (draft.modules || []).map((m) => ({
        id: window.crypto?.randomUUID ? window.crypto.randomUUID() : uuidv4(),
        title: m.title,
        duration: (m.estimatedHours ?? "").toString(),
        subModules: (m.subModules || []).map((s) => ({
          id: window.crypto?.randomUUID ? window.crypto.randomUUID() : uuidv4(),
          title: s.title,
          duration: (s.estimatedHours ?? "").toString(),
        })),
      }));
      if (mapped.length) setModules(mapped);
      else
        setModules([
          {
            id: window.crypto?.randomUUID
              ? window.crypto.randomUUID()
              : uuidv4(),
            title: "Kickoff",
            duration: "2",
            subModules: [],
          },
        ]);
      setActiveTab("manual");
    } catch (err) {
      setError(err.message || "Failed to generate course");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <Modal
      kicker="Edit course"
      title="Update course details"
      onClose={onCancel}
    >
      <div className={ui.tabs}>
        <button
          type="button"
          className={`${ui.tab} ${activeTab === "manual" ? ui.active : ""}`}
          onClick={() => setActiveTab("manual")}
        >
          Manual
        </button>
        <button
          type="button"
          className={`${ui.tab} ${activeTab === "ai" ? ui.active : ""}`}
          onClick={() => setActiveTab("ai")}
        >
          Ask AI
        </button>
      </div>

      {activeTab === "ai" && (
        <div className={styles.aiPane}>
          <p>
            Describe how you want to update this course. We’ll draft a new
            structure.
          </p>
          <textarea
            rows={4}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="e.g., Expand with a capstone project and more hands-on React hooks practice"
          />
          <div className={ui.modalActions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleAiGenerate}
              disabled={aiLoading}
            >
              {aiLoading ? "Generating..." : "Generate with AI"}
            </Button>
          </div>
        </div>
      )}

      {activeTab === "manual" && (
        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={ui.formGrid}>
            <Field label="Title *">
              <input
                type="text"
                name="title"
                value={formData.title}
                onChange={handleChange}
                required
              />
            </Field>
            <Field label="Reminder email *">
              <input
                type="email"
                name="reminderEmail"
                value={formData.reminderEmail}
                onChange={handleChange}
                required
              />
            </Field>
            <Field label="Subject area">
              <input
                type="text"
                name="subjectArea"
                value={formData.subjectArea}
                onChange={handleChange}
              />
            </Field>
          </div>

          <Field label="Description">
            <textarea
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows={2}
            />
          </Field>

          <Field label="Learning objectives">
            <textarea
              name="learningObjectives"
              value={formData.learningObjectives}
              onChange={handleChange}
              rows={2}
            />
          </Field>

          <div className={ui.formGrid}>
            <Field label="Difficulty">
              <select
                name="difficulty"
                value={formData.difficulty}
                onChange={handleChange}
                required
              >
                <option value="">Select difficulty</option>
                <option value="Beginner">Beginner</option>
                <option value="Intermediate">Intermediate</option>
                <option value="Advanced">Advanced</option>
              </select>
            </Field>
            <Field label="Priority">
              <select
                name="priority"
                value={formData.priority}
                onChange={handleChange}
                required
              >
                <option value="">Select priority</option>
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
              </select>
            </Field>
          </div>

          <div className={ui.formGrid}>
            <Field label="Total hours *">
              <input
                type="number"
                name="totalEstimatedHours"
                value={formData.totalEstimatedHours}
                onChange={handleChange}
                min="1"
                required
              />
            </Field>
            <Field label="Target completion">
              <input
                type="date"
                name="targetCompletionDate"
                value={formData.targetCompletionDate}
                onChange={handleChange}
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              rows={3}
            />
          </Field>

          <Field label="Quizzes">
            <Toggle
              checked={!!formData.isQuizEnabled}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  isQuizEnabled: e.target.checked,
                }))
              }
              label="Enable quizzes for this course"
              name="isQuizEnabled"
            />
          </Field>

          <ModuleForm modules={modules} setModules={setModules} />

          {error && <div className={ui.errorBanner}>{error}</div>}

          <div className={ui.modalActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Updating..." : "Update course"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default EditCourseModal;
