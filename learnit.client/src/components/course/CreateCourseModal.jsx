import { useState, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import Button from "../ui/Button";
import Field from "../ui/Field";
import Modal from "../ui/Modal";
import { InlineError, InlineLoading } from "../ui";
import ui from "../ui/ui.module.css";
import ModuleForm from "./ModuleForm";
import { aiApi } from "../../services";
import styles from "./CreateCourseModal.module.css";
import Toggle from "../ui/Toggle";

const toHoursString = (value, fallback = "1") => {
  const num = Number.parseFloat(value);
  if (Number.isFinite(num) && num > 0) return Math.round(num).toString();
  return fallback;
};

const normalizeLearningObjectives = (val) => {
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof val === "string") return val.trim();
  return "";
};

const fallbackDate = () =>
  new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);

const cleanText = (val = "") => {
  if (!val) return "";
  return (
    val
      // strip any prompt-like boilerplate the model might echo
      .replace(/Topic:\s*/gi, "")
      .replace(/SourceUrl:\s*/gi, "")
      .replace(/Source:\s*/gi, "")
      .replace(/URL:\s*/gi, "")
      .replace(/Hint:\s*/gi, "")
      .replace(/Task:\s*/gi, "")
      // drop full lines that start with Source/URL/Hint/Task/Target/Video/Content
      .replace(/^(Source|URL|Hint|Task|Target|Video|Content):.*$/gim, "")
      // Remove prompt patterns that appear in the text
      .replace(/Target level:\s*[^\n]+\n?/gi, "")
      .replace(/Source title:\s*/gi, "")
      .replace(/Source description:\s*/gi, "")
      .replace(/Source author:\s*[^\n]+\n?/gi, "")
      .replace(/Video duration:\s*[^\n]+\n?/gi, "")
      .replace(/Source sections:\s*/gi, "")
      .replace(/Content chapters:\s*/gi, "")
      .replace(/Estimated reading time:\s*[^\n]+\n?/gi, "")
      .replace(/Instruction:\s*/gi, "")
      .replace(/Analyze the URL[^.]*\./gi, "")
      .replace(/Respond ONLY compact JSON[^.]*\./gi, "")
      // Remove pipe-separated lists that look like prompt data
      .replace(/\|\s*Section \d+[^|]*\|/gi, "")
      .replace(/Section \d+[^|]*\|/gi, "")
      // drop raw URLs
      .replace(/https?:\/\/\S+/gi, "")
      // Remove leading/trailing prompt-like text
      .replace(/^[^:]+:\s*/gm, "")
      // collapse leftover punctuation/semicolons
      .replace(/[;|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
};

function CreateCourseModal({ onSave, onCancel }) {
  // Reset function to clear all state
  const resetState = () => {
    setFormData({
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
      sourceUrl: "",
      isQuizEnabled: true,
    });
    setModules([
      {
        id: window.crypto?.randomUUID ? window.crypto.randomUUID() : uuidv4(),
        title: "",
        duration: "",
        subModules: [],
      },
    ]);
    setError("");
    setSubmitting(false);
    setAiPrompt("");
    setAiLoading(false);
    setAiProgress("");
    setActiveTab("manual");
    setUrlAnalysis(null);
  };

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
    sourceUrl: "",
    isQuizEnabled: true,
  });
  const [modules, setModules] = useState([
    {
      id: window.crypto?.randomUUID ? window.crypto.randomUUID() : uuidv4(),
      title: "",
      duration: "",
      subModules: [],
    },
  ]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProgress, setAiProgress] = useState(""); // Progress message for AI generation
  const [activeTab, setActiveTab] = useState("manual");
  const [urlAnalysis, setUrlAnalysis] = useState(null); // Store URL analysis results

  // Reset state when modal is opened (component mounts) and when it closes
  useEffect(() => {
    // Reset state when component mounts
    resetState();
    // Cleanup: reset state when component unmounts (modal closes)
    return () => {
      resetState();
    };
  }, []); // Empty dependency array means this runs once on mount

  // Also reset state when formData.sourceUrl changes (new URL entered)
  useEffect(() => {
    // If sourceUrl is cleared, reset related state
    if (!formData.sourceUrl && urlAnalysis) {
      setUrlAnalysis(null);
      setAiProgress("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.sourceUrl, urlAnalysis]);

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

    const sourceUrl = formData.sourceUrl?.trim();
    // Detect external course (has URL and not YouTube)
    const isExternalCourse =
      sourceUrl &&
      sourceUrl.length > 5 &&
      !sourceUrl.includes("youtube.com") &&
      !sourceUrl.includes("youtu.be");

    // For external courses, require all fields to be filled
    if (isExternalCourse) {
      // Validate course details
      if (!formData.title?.trim()) {
        setError("Course title is required for external courses");
        return;
      }
      if (!formData.description?.trim()) {
        setError("Course description is required for external courses");
        return;
      }
      if (!formData.subjectArea?.trim()) {
        setError("Subject area is required for external courses");
        return;
      }
      if (!formData.learningObjectives?.trim()) {
        setError("Learning objectives are required for external courses");
        return;
      }
      if (!formData.difficulty?.trim()) {
        setError("Difficulty level is required for external courses");
        return;
      }
      if (!formData.priority?.trim()) {
        setError("Priority is required for external courses");
        return;
      }
      if (
        !formData.totalEstimatedHours?.trim() ||
        parseFloat(formData.totalEstimatedHours) <= 0
      ) {
        setError("Total estimated hours is required for external courses");
        return;
      }
    }

    const validModules = modules.filter((m) => m.title.trim() && m.duration);
    if (validModules.length === 0) {
      setError("Please add at least one module");
      return;
    }

    // For external courses, validate all modules have complete details
    if (isExternalCourse) {
      for (let i = 0; i < validModules.length; i++) {
        const module = validModules[i];
        if (!module.title?.trim()) {
          setError(`Module ${i + 1} must have a title`);
          return;
        }
        if (!module.duration || parseFloat(module.duration) <= 0) {
          setError(`Module ${i + 1} must have a valid duration (hours)`);
          return;
        }
        // Validate submodules if they exist
        if (module.subModules && module.subModules.length > 0) {
          for (let j = 0; j < module.subModules.length; j++) {
            const subModule = module.subModules[j];
            if (!subModule.title?.trim()) {
              setError(`Module ${i + 1}, Submodule ${j + 1} must have a title`);
              return;
            }
            if (!subModule.duration || parseFloat(subModule.duration) <= 0) {
              setError(
                `Module ${i + 1}, Submodule ${
                  j + 1
                } must have a valid duration (hours)`
              );
              return;
            }
          }
        }
      }
    }

    const toHours = (value) => {
      const num = parseFloat(value);
      return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
    };

    const modulesPayload = validModules.map((m, idx) => ({
      tempId: idx + 1,
      title: m.title,
      estimatedHours: toHours(m.duration),
      notes: m.notes || "", // CRITICAL: Preserve Notes field (contains video timing data for YouTube videos)
      subModules: (m.subModules || [])
        .filter((s) => s.title.trim() && s.duration)
        .map((s, subIdx) => ({
          title: s.title,
          estimatedHours: toHours(s.duration),
          description: "",
          notes: "",
          order: subIdx,
        })),
    }));

    setSubmitting(true);
    try {
      // sourceUrl and isExternalCourse already defined above for validation
      const platformFromUrl = (url) => {
        if (!url) return "Website";
        if (url.includes("youtube.com") || url.includes("youtu.be"))
          return "YouTube";
        if (url.includes("udemy.com")) return "Udemy";
        if (url.includes("coursera.org")) return "Coursera";
        if (url.includes("khanacademy.org")) return "Khan Academy";
        if (url.includes("edx.org")) return "edX";
        if (url.includes("pluralsight.com")) return "Pluralsight";
        if (url.includes("linkedin.com/learning")) return "LinkedIn Learning";
        if (url.includes("codecademy.com")) return "Codecademy";
        if (url.includes("freecodecamp.org")) return "FreeCodeCamp";
        if (url.match(/\.(mp4|webm|mov|m4v)$/i)) return "Video";
        return "Website";
      };

      const externalLinks =
        sourceUrl && sourceUrl.length > 5
          ? [
              {
                platform: platformFromUrl(sourceUrl),
                title: "Source",
                url: sourceUrl,
              },
            ]
          : [];

      // Log for debugging
      if (isExternalCourse) {
        console.log("[Course Creation] External course detected:", {
          url: sourceUrl,
          platform: platformFromUrl(sourceUrl),
          externalLinksCount: externalLinks.length,
        });
      }

      // Prepare payload with proper null handling for optional fields
      const payload = {
        ...formData,
        totalEstimatedHours: parseInt(formData.totalEstimatedHours) || 0,
        // Convert empty string to null for nullable DateTime fields
        targetCompletionDate: formData.targetCompletionDate?.trim() || null,
        modules: modulesPayload,
        externalLinks,
        isQuizEnabled: formData.isQuizEnabled,
      };

      await onSave(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim() && !formData.sourceUrl?.trim()) {
      setError("Please provide a learning goal or description.");
      return;
    }
    setAiLoading(true);
    setError("");
    setUrlAnalysis(null);
    try {
      const source = formData.sourceUrl?.trim();
      const topic = aiPrompt.trim();

      // If URL is provided, show that we're analyzing it
      if (source) {
        console.log(`[Frontend] Analyzing URL: ${source}`);
      }

      // Build comprehensive prompt with all user inputs
      let enhancedPrompt = topic;
      if (formData.learningObjectives?.trim()) {
        enhancedPrompt += `\n\nLearning goals: ${formData.learningObjectives.trim()}`;
      }
      if (formData.subjectArea?.trim()) {
        enhancedPrompt += `\n\nSubject area: ${formData.subjectArea}`;
      }
      if (formData.totalEstimatedHours) {
        const weeks = Math.ceil(parseFloat(formData.totalEstimatedHours) / 10);
        if (weeks > 0) {
          enhancedPrompt += `\n\nDuration: ${weeks} weeks`;
        }
      }

      // Keep the user prompt comprehensive; rely on backend system prompt for JSON schema.
      const payload =
        source || topic
          ? {
              url: source || null,
              hint: enhancedPrompt || "",
              level: formData.difficulty || "",
              title: formData.title?.trim() || null,
              description: formData.description?.trim() || null,
            }
          : {
              prompt: enhancedPrompt || "General course",
              title: formData.title?.trim() || null,
              description: formData.description?.trim() || null,
            };

      // Check if URL is YouTube to show appropriate progress message
      const isYouTube =
        source &&
        (source.includes("youtube.com") || source.includes("youtu.be"));

      if (isYouTube) {
        setAiProgress(
          "Extracting YouTube video metadata and creating course structure..."
        );
      } else {
        setAiProgress("Creating course structure with AI...");
      }

      const draft = await aiApi.createCourse(payload);
      console.log(
        isYouTube
          ? "[YouTube create-course draft]"
          : "[AI create-course draft]",
        draft
      );

      if (!draft || !draft.title) {
        throw new Error(
          "AI didn't generate a valid course structure. Please try again with more details."
        );
      }

      setAiProgress("Processing course data...");

      // Detect if this is a YouTube video or playlist - YouTube content should have no submodules
      const isYouTubeContent =
        source &&
        (source.includes("youtube.com") || source.includes("youtu.be"));

      // Store URL analysis info if we have a URL
      if (source && draft) {
        setUrlAnalysis({
          url: source,
          title: draft.title,
          hasModules: draft.modules && draft.modules.length > 0,
          moduleCount: draft.modules?.length || 0,
          totalHours: draft.totalEstimatedHours || 0,
        });
      }

      const clampOption = (val, options, fallback) => {
        if (!val) return fallback;
        const found = options.find(
          (opt) => opt.toLowerCase() === val.toLowerCase()
        );
        return found || fallback;
      };

      const normalizeSubject = (val) => {
        const subjects = [
          "Programming",
          "Data Science",
          "Web Development",
          "Design",
          "Business",
          "Science",
          "Mathematics",
          "Language",
          "Other",
        ];
        if (!val) return "Other";
        const exact = subjects.find(
          (s) => s.toLowerCase() === val.toLowerCase()
        );
        return exact || "Other";
      };

      const difficulty = clampOption(
        draft.difficulty,
        ["Beginner", "Intermediate", "Advanced"],
        "Intermediate"
      );

      const priority = clampOption(
        draft.priority,
        ["High", "Medium", "Low"],
        "Medium"
      );

      const subjectArea = normalizeSubject(draft.subjectArea);

      const modulesFallback = () => {
        const subject = subjectArea === "Other" ? "Course" : subjectArea;
        return ["Foundations", "Applied Practice", "Project"]
          .map((title) => ({
            id: window.crypto?.randomUUID
              ? window.crypto.randomUUID()
              : uuidv4(),
            title: `${subject} ${title}`,
            duration: "3",
            subModules: [
              {
                id: window.crypto?.randomUUID
                  ? window.crypto.randomUUID()
                  : uuidv4(),
                title: "Lesson 1",
                duration: "1",
              },
              {
                id: window.crypto?.randomUUID
                  ? window.crypto.randomUUID()
                  : uuidv4(),
                title: "Lesson 2",
                duration: "1",
              },
            ],
          }))
          .map((m, idx) => ({ ...m, order: idx }));
      };

      const learningObjectives = normalizeLearningObjectives(
        cleanText(draft.learningObjectives)
      );

      console.log("[Frontend] Draft modules received:", draft.modules);

      const safeModules = (draft.modules || []).map((m, idx) => {
        // Handle both camelCase and PascalCase property names
        const hours = Number.parseFloat(
          (m.estimatedHours ?? m.EstimatedHours) || 0
        );
        const duration = Number.isFinite(hours) && hours > 0 ? hours : 2;

        // CRITICAL: Preserve Notes field (contains video timing data for YouTube videos)
        const notes = m.notes || m.Notes || "";

        const subModulesList = m.subModules || m.SubModules || [];
        const subModules = subModulesList.map((s, subIdx) => {
          const sh = Number.parseFloat(
            s.estimatedHours || s.EstimatedHours || 0
          );
          const subDuration = Number.isFinite(sh) && sh > 0 ? sh : 1;
          return {
            id: window.crypto?.randomUUID
              ? window.crypto.randomUUID()
              : uuidv4(),
            title:
              cleanText(s.title || s.Title)?.trim() || `Lesson ${subIdx + 1}`,
            duration: toHoursString(subDuration, "1"),
          };
        });

        const moduleTitle =
          cleanText(m.title || m.Title)?.trim() || `Module ${idx + 1}`;
        console.log(
          `[Frontend] Processing module ${idx + 1}: "${moduleTitle}" with ${
            subModules.length
          } submodules${
            notes ? ` (has Notes: ${notes.substring(0, 50)}...)` : " (no Notes)"
          }`
        );

        // Check if this is a YouTube playlist or video by checking Notes field
        // Notes field contains video metadata for YouTube content
        let isYouTubeModule = isYouTubeContent; // Start with URL-based detection
        try {
          if (notes) {
            const metadata = JSON.parse(notes);
            // Check if Notes contains playlistId or videoId (indicates YouTube content)
            if (metadata.playlistId || metadata.videoId) {
              isYouTubeModule = true;
            }
          }
        } catch {
          // If Notes parsing fails, use URL-based detection
        }

        // For YouTube playlists/videos: NO submodules (requirement: module-level granularity only)
        // For other sources: add default submodules if none exist
        const finalSubModules = isYouTubeModule
          ? [] // YouTube: NO submodules (empty array)
          : subModules.length
          ? subModules
          : [
              {
                id: window.crypto?.randomUUID
                  ? window.crypto.randomUUID()
                  : uuidv4(),
                title: "Lesson 1",
                duration: "1",
              },
              {
                id: window.crypto?.randomUUID
                  ? window.crypto.randomUUID()
                  : uuidv4(),
                title: "Lesson 2",
                duration: "1",
              },
            ];

        return {
          id: window.crypto?.randomUUID ? window.crypto.randomUUID() : uuidv4(),
          title: moduleTitle,
          duration: toHoursString(duration, "2"),
          notes: notes, // CRITICAL: Preserve Notes field for video timing alignment
          subModules: finalSubModules,
        };
      });

      console.log(
        "[Frontend] Processed modules:",
        safeModules.length,
        safeModules
      );

      let usableModules = safeModules;
      if (safeModules.length < 3) {
        const fillers = modulesFallback().slice(0, 3 - safeModules.length);
        usableModules = [...safeModules, ...fillers];
      }

      const moduleDurationTotal = usableModules.reduce((sum, m) => {
        const hours = Number.parseFloat(m.duration);
        return Number.isFinite(hours) && hours > 0 ? sum + hours : sum;
      }, 0);
      const totalHours = Number.parseInt(draft.totalEstimatedHours, 10);

      const targetDate = draft.targetCompletionDate
        ? draft.targetCompletionDate.slice(0, 10)
        : fallbackDate();

      // Detect if this is an external course (non-YouTube)
      const sourceUrl = formData.sourceUrl?.trim();
      const isExternalCourse =
        sourceUrl &&
        sourceUrl.length > 5 &&
        !sourceUrl.includes("youtube.com") &&
        !sourceUrl.includes("youtu.be");

      setFormData((prev) => ({
        ...prev,
        title: cleanText(draft.title)?.trim() || prev.title,
        description: cleanText(draft.description)?.trim() || prev.description,
        difficulty,
        priority,
        learningObjectives:
          learningObjectives || prev.learningObjectives || "Learning goals",
        subjectArea,
        totalEstimatedHours:
          Number.isFinite(totalHours) && totalHours > 0
            ? totalHours.toString()
            : moduleDurationTotal > 0
            ? Math.round(moduleDurationTotal).toString()
            : prev.totalEstimatedHours || "",
        targetCompletionDate: targetDate,
        notes: cleanText(draft.notes)?.trim() || prev.notes,
        sourceUrl: prev.sourceUrl || sourceUrl, // Preserve source URL
      }));
      setModules(usableModules);

      // Show info message for external courses
      if (isExternalCourse) {
        console.log(
          "[Course Creation] External course detected - Quiz system will be enabled"
        );
      }

      // Switch to manual tab to show the generated course
      setActiveTab("manual");

      // Scroll to top of modal to show the generated content
      setTimeout(() => {
        const modal = document.querySelector('[role="dialog"]');
        if (modal) {
          modal.scrollTop = 0;
        }
      }, 100);
    } catch (err) {
      console.error("[AI Course Creation] Error:", err);
      const errorMessage =
        err.response?.data?.message ||
        err.message ||
        "Failed to generate course. Please check your input and try again.";
      setError(errorMessage);
      setAiProgress("");
    } finally {
      setAiLoading(false);
      setAiProgress("");
    }
  };

  return (
    <Modal
      kicker="Create course"
      title="Add a new course"
      onClose={() => {
        resetState();
        onCancel();
      }}
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
        <button
          type="button"
          className={`${ui.tab} ${activeTab === "source" ? ui.active : ""}`}
          onClick={() => setActiveTab("source")}
        >
          From URL
        </button>
      </div>

      {activeTab === "ai" && (
        <div className={styles.aiPane}>
          <div style={{ marginBottom: "1rem" }}>
            <p
              style={{
                color: "#666",
                fontSize: "0.9rem",
                marginBottom: "0.5rem",
              }}
            >
              Tell AI what you want to learn, and we'll create a comprehensive
              course structure with modules, submodules, and learning
              objectives.
            </p>
            <div
              style={{
                padding: "0.75rem",
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: "6px",
                fontSize: "0.85rem",
                color: "#0369a1",
              }}
            >
              <strong>💡 Tips:</strong> Be specific about your learning goals,
              duration, and difficulty level for better results.
            </div>
          </div>

          <Field label="What do you want to learn? *">
            <textarea
              rows={3}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="e.g., A comprehensive 4-week React course covering hooks, routing, state management, and building a full-stack application with Node.js backend"
              style={{ fontFamily: "inherit" }}
            />
            <div
              style={{
                marginTop: "0.5rem",
                fontSize: "0.85rem",
                color: "#666",
              }}
            >
              <strong>Example prompts:</strong>
              <ul style={{ margin: "0.25rem 0 0 1.25rem", padding: 0 }}>
                <li>
                  "Master ASP.NET Core MVC in 6 weeks - from basics to building
                  REST APIs"
                </li>
                <li>
                  "Learn Docker and Kubernetes for DevOps - hands-on
                  containerization course"
                </li>
                <li>
                  "Python data science course: pandas, numpy, matplotlib, and
                  machine learning basics"
                </li>
              </ul>
            </div>
          </Field>

          <div className={ui.formGrid}>
            <Field label="Subject area (optional)">
              <select
                value={formData.subjectArea}
                onChange={(e) => {
                  setFormData((prev) => ({
                    ...prev,
                    subjectArea: e.target.value,
                  }));
                }}
                style={{ padding: "0.5rem" }}
              >
                <option value="">Let AI decide</option>
                <option>Programming</option>
                <option>Data Science</option>
                <option>Web Development</option>
                <option>Design</option>
                <option>Business</option>
                <option>Science</option>
                <option>Mathematics</option>
                <option>Language</option>
                <option>Other</option>
              </select>
            </Field>
            <Field label="Difficulty level (optional)">
              <select
                value={formData.difficulty}
                onChange={(e) => {
                  setFormData((prev) => ({
                    ...prev,
                    difficulty: e.target.value,
                  }));
                }}
                style={{ padding: "0.5rem" }}
              >
                <option value="">Let AI decide</option>
                <option>Beginner</option>
                <option>Intermediate</option>
                <option>Advanced</option>
              </select>
            </Field>
          </div>

          <div className={ui.formGrid}>
            <Field label="Estimated duration (optional)">
              <input
                type="number"
                min="1"
                placeholder="e.g., 4 (weeks)"
                value={
                  formData.totalEstimatedHours
                    ? Math.ceil(parseFloat(formData.totalEstimatedHours) / 10)
                    : ""
                }
                onChange={(e) => {
                  const weeks = parseInt(e.target.value) || 0;
                  if (weeks > 0) {
                    setFormData((prev) => ({
                      ...prev,
                      totalEstimatedHours: (weeks * 10).toString(),
                    }));
                  } else {
                    setFormData((prev) => ({
                      ...prev,
                      totalEstimatedHours: "",
                    }));
                  }
                }}
                style={{ padding: "0.5rem" }}
              />
              <small
                style={{
                  color: "#666",
                  fontSize: "0.85rem",
                  display: "block",
                  marginTop: "0.25rem",
                }}
              >
                Approximate weeks (AI will estimate hours based on this)
              </small>
            </Field>
            <Field label="Priority (optional)">
              <select
                value={formData.priority}
                onChange={(e) => {
                  setFormData((prev) => ({
                    ...prev,
                    priority: e.target.value,
                  }));
                }}
                style={{ padding: "0.5rem" }}
              >
                <option value="">Let AI decide</option>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </Field>
          </div>

          <Field label="Learning goals (optional)">
            <textarea
              rows={2}
              value={formData.learningObjectives}
              onChange={(e) => {
                setFormData((prev) => ({
                  ...prev,
                  learningObjectives: e.target.value,
                }));
              }}
              placeholder="e.g., Build full-stack applications, Understand REST API design, Deploy to production"
              style={{ fontFamily: "inherit" }}
            />
            <small
              style={{
                color: "#666",
                fontSize: "0.85rem",
                display: "block",
                marginTop: "0.25rem",
              }}
            >
              Specific outcomes you want to achieve (one per line or separated
              by commas)
            </small>
          </Field>

          <div className={ui.modalActions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleAiGenerate}
              disabled={aiLoading || !aiPrompt.trim()}
              style={{ minWidth: "200px" }}
            >
              {aiLoading ? (
                <>
                  <InlineLoading /> Generating Course...
                </>
              ) : (
                "✨ Generate Course with AI"
              )}
            </Button>
          </div>

          {aiProgress && (
            <div
              style={{
                marginTop: "8px",
                padding: "0.75rem",
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: "6px",
                fontSize: "0.9em",
                color: "#0369a1",
              }}
            >
              <strong>⏳ {aiProgress}</strong>
            </div>
          )}

          {error && <div className={ui.errorBanner}>{error}</div>}
        </div>
      )}

      {activeTab === "source" && (
        <div className={styles.aiPane}>
          <div style={{ marginBottom: "1rem" }}>
            <p
              style={{
                color: "#666",
                fontSize: "0.9rem",
                marginBottom: "0.5rem",
              }}
            >
              Enter a URL from YouTube, educational websites, or course pages.
              We'll analyze the content and generate a structured course.
            </p>
            <div
              style={{
                padding: "0.5rem",
                background: "#fef3c7",
                border: "1px solid #fcd34d",
                borderRadius: "4px",
                fontSize: "0.85rem",
                color: "#92400e",
              }}
            >
              <strong>Supported:</strong> YouTube videos/playlists, Medium
              articles, Dev.to posts, GitHub repos, documentation sites
            </div>
          </div>

          <Field label="Course Source URL *">
            <input
              type="url"
              name="sourceUrl"
              placeholder="https://youtube.com/watch?v=... or https://example.com/course"
              value={formData.sourceUrl}
              onChange={(e) => {
                handleChange(e);
                setUrlAnalysis(null); // Clear previous analysis when URL changes
                setError(""); // Clear errors when URL changes
              }}
              required
              style={{
                fontFamily: "monospace",
                fontSize: "0.9rem",
                padding: "0.5rem",
              }}
            />
            {formData.sourceUrl && (
              <div
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.85rem",
                  color: "#666",
                }}
              >
                {formData.sourceUrl.includes("youtube.com") ||
                formData.sourceUrl.includes("youtu.be") ? (
                  <span>
                    📹 YouTube video detected - Will extract title, duration,
                    and chapters
                  </span>
                ) : formData.sourceUrl.includes("medium.com") ||
                  formData.sourceUrl.includes("towardsdatascience.com") ||
                  formData.sourceUrl.includes("freecodecamp.org") ? (
                  <span>
                    📝 Medium article detected - Will extract title, reading
                    time, and sections
                  </span>
                ) : formData.sourceUrl.includes("dev.to") ? (
                  <span>
                    📝 Dev.to article detected - Will extract title and reading
                    time
                  </span>
                ) : formData.sourceUrl.includes("github.com") ? (
                  <span>
                    💻 GitHub repository detected - Will parse README and
                    structure
                  </span>
                ) : formData.sourceUrl.includes("docs.") ||
                  formData.sourceUrl.includes("documentation") ? (
                  <span>
                    📚 Documentation site detected - Will extract table of
                    contents
                  </span>
                ) : (
                  <span>
                    🌐 External course detected - Quiz system will be enabled
                    for module completion
                  </span>
                )}
                {formData.sourceUrl &&
                  !formData.sourceUrl.includes("youtube.com") &&
                  !formData.sourceUrl.includes("youtu.be") && (
                    <div
                      style={{
                        marginTop: "0.5rem",
                        padding: "0.5rem",
                        background: "#e0f2fe",
                        border: "1px solid #7dd3fc",
                        borderRadius: "4px",
                        fontSize: "0.85rem",
                        color: "#0369a1",
                      }}
                    >
                      <strong>ℹ️ Quiz Required:</strong> Modules in this course
                      will require passing a quiz before marking as complete.
                    </div>
                  )}
              </div>
            )}
          </Field>

          <Field label="Topic or goal (optional)">
            <textarea
              rows={2}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="e.g., ASP.NET Core MVC crash course (helps refine the course structure)"
            />
            <small
              style={{
                color: "#666",
                fontSize: "0.85rem",
                display: "block",
                marginTop: "0.25rem",
              }}
            >
              Optional: Add context about what you want to learn from this URL
            </small>
          </Field>

          {urlAnalysis && (
            <div
              style={{
                padding: "0.75rem",
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: "4px",
                marginBottom: "1rem",
              }}
            >
              <div
                style={{
                  fontWeight: "600",
                  marginBottom: "0.5rem",
                  color: "#0369a1",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <span>✓</span>
                <span>Analysis Complete - Course Generated!</span>
              </div>
              <div
                style={{
                  fontSize: "0.9rem",
                  color: "#075985",
                  marginBottom: "0.5rem",
                }}
              >
                <div>
                  <strong>Title:</strong> {urlAnalysis.title || "Course"}
                </div>
                {urlAnalysis.moduleCount > 0 && (
                  <div style={{ marginTop: "0.25rem" }}>
                    <strong>Structure:</strong> {urlAnalysis.moduleCount}{" "}
                    modules • ~{urlAnalysis.totalHours} hours estimated
                  </div>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "#0284c7",
                  fontStyle: "italic",
                }}
              >
                Review and adjust the course details in the "Manual" tab, then
                save.
              </div>
            </div>
          )}

          <div className={ui.modalActions}>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                if (!formData.sourceUrl?.trim()) {
                  setError("Please provide a source URL");
                  return;
                }
                handleAiGenerate();
              }}
              disabled={aiLoading}
            >
              {aiLoading ? (
                <>
                  <span
                    style={{ display: "inline-block", marginRight: "0.5rem" }}
                  >
                    ⏳
                  </span>
                  Analyzing URL & Generating Course...
                </>
              ) : (
                "Analyze URL & Generate Course"
              )}
            </Button>
          </div>
          {error && <div className={ui.errorBanner}>{error}</div>}
        </div>
      )}

      {activeTab === "manual" && (
        <form onSubmit={handleSubmit} className={styles.form}>
          {(() => {
            const sourceUrl = formData.sourceUrl?.trim();
            const isExternalCourse =
              sourceUrl &&
              sourceUrl.length > 5 &&
              !sourceUrl.includes("youtube.com") &&
              !sourceUrl.includes("youtu.be");

            return isExternalCourse ? (
              <div
                style={{
                  marginBottom: "1rem",
                  padding: "0.75rem",
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  borderRadius: "4px",
                  fontSize: "0.9rem",
                  color: "#92400e",
                }}
              >
                <strong>⚠️ External Course Requirements:</strong> All course
                details and module information must be completed before saving.
              </div>
            ) : null;
          })()}
          <div className={ui.formGrid}>
            <Field label="Course title *">
              <input
                type="text"
                name="title"
                placeholder="e.g. Machine Learning Foundations"
                value={formData.title}
                onChange={handleChange}
                required
              />
            </Field>
            <Field label="Reminder email *">
              <input
                type="email"
                name="reminderEmail"
                placeholder="you@example.com"
                value={formData.reminderEmail}
                onChange={handleChange}
                required
              />
            </Field>
            <Field
              label={(() => {
                const sourceUrl = formData.sourceUrl?.trim();
                const isExternalCourse =
                  sourceUrl &&
                  sourceUrl.length > 5 &&
                  !sourceUrl.includes("youtube.com") &&
                  !sourceUrl.includes("youtu.be");
                return isExternalCourse ? "Subject area *" : "Subject area";
              })()}
            >
              <select
                name="subjectArea"
                value={formData.subjectArea}
                onChange={handleChange}
                required={(() => {
                  const sourceUrl = formData.sourceUrl?.trim();
                  return (
                    sourceUrl &&
                    sourceUrl.length > 5 &&
                    !sourceUrl.includes("youtube.com") &&
                    !sourceUrl.includes("youtu.be")
                  );
                })()}
              >
                <option value="">Select category</option>
                <option>Programming</option>
                <option>Data Science</option>
                <option>Web Development</option>
                <option>Design</option>
                <option>Business</option>
                <option>Science</option>
                <option>Mathematics</option>
                <option>Language</option>
                <option>Other</option>
              </select>
            </Field>
          </div>

          <Field label="Course Source URL">
            <input
              type="url"
              name="sourceUrl"
              placeholder="https://youtube.com/playlist or course page"
              value={formData.sourceUrl}
              onChange={handleChange}
            />
            {formData.sourceUrl && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
                {formData.sourceUrl.includes("youtube.com") ||
                formData.sourceUrl.includes("youtu.be") ? (
                  <span style={{ color: "#666" }}>
                    📹 YouTube course - Video playback enabled
                  </span>
                ) : formData.sourceUrl.length > 5 ? (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.5rem",
                      background: "#e0f2fe",
                      border: "1px solid #7dd3fc",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      color: "#0369a1",
                    }}
                  >
                    <strong>ℹ️ External Course Detected:</strong> Quiz system
                    will be enabled. Modules will require passing a quiz before
                    marking as complete.
                  </div>
                ) : null}
              </div>
            )}
          </Field>

          <Field
            label={(() => {
              const sourceUrl = formData.sourceUrl?.trim();
              const isExternalCourse =
                sourceUrl &&
                sourceUrl.length > 5 &&
                !sourceUrl.includes("youtube.com") &&
                !sourceUrl.includes("youtu.be");
              return isExternalCourse ? "Description *" : "Description";
            })()}
          >
            <textarea
              name="description"
              placeholder="Brief description"
              rows={2}
              value={formData.description}
              onChange={handleChange}
              required={(() => {
                const sourceUrl = formData.sourceUrl?.trim();
                return (
                  sourceUrl &&
                  sourceUrl.length > 5 &&
                  !sourceUrl.includes("youtube.com") &&
                  !sourceUrl.includes("youtu.be")
                );
              })()}
            />
          </Field>

          <Field
            label={(() => {
              const sourceUrl = formData.sourceUrl?.trim();
              const isExternalCourse =
                sourceUrl &&
                sourceUrl.length > 5 &&
                !sourceUrl.includes("youtube.com") &&
                !sourceUrl.includes("youtu.be");
              return isExternalCourse
                ? "Learning objectives *"
                : "Learning objectives";
            })()}
          >
            <textarea
              name="learningObjectives"
              placeholder="What will you achieve?"
              rows={2}
              value={formData.learningObjectives}
              onChange={handleChange}
              required={(() => {
                const sourceUrl = formData.sourceUrl?.trim();
                return (
                  sourceUrl &&
                  sourceUrl.length > 5 &&
                  !sourceUrl.includes("youtube.com") &&
                  !sourceUrl.includes("youtu.be")
                );
              })()}
            />
          </Field>

          <div className={ui.formGrid}>
            <Field
              label={(() => {
                const sourceUrl = formData.sourceUrl?.trim();
                const isExternalCourse =
                  sourceUrl &&
                  sourceUrl.length > 5 &&
                  !sourceUrl.includes("youtube.com") &&
                  !sourceUrl.includes("youtu.be");
                return isExternalCourse
                  ? "Difficulty level *"
                  : "Difficulty level";
              })()}
            >
              <select
                name="difficulty"
                value={formData.difficulty}
                onChange={handleChange}
                required={(() => {
                  const sourceUrl = formData.sourceUrl?.trim();
                  return (
                    sourceUrl &&
                    sourceUrl.length > 5 &&
                    !sourceUrl.includes("youtube.com") &&
                    !sourceUrl.includes("youtu.be")
                  );
                })()}
              >
                <option value="">Select difficulty</option>
                <option>Beginner</option>
                <option>Intermediate</option>
                <option>Advanced</option>
              </select>
            </Field>
            <Field
              label={(() => {
                const sourceUrl = formData.sourceUrl?.trim();
                const isExternalCourse =
                  sourceUrl &&
                  sourceUrl.length > 5 &&
                  !sourceUrl.includes("youtube.com") &&
                  !sourceUrl.includes("youtu.be");
                return isExternalCourse ? "Priority *" : "Priority";
              })()}
            >
              <select
                name="priority"
                value={formData.priority}
                onChange={handleChange}
                required={(() => {
                  const sourceUrl = formData.sourceUrl?.trim();
                  return (
                    sourceUrl &&
                    sourceUrl.length > 5 &&
                    !sourceUrl.includes("youtube.com") &&
                    !sourceUrl.includes("youtu.be")
                  );
                })()}
              >
                <option value="">Select priority</option>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </Field>
          </div>

          <div className={ui.formGrid}>
            <Field label="Total hours *">
              <input
                type="number"
                name="totalEstimatedHours"
                min="1"
                placeholder="24"
                value={formData.totalEstimatedHours}
                onChange={handleChange}
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

          <InlineError error={error} />

          <div className={ui.modalActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                resetState();
                onCancel();
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? (
                <>
                  <InlineLoading /> Saving...
                </>
              ) : (
                "Save course"
              )}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default CreateCourseModal;
