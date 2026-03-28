import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useParams, useNavigate } from "react-router-dom";
import {
  FaArrowLeft,
  FaClock,
  FaBook,
  FaStickyNote,
  FaLink,
  FaCog,
  FaEdit,
  FaSave,
  FaTimes,
  FaPlay,
  FaShare,
} from "react-icons/fa";
import {
  courseApi,
  scheduleApi,
  aiApi,
  quizApi,
  classroomApi,
} from "../../services";
import {
  parseYouTubeChapters,
  mapChaptersToSubModules,
} from "../../utils/youtubeChapters";
import Button from "../ui/Button";
import { Loading, ErrorMessage, useToast } from "../ui/index";
import ui from "../ui/ui.module.css";
import ModuleTree from "./ModuleTree";
import ExternalLinks from "./ExternalLinks";
import ProgressCard from "./ProgressCard";
import EditCourseModal from "./EditCourseModal";
import QuizModal from "./QuizModal";
import ShareToClassroomModal from "../classroom/ShareToClassroomModal";
import styles from "./CourseDetails.module.css";

const pickSourceLink = (links = []) => {
  if (!links?.length) return null;
  const normalized = links.map((l) => ({
    ...l,
    platform: l.platform?.toLowerCase() || "",
    title: l.title?.toLowerCase() || "",
  }));
  return (
    normalized.find((l) => l.platform === "source" || l.title === "source") ||
    normalized.find((l) => l.platform.includes("youtube")) ||
    normalized[0]
  );
};

const detectPlayback = (url) => {
  if (!url) return { kind: "none" };

  const trimmed = url.trim();
  const videoMatch = trimmed.match(
    /\.(mp4|webm|ogg|mov|m4v|avi|mkv|m3u8)(\?.*)?$/i
  );
  if (videoMatch) {
    return { kind: "video", src: trimmed };
  }

  const ytId =
    trimmed.match(/(?:v=|\/embed\/|youtu\.be\/)([\w-]{6,})/)?.[1] || null;
  const playlist = trimmed.match(/[?&]list=([\w-]+)/)?.[1] || null;
  if (ytId || playlist) {
    const base = playlist
      ? `https://www.youtube.com/embed/videoseries?list=${playlist}`
      : `https://www.youtube.com/embed/${ytId}`;
    return {
      kind: "youtube",
      videoId: ytId,
      playlistId: playlist,
      embedUrl: `${base}?rel=0&modestbranding=1`,
    };
  }

  return { kind: "web", src: trimmed };
};

// Helper to extract videoId from YouTube URL or player
const extractVideoId = (url, player = null) => {
  if (!url && !player) return "";

  // Try to get from player first (most reliable)
  if (player && typeof player.getVideoData === "function") {
    try {
      const videoData = player.getVideoData();
      if (videoData && videoData.video_id) {
        return videoData.video_id;
      }
    } catch (e) {
      // Ignore
    }
  }

  // Fallback to extracting from URL
  if (url) {
    const match = url.match(/(?:v=|\/embed\/|youtu\.be\/)([\w-]{6,})/);
    if (match && match[1]) {
      return match[1];
    }
  }

  return "";
};

const percentFromTimes = (current, duration) => {
  if (!duration || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (current / duration) * 100));
};

const clampHours = (val, min = 4, max = 20) =>
  Math.min(max, Math.max(min, val));

function CourseDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);
  const [sendingTestReminder, setSendingTestReminder] = useState(false);
  const [issuingCertificate, setIssuingCertificate] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [syncingProgress, setSyncingProgress] = useState(false);
  const [playbackStats, setPlaybackStats] = useState({
    current: 0,
    duration: 0,
    percent: 0,
  });
  const [viewMode, setViewMode] = useState("embedded"); // "embedded" or "external"
  const [manualProgress, setManualProgress] = useState({
    hours: 0,
    minutes: 0,
  });
  const [showManualProgress, setShowManualProgress] = useState(false);
  const [quizModal, setQuizModal] = useState({
    isOpen: false,
    moduleId: null,
    moduleTitle: "",
  });
  const [showShareModal, setShowShareModal] = useState(false);
  const toast = useToast();
  const lastSyncRef = useRef({ hours: 0, ts: 0, reason: "" });
  const lastAiReasonRef = useRef("");
  const playbackStatsRef = useRef(playbackStats);
  // Debounce refs for backend sync - prevents excessive API calls during playback
  const backendSyncTimeoutRef = useRef(null);
  const lastBackendSyncRef = useRef(0);
  // Debounce refs for playback position database sync
  const playbackPositionSyncTimeoutRef = useRef(null);
  const lastPlaybackPositionSyncRef = useRef(0);
  // Ref for progress logging (to avoid spam)
  const lastProgressLogRef = useRef(0);
  // Track modules we've processed in this session with timestamps (prevent rapid toggling)
  const completedModulesThisSessionRef = useRef(new Map());
  // Track manually unchecked modules - prevent auto-tracking from overriding manual unchecks
  const manuallyUncheckedModulesRef = useRef(new Set());
  // Track if video is resuming - prevent module checks until resume completes
  const isResumingRef = useRef(false);
  // Track last completed module for smart resume - resume from last completed module's start time
  const lastCompletedModuleRef = useRef({
    moduleId: null,
    startTimeSeconds: 0,
    moduleIndex: -1,
  });
  const courseIdRef = useRef(id); // Store courseId in ref for event handlers (initialize with id from params)

  // Keep refs in sync with state
  useEffect(() => {
    playbackStatsRef.current = playbackStats;
  }, [playbackStats]);

  // Keep courseIdRef in sync with id from params
  useEffect(() => {
    courseIdRef.current = id;
  }, [id]);

  const fetchCourse = useCallback(
    async (options = {}) => {
      const { silent = false } = options;
      try {
        if (!silent) setLoading(true);
        const data = await courseApi.getCourse(id);
        setCourse(data);
        courseIdRef.current = data?.id || id; // Update ref when course loads
        setNoteDraft(data.notes || "");

        // Reset completed modules tracking when course is loaded
        // This allows re-tracking if user navigates away and comes back
        if (data?.modules) {
          completedModulesThisSessionRef.current.clear();
          // Don't clear manually unchecked modules - they should persist across refreshes
          // Only clear if user manually checks them again
          console.log(
            `[Progress] Reset tracking for ${data.modules.length} modules`
          );
          console.log(
            `[Manual Override] Currently tracking ${manuallyUncheckedModulesRef.current.size} manually unchecked modules`
          );
        }
      } catch (err) {
        setError(err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id]
  );

  // Fetch course on mount - use id directly to prevent unnecessary re-fetches
  useEffect(() => {
    fetchCourse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]); // Only fetch when id changes, not when fetchCourse changes

  // Check if user returned from external viewing
  useEffect(() => {
    if (!course?.id) return;

    const checkExternalViewing = () => {
      try {
        const key = `learnit_external_${course.id}`;
        const data = localStorage.getItem(key);
        if (data) {
          const external = JSON.parse(data);
          const openedAt = external.openedAt || 0;
          const timeSinceOpen = Date.now() - openedAt;

          // If opened more than 30 seconds ago, prompt to update progress
          if (timeSinceOpen > 30000 && timeSinceOpen < 3600000) {
            // Between 30s and 1 hour
            if (!showManualProgress) {
              setShowManualProgress(true);
              // Estimate progress based on time elapsed (rough estimate)
              const estimatedMinutes = Math.floor(timeSinceOpen / 60000);
              if (estimatedMinutes > 0) {
                setManualProgress({
                  hours: Math.floor(estimatedMinutes / 60),
                  minutes: estimatedMinutes % 60,
                });
              }
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };

    checkExternalViewing();
    // Check periodically
    const interval = setInterval(checkExternalViewing, 10000);
    return () => clearInterval(interval);
  }, [course?.id, showManualProgress]);

  const maybeAdjustSchedule = useCallback(
    async (reason, currentSeconds, durationSeconds) => {
      if (!course) return;

      const remaining = course.hoursRemaining ?? 0;
      const scheduled = course.scheduledHours ?? 0;
      const watchedHours = Math.max(0, (currentSeconds || 0) / 3600);
      const finishedClip =
        durationSeconds &&
        percentFromTimes(currentSeconds, durationSeconds) >= 90;
      const behindSchedule = remaining > scheduled + 1;

      // Also trigger on module completion events
      const moduleCompleted =
        reason.includes("module_completed") || reason.includes("playlist");

      // Trigger schedule update if: behind schedule, finished clip, or module completed
      if (!behindSchedule && !finishedClip && !moduleCompleted) return;

      const key = `${reason}-${course.id}`;
      if (lastAiReasonRef.current === key) return;

      try {
        // Use new auto-adjust endpoint that considers actual watch time and progress
        await scheduleApi.autoAdjustSchedule({
          courseId: course.id,
          actualWatchHours: watchedHours,
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        });
        console.log(
          `[Schedule] Auto-adjusted schedule for course ${
            course.id
          } (${watchedHours.toFixed(2)}h watched, reason: ${reason})`
        );
        lastAiReasonRef.current = key;
      } catch (err) {
        console.warn("Auto-schedule adjust failed", err);
      }

      try {
        await aiApi.scheduleInsights(
          JSON.stringify({
            reason,
            course: course.title,
            remainingHours: remaining,
            scheduledHours: scheduled,
            watchedHours: Number(watchedHours.toFixed(2)),
          })
        );
      } catch (err) {
        console.warn("AI schedule insight skipped", err);
      }
    },
    [course]
  );

  // Map video chapters to SubModules based on title matching
  const mapChaptersToSubModules = useCallback((chapters, modules) => {
    if (!chapters?.length || !modules?.length) return [];

    const allSubModules = modules
      .sort((a, b) => a.order - b.order)
      .flatMap((module) =>
        (module.subModules || [])
          .sort((a, b) => a.order - b.order)
          .map((subModule, idx) => ({
            ...subModule,
            moduleOrder: module.order,
            globalIndex: idx,
          }))
      );

    return chapters.map((chapter, chapterIdx) => {
      // Try to find SubModule by title match
      const matched = allSubModules.find(
        (sm) =>
          sm.title &&
          chapter.title &&
          (sm.title.toLowerCase().includes(chapter.title.toLowerCase()) ||
            chapter.title.toLowerCase().includes(sm.title.toLowerCase()))
      );

      // Fallback: match by index if titles don't match
      const byIndex =
        chapterIdx < allSubModules.length ? allSubModules[chapterIdx] : null;

      return {
        chapter,
        chapterIndex: chapterIdx,
        subModule: matched || byIndex,
      };
    });
  }, []);

  // Helper to get storage key for playback position (persists across sessions)
  const getPlaybackStorageKey = useCallback((courseId, videoId, playlistId) => {
    return `learnit_playback_${courseId}_${videoId || playlistId || "default"}`;
  }, []);

  /**
   * Debounced backend sync - prevents excessive API calls during playback
   * Only syncs to backend every 5 seconds maximum, or on important events (play/pause/seek/end)
   */
  const debouncedBackendSync = useCallback(
    async (courseId, currentTime, reason) => {
      // Clear any pending sync
      if (backendSyncTimeoutRef.current) {
        clearTimeout(backendSyncTimeoutRef.current);
        backendSyncTimeoutRef.current = null;
      }

      // Immediate sync for important events
      if (
        reason === "play" ||
        reason === "paused" ||
        reason === "ended" ||
        reason === "seeked"
      ) {
        try {
          const hours = Math.max(0, currentTime / 3600);
          const res = await courseApi.updateCourseActiveTime(
            courseId,
            Number(hours.toFixed(3))
          );
          lastBackendSyncRef.current = Date.now();
          lastSyncRef.current = { hours, ts: Date.now(), reason };
          setCourse((prev) =>
            prev
              ? {
                  ...prev,
                  hoursRemaining: res?.hoursRemaining ?? prev.hoursRemaining,
                  lastStudiedAt: new Date().toISOString(),
                }
              : prev
          );
        } catch (err) {
          console.warn("Failed to sync active time:", err);
        }
        return;
      }

      // Debounced sync for timeupdate events (every 5 seconds max)
      const now = Date.now();
      const timeSinceLastSync = now - lastBackendSyncRef.current;
      if (timeSinceLastSync < 5000) {
        // Schedule sync for later
        backendSyncTimeoutRef.current = setTimeout(async () => {
          try {
            const hours = Math.max(0, currentTime / 3600);
            await courseApi.updateCourseActiveTime(
              courseId,
              Number(hours.toFixed(3))
            );
            lastBackendSyncRef.current = Date.now();
          } catch (err) {
            console.warn("Failed to sync active time (debounced):", err);
          }
        }, 5000 - timeSinceLastSync);
      } else {
        // Sync immediately if enough time has passed
        try {
          const hours = Math.max(0, currentTime / 3600);
          await courseApi.updateCourseActiveTime(
            courseId,
            Number(hours.toFixed(3))
          );
          lastBackendSyncRef.current = Date.now();
        } catch (err) {
          console.warn("Failed to sync active time:", err);
        }
      }
    },
    []
  );

  /**
   * Main playback sync function - handles progress tracking and module completion
   * Uses YouTube chapter timestamps for deterministic time mapping
   */
  const syncPlayback = useCallback(
    async (
      {
        currentTime,
        duration,
        percent,
        playlistVideoIndex,
        playlistVideoId,
        videoEnded,
      },
      reason = "interval"
    ) => {
      if (!course?.id || !Number.isFinite(currentTime) || currentTime < 0)
        return;

      // Always update playback stats for display (UI feedback)
      setPlaybackStats({
        current: currentTime,
        duration: duration || playbackStats.duration,
        percent: percent ?? percentFromTimes(currentTime, duration),
      });

      // CRITICAL: Detect playback type early so it's available throughout the function
      const sourceLink = pickSourceLink(course.externalLinks);
      const playback = detectPlayback(sourceLink?.url);

      // CRITICAL: Always save to localStorage immediately for resume (fast, works offline)
      // But only save meaningful positions (> 1 second) to avoid overwriting good positions
      const MIN_SAVE_TIME_LOCAL = 1; // Minimum seconds for localStorage (lower threshold for faster resume)
      if (
        currentTime >= MIN_SAVE_TIME_LOCAL ||
        (reason === "ended" && currentTime > 0)
      ) {
        const storageKey = `learnit_playback_${course.id}_${
          playback.videoId ||
          playlistVideoId ||
          playback.playlistId ||
          "default"
        }`;
        try {
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              currentTime,
              duration: duration || 0,
              timestamp: Date.now(),
            })
          );
        } catch (e) {
          console.warn("Failed to save playback position to localStorage:", e);
        }
      }

      // Also save to database (debounced - every 5 seconds max) for persistence across logout/login
      if (playback.kind === "youtube" && course?.id) {
        // CRITICAL: Don't save positions that are too close to 0 (initial load) or invalid
        // Only save meaningful positions (> 2 seconds) to avoid overwriting good positions with 0.0s
        const MIN_SAVE_TIME = 2; // Minimum seconds before we save (prevents saving 0.0s on initial load)
        const shouldSave =
          currentTime >= MIN_SAVE_TIME ||
          (reason === "ended" && currentTime > 0);

        if (!shouldSave) {
          // Don't save positions that are too early (likely initial load)
          return;
        }

        const now = Date.now();
        const timeSinceLastSync = now - lastPlaybackPositionSyncRef.current;

        // Immediate sync for important events (but only if position is meaningful)
        if (
          reason === "play" ||
          reason === "paused" ||
          reason === "ended" ||
          reason === "seeked"
        ) {
          // Clear any pending sync
          if (playbackPositionSyncTimeoutRef.current) {
            clearTimeout(playbackPositionSyncTimeoutRef.current);
            playbackPositionSyncTimeoutRef.current = null;
          }

          try {
            // Find current module if available
            const modules = (course.modules || []).sort(
              (a, b) => (a.order || 0) - (b.order || 0)
            );
            let currentModule = null;
            // Try to find module based on current time (for chapter-based modules)
            for (const module of modules) {
              try {
                const notes = module.notes || module.Notes || "";
                if (notes) {
                  const metadata = JSON.parse(notes);
                  if (
                    metadata.startTimeSeconds !== undefined &&
                    currentTime >= metadata.startTimeSeconds
                  ) {
                    if (
                      !currentModule ||
                      metadata.startTimeSeconds >
                        (JSON.parse(
                          currentModule.notes || currentModule.Notes || "{}"
                        ).startTimeSeconds || 0)
                    ) {
                      currentModule = module;
                    }
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }

            // Get videoId from player if available (more reliable than playback.videoId)
            let saveVideoId = playback.videoId || playlistVideoId || "";
            // Try to get from player if we have access (for consistency with resume logic)

            await courseApi.savePlaybackPosition(course.id, {
              moduleId: currentModule?.id || null,
              videoId: saveVideoId,
              playlistId: playback.playlistId || "",
              currentTimeSeconds: currentTime,
              durationSeconds: duration || 0,
            });

            // For playlists, save the last watched videoId to localStorage for resume
            if (playback.playlistId && saveVideoId) {
              try {
                const lastVideoKey = `learnit_playlist_last_video_${course.id}_${playback.playlistId}`;
                localStorage.setItem(
                  lastVideoKey,
                  JSON.stringify({
                    videoId: saveVideoId,
                    timestamp: Date.now(),
                  })
                );
              } catch (e) {
                console.warn("Failed to save last video to localStorage:", e);
              }
            }

            lastPlaybackPositionSyncRef.current = now;
            console.log(
              `[Playback Position] 💾 Saved current position: ${currentTime.toFixed(
                1
              )}s / ${duration?.toFixed(1) || 0}s (videoId: ${
                saveVideoId || "NONE"
              }, moduleId: ${currentModule?.id || "null"})`
            );
          } catch (err) {
            console.warn("Failed to save playback position to database:", err);
          }
        }
        // Debounced sync for timeupdate events (every 5 seconds max)
        else if (reason === "timeupdate" && timeSinceLastSync >= 5000) {
          // Clear any pending sync
          if (playbackPositionSyncTimeoutRef.current) {
            clearTimeout(playbackPositionSyncTimeoutRef.current);
            playbackPositionSyncTimeoutRef.current = null;
          }

          try {
            const modules = (course.modules || []).sort(
              (a, b) => (a.order || 0) - (b.order || 0)
            );
            let currentModule = null;
            for (const module of modules) {
              try {
                const notes = module.notes || module.Notes || "";
                if (notes) {
                  const metadata = JSON.parse(notes);
                  if (
                    metadata.startTimeSeconds !== undefined &&
                    currentTime >= metadata.startTimeSeconds
                  ) {
                    if (
                      !currentModule ||
                      metadata.startTimeSeconds >
                        (JSON.parse(
                          currentModule.notes || currentModule.Notes || "{}"
                        ).startTimeSeconds || 0)
                    ) {
                      currentModule = module;
                    }
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }

            // Get videoId from player if available (more reliable than playback.videoId)
            let saveVideoId = playback.videoId || playlistVideoId || "";

            await courseApi.savePlaybackPosition(course.id, {
              moduleId: currentModule?.id || null,
              videoId: saveVideoId,
              playlistId: playback.playlistId || "",
              currentTimeSeconds: currentTime,
              durationSeconds: duration || 0,
            });

            // For playlists, save the last watched videoId to localStorage for resume
            if (playback.playlistId && saveVideoId) {
              try {
                const lastVideoKey = `learnit_playlist_last_video_${course.id}_${playback.playlistId}`;
                localStorage.setItem(
                  lastVideoKey,
                  JSON.stringify({
                    videoId: saveVideoId,
                    timestamp: Date.now(),
                  })
                );
              } catch (e) {
                console.warn("Failed to save last video to localStorage:", e);
              }
            }

            lastPlaybackPositionSyncRef.current = now;
            console.log(
              `[Playback Position] 💾 Saved current position (debounced): ${currentTime.toFixed(
                1
              )}s (videoId: ${saveVideoId || "NONE"})`
            );
          } catch (err) {
            console.warn(
              "Failed to save playback position to database (debounced):",
              err
            );
          }
        } else if (reason === "timeupdate" && timeSinceLastSync < 5000) {
          // Schedule sync for later
          if (playbackPositionSyncTimeoutRef.current) {
            clearTimeout(playbackPositionSyncTimeoutRef.current);
          }
          playbackPositionSyncTimeoutRef.current = setTimeout(async () => {
            try {
              const modules = (course.modules || []).sort(
                (a, b) => (a.order || 0) - (b.order || 0)
              );
              let currentModule = null;
              for (const module of modules) {
                try {
                  const notes = module.notes || module.Notes || "";
                  if (notes) {
                    const metadata = JSON.parse(notes);
                    if (
                      metadata.startTimeSeconds !== undefined &&
                      currentTime >= metadata.startTimeSeconds
                    ) {
                      if (
                        !currentModule ||
                        metadata.startTimeSeconds >
                          (JSON.parse(
                            currentModule.notes || currentModule.Notes || "{}"
                          ).startTimeSeconds || 0)
                      ) {
                        currentModule = module;
                      }
                    }
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }

              // Get videoId from player if available (more reliable than playback.videoId)
              let saveVideoId = playback.videoId || playlistVideoId || "";

              await courseApi.savePlaybackPosition(course.id, {
                moduleId: currentModule?.id || null,
                videoId: saveVideoId,
                playlistId: playback.playlistId || "",
                currentTimeSeconds: currentTime,
                durationSeconds: duration || 0,
              });

              // For playlists, save the last watched videoId to localStorage for resume
              if (playback.playlistId && saveVideoId) {
                try {
                  const lastVideoKey = `learnit_playlist_last_video_${course.id}_${playback.playlistId}`;
                  localStorage.setItem(
                    lastVideoKey,
                    JSON.stringify({
                      videoId: saveVideoId,
                      timestamp: Date.now(),
                    })
                  );
                } catch (e) {
                  console.warn("Failed to save last video to localStorage:", e);
                }
              }

              lastPlaybackPositionSyncRef.current = Date.now();
            } catch (err) {
              console.warn(
                "Failed to save playback position to database (scheduled):",
                err
              );
            }
          }, 5000 - timeSinceLastSync);
        }
      }

      // Process module completion on ALL playback events (especially timeupdate for real-time tracking)
      const shouldProcess =
        reason === "play" ||
        reason === "paused" ||
        reason === "ended" ||
        reason === "seeked" ||
        reason === "timeupdate";
      if (!shouldProcess) return;

      // CRITICAL: Skip module completion checks if video just started and might be resuming
      // This prevents modules from being unchecked when video starts at 0 before resume completes
      // For YouTube videos, if we're at the very beginning (< 3s) and haven't seen a seek event,
      // wait a bit to allow resume to complete
      // Only skip if isResumingRef is set (actually resuming) or if we're at the very beginning (< 2s)
      if (
        playback.kind === "youtube" &&
        currentTime < 3 &&
        reason !== "seeked" &&
        reason === "timeupdate"
      ) {
        // Only skip if we're actually resuming OR if we're at the very beginning (< 2s)
        if (isResumingRef.current || currentTime < 2) {
          if (Math.random() < 0.2) {
            console.log(
              `[Progress] Skipping module check - ${
                isResumingRef.current ? "resuming" : "just started"
              } (currentTime: ${currentTime.toFixed(1)}s)...`
            );
          }
          return;
        }
      }

      // CRITICAL: Always check module completion on timeupdate (runs every few seconds during playback)
      // This ensures modules are marked complete as soon as video crosses their boundaries

      try {
        const modules = (course.modules || []).sort(
          (a, b) => (a.order || 0) - (b.order || 0)
        );
        if (!modules.length || !duration || duration <= 0) {
          if (reason === "timeupdate" && Math.random() < 0.1) {
            // Log 10% of timeupdate events for debugging
            console.log(
              `[Progress] Skipping - modules: ${modules.length}, duration: ${duration}`
            );
          }
          return;
        }

        // Debug: Log periodically that we're processing progress
        if (reason === "timeupdate" && Math.random() < 0.05) {
          // Log 5% of timeupdate events
          console.log(
            `[Progress] Processing progress check - time: ${currentTime.toFixed(
              1
            )}s, duration: ${duration.toFixed(1)}s, modules: ${modules.length}`
          );
        }

        // Build time maps for modules and submodules
        // Priority: Use Notes field (JSON) for YouTube modules with startTimeSeconds, otherwise fall back to estimated hours
        // NOTE: sourceLink and playback are already defined at the top of the function (line 388-389)
        const subModuleTimeMap = [];
        const moduleTimeMap = [];

        // For YouTube videos: Use Notes field to get startTimeSeconds and durationSeconds
        // For other videos: Map chapters to submodules, then modules
        const isYouTubeVideo =
          playback.kind === "youtube" && !playback.playlistId;

        if (isYouTubeVideo) {
          // YouTube: Each module has its own startTimeSeconds in Notes field (from backend)
          // Parse Notes JSON to get timing info - these should align with actual video sections/chapters
          // Only log once per session to avoid spam
          if (reason === "timeupdate" && Math.random() < 0.01) {
            console.log(
              `[Progress] Building module time map for ${
                modules.length
              } modules (YouTube video, duration: ${duration.toFixed(1)}s = ${(
                duration / 60
              ).toFixed(1)} minutes)`
            );
            console.log(
              `[Progress] Module names: ${modules
                .map((m, idx) => `${idx + 1}. ${m.title}`)
                .join(", ")}`
            );
          }

          // First pass: Collect all startTimeSeconds from Notes to verify alignment
          const moduleTimings = [];
          for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            try {
              const notes = module.notes || module.Notes || "";
              if (notes) {
                const metadata = JSON.parse(notes);
                moduleTimings.push({
                  index: i,
                  title: module.title,
                  startTimeSeconds: metadata.startTimeSeconds,
                  durationSeconds: metadata.durationSeconds,
                  order: metadata.order,
                });
              }
            } catch (e) {
              // Ignore
            }
          }

          if (moduleTimings.length > 0) {
            console.log(`[Progress] Module timings from Notes:`);
            moduleTimings.forEach((mt) => {
              console.log(
                `  Module ${mt.index + 1} '${mt.title}': startTime=${
                  mt.startTimeSeconds ?? "N/A"
                }s (${
                  mt.startTimeSeconds
                    ? (mt.startTimeSeconds / 60).toFixed(1) + "min"
                    : "N/A"
                }), duration=${mt.durationSeconds ?? "N/A"}s`
              );
            });
          }

          for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            let startTime = 0;
            let endTime = duration;
            let moduleDuration = duration;

            // Try to parse Notes field (contains JSON with startTimeSeconds, durationSeconds)
            // CRITICAL: Use startTimeSeconds from Notes to align with actual video sections
            let hasNotesData = false;
            try {
              const notes = module.notes || module.Notes || "";
              if (notes) {
                const metadata = JSON.parse(notes);

                // Get startTime from Notes (this is the actual video section start time)
                if (
                  metadata.startTimeSeconds !== undefined &&
                  metadata.startTimeSeconds !== null
                ) {
                  startTime = metadata.startTimeSeconds;
                  hasNotesData = true;
                }

                // Calculate endTime: Use next module's startTime if available (most accurate)
                // Otherwise use durationSeconds from Notes, or calculate from video duration
                let calculatedEndTime = null;

                // PRIORITY 1: Use next module's startTime (most accurate alignment)
                if (i + 1 < modules.length) {
                  const nextNotes =
                    modules[i + 1].notes || modules[i + 1].Notes || "";
                  if (nextNotes) {
                    try {
                      const nextMetadata = JSON.parse(nextNotes);
                      if (
                        nextMetadata.startTimeSeconds !== undefined &&
                        nextMetadata.startTimeSeconds !== null
                      ) {
                        calculatedEndTime = nextMetadata.startTimeSeconds;
                        hasNotesData = true;
                      }
                    } catch (e) {
                      // Continue to next option
                    }
                  }
                }

                // PRIORITY 2: Use durationSeconds from Notes if next module not available
                if (
                  calculatedEndTime === null &&
                  metadata.durationSeconds !== undefined &&
                  metadata.durationSeconds !== null &&
                  metadata.durationSeconds > 0
                ) {
                  calculatedEndTime = startTime + metadata.durationSeconds;
                  hasNotesData = true;
                }

                // PRIORITY 3: If last module, use video duration
                if (calculatedEndTime === null && i === modules.length - 1) {
                  calculatedEndTime = duration;
                  hasNotesData = true;
                }

                if (calculatedEndTime !== null) {
                  endTime = calculatedEndTime;
                  moduleDuration = endTime - startTime;
                }

                if (hasNotesData) {
                  console.log(
                    `[Progress] Module ${i + 1}/${modules.length} '${
                      module.title
                    }': startTime=${startTime.toFixed(1)}s (${(
                      startTime / 60
                    ).toFixed(1)}min), endTime=${endTime.toFixed(1)}s (${(
                      endTime / 60
                    ).toFixed(1)}min), duration=${moduleDuration.toFixed(
                      1
                    )}s (${(moduleDuration / 60).toFixed(
                      1
                    )}min) - ALIGNED with video section`
                  );
                } else {
                  console.warn(
                    `[Progress] Module ${i + 1} '${
                      module.title
                    }': NO Notes data - using fallback timing`
                  );
                }
              }
            } catch (e) {
              console.warn(
                `[Progress] Failed to parse Notes for module ${i} '${module.title}':`,
                e
              );
              // Continue to fallback
            }

            // FALLBACK: If no Notes data, calculate timing from estimated hours or distribute evenly
            if (!hasNotesData) {
              // Calculate startTime from previous module's endTime
              if (i > 0 && moduleTimeMap.length > 0) {
                startTime = moduleTimeMap[moduleTimeMap.length - 1].endTime;
              } else {
                startTime = 0;
              }

              // Try to use estimated hours first
              const estimatedHours = module.estimatedHours || 0;
              if (estimatedHours > 0) {
                moduleDuration = estimatedHours * 3600; // Convert hours to seconds
                endTime = startTime + moduleDuration;
              } else {
                // Distribute remaining time evenly across remaining modules
                const remainingModules = modules.length - i;
                const remainingTime = Math.max(0, duration - startTime);
                moduleDuration =
                  remainingModules > 0 ? remainingTime / remainingModules : 0;
                endTime = startTime + moduleDuration;
              }

              // Ensure endTime doesn't exceed video duration
              if (endTime > duration) {
                endTime = duration;
                moduleDuration = endTime - startTime;
              }

              if (i < 3) {
                console.log(
                  `[Progress] Module ${i} '${
                    module.title
                  }': Using fallback timing (estimatedHours: ${estimatedHours}h) - startTime=${startTime.toFixed(
                    1
                  )}s, duration=${moduleDuration.toFixed(
                    1
                  )}s, endTime=${endTime.toFixed(1)}s`
                );
              }
            }

            moduleTimeMap.push({
              module,
              startTime,
              endTime,
              duration: moduleDuration,
            });
          }

          // Log final time map for verification (only once)
          if (
            moduleTimeMap.length > 0 &&
            reason === "timeupdate" &&
            Math.random() < 0.01
          ) {
            console.log(
              `[Progress] Final module time map (${moduleTimeMap.length} modules):`
            );
            moduleTimeMap.forEach((item, idx) => {
              console.log(
                `  ${idx + 1}. '${
                  item.module.title
                }': [${item.startTime.toFixed(1)}s - ${item.endTime.toFixed(
                  1
                )}s] (${(item.duration / 60).toFixed(1)}min)`
              );
            });
          }
        } else {
          // Fallback: Extract YouTube chapters from description for non-YouTube or playlists
          // NOTE: sourceLink is already defined at the top of the function (line 388)
          let chapters = [];
          if (playback.kind === "youtube" && sourceLink && sourceLink.url) {
            const description =
              course.description || sourceLink.description || "";
            chapters = parseYouTubeChapters(description);
          }
          // Non-YouTube or playlist: Use existing submodule mapping logic
          for (const module of modules) {
            const subModules = (module.subModules || []).sort(
              (a, b) => (a.order || 0) - (b.order || 0)
            );
            const moduleStartTime =
              subModuleTimeMap.length > 0
                ? subModuleTimeMap[subModuleTimeMap.length - 1].endTime
                : 0;
            let moduleEndTime = moduleStartTime;

            // Map submodules using YouTube chapters if available
            if (chapters.length > 0 && subModules.length > 0) {
              // Use chapter timestamps for deterministic mapping
              const mappedChapters = mapChaptersToSubModules(
                chapters,
                modules,
                duration
              );

              for (let i = 0; i < subModules.length; i++) {
                const subModule = subModules[i];
                const mapped = mappedChapters.find(
                  (m) => m.subModule.id === subModule.id
                );

                if (mapped) {
                  // Use chapter timestamp as start time
                  const startTime = mapped.startTime;
                  const endTime =
                    mapped.endTime !== null ? mapped.endTime : duration;

                  subModuleTimeMap.push({
                    subModule,
                    module,
                    startTime,
                    endTime,
                    duration: endTime - startTime,
                  });
                  moduleEndTime = endTime;
                } else {
                  // Fallback: distribute remaining time evenly
                  const remainingSubModules = subModules.length - i;
                  const remainingTime = duration - moduleEndTime;
                  const subModuleDuration = remainingTime / remainingSubModules;

                  subModuleTimeMap.push({
                    subModule,
                    module,
                    startTime: moduleEndTime,
                    endTime: moduleEndTime + subModuleDuration,
                    duration: subModuleDuration,
                  });
                  moduleEndTime += subModuleDuration;
                }
              }
            } else {
              // Fallback: Use estimated hours or distribute evenly
              for (const subModule of subModules) {
                const estimatedHours = subModule.estimatedHours || 0;
                const subModuleDuration =
                  estimatedHours > 0
                    ? estimatedHours * 3600
                    : (duration - moduleEndTime) /
                      (subModules.length -
                        subModuleTimeMap.filter(
                          (sm) => sm.module.id === module.id
                        ).length);

                subModuleTimeMap.push({
                  subModule,
                  module,
                  startTime: moduleEndTime,
                  endTime: moduleEndTime + subModuleDuration,
                  duration: subModuleDuration,
                });
                moduleEndTime += subModuleDuration;
              }
            }

            moduleTimeMap.push({
              module,
              startTime: moduleStartTime,
              endTime: moduleEndTime,
              duration: moduleEndTime - moduleStartTime,
            });
          }
        }

        // Find current module and submodule
        let currentModule = null;
        let currentModuleIndex = -1;
        let currentSubModule = null;
        let currentSubModuleIndex = -1;

        for (let i = 0; i < moduleTimeMap.length; i++) {
          const item = moduleTimeMap[i];
          if (
            currentTime >= item.startTime &&
            (i === moduleTimeMap.length - 1 || currentTime < item.endTime)
          ) {
            currentModule = item.module;
            currentModuleIndex = i;
            break;
          }
        }

        for (let i = 0; i < subModuleTimeMap.length; i++) {
          const item = subModuleTimeMap[i];
          if (
            currentTime >= item.startTime &&
            (i === subModuleTimeMap.length - 1 || currentTime < item.endTime)
          ) {
            currentSubModule = item.subModule;
            currentSubModuleIndex = i;
            break;
          }
        }

        // Debug: Log current module info periodically (every 10 seconds)
        const now = Date.now();
        if (now - lastProgressLogRef.current > 10000) {
          if (currentModule && currentModuleIndex >= 0) {
            const moduleItem = moduleTimeMap[currentModuleIndex];
            if (moduleItem) {
              const moduleProgress =
                moduleItem.duration > 0
                  ? ((currentTime - moduleItem.startTime) /
                      moduleItem.duration) *
                    100
                  : 0;
              console.log(
                `[Progress] Current module: '${currentModule.title}' (${
                  currentModuleIndex + 1
                }/${moduleTimeMap.length}), completed: ${
                  currentModule.isCompleted
                }, progress: ${moduleProgress.toFixed(
                  1
                )}%, time: ${currentTime.toFixed(
                  1
                )}s/${moduleItem.endTime.toFixed(1)}s`
              );
            }
          }
          if (currentSubModule) {
            console.log(
              `[Progress] Current submodule: ${currentSubModule.title} (index ${currentSubModuleIndex}), completed: ${currentSubModule.isCompleted}`
            );
          }
          lastProgressLogRef.current = now;
        }

        // Handle seek: mark all previous modules/submodules as complete
        // IMPORTANT: Skip this logic for playlists - playlists have separate modules per video
        // and should only be marked complete when the video reaches 80% (handled separately)
        // Also skip if moduleTimeMap is empty (indicates playlist or non-YouTube content)
        // NOTE: sourceLink and playback are already defined at the top of the function (line 388-389)
        const playbackForSeek = playback; // Use the playback already defined at top
        const isPlaylist =
          playbackForSeek.playlistId ||
          playlistVideoId ||
          moduleTimeMap.length === 0;
        if (
          reason === "seeked" &&
          playbackForSeek.kind === "youtube" &&
          !isPlaylist &&
          moduleTimeMap.length > 0
        ) {
          const completedModuleIds = new Set();
          const completedSubModuleIds = new Set();

          // Mark all previous submodules as complete
          if (currentSubModuleIndex >= 0) {
            for (let i = 0; i <= currentSubModuleIndex; i++) {
              const item = subModuleTimeMap[i];
              if (
                !item.subModule.isCompleted &&
                currentTime >= item.startTime
              ) {
                completedSubModuleIds.add(item.subModule.id);
              }
            }
          }

          // Mark all previous modules as complete
          if (currentModuleIndex >= 0) {
            for (let i = 0; i < currentModuleIndex; i++) {
              const prevModule = moduleTimeMap[i].module;
              if (!prevModule.isCompleted) {
                completedModuleIds.add(prevModule.id);
              }
            }
          }

          // Update submodules
          for (const subModuleId of completedSubModuleIds) {
            const item = subModuleTimeMap.find(
              (sm) => sm.subModule.id === subModuleId
            );
            if (item) {
              try {
                const subModules = (item.module.subModules || []).sort(
                  (a, b) => (a.order || 0) - (b.order || 0)
                );
                const subModuleIndex = subModules.findIndex(
                  (sm) => sm.id === subModuleId
                );
                if (subModuleIndex >= 0) {
                  await courseApi.updateChapterProgress(
                    course.id,
                    item.subModule.title,
                    subModuleIndex,
                    100
                  );
                  console.log(
                    `[Seek] SubModule '${item.subModule.title}' marked complete`
                  );
                }
              } catch (err) {
                console.warn(`Failed to mark submodule ${subModuleId}:`, err);
              }
            }
          }

          // Update modules
          for (const moduleId of completedModuleIds) {
            const module = modules.find((m) => m.id === moduleId);
            if (module) {
              try {
                const subModules = (module.subModules || []).sort(
                  (a, b) => (a.order || 0) - (b.order || 0)
                );
                if (subModules.length > 0) {
                  await Promise.all(
                    subModules.map((sm, idx) =>
                      courseApi
                        .updateChapterProgress(course.id, sm.title, idx, 100)
                        .catch(() => null)
                    )
                  );
                }
                await courseApi.toggleModuleCompletion(moduleId);
                console.log(`[Seek] Module '${module.title}' marked complete`);
              } catch (err) {
                console.warn(`Failed to mark module ${moduleId}:`, err);
              }
            }
          }

          // Refresh course data
          setTimeout(() => fetchCourse({ silent: true }), 500);
        }

        // ============================================================
        // AUTO MODULE COMPLETION TRACKING (YouTube Single Videos)
        // ============================================================
        // Simple logic: Automatically check/uncheck modules based on video playback position
        // - If video has passed module's startTime (or 90% threshold), mark complete
        // - If video is before module's startTime, mark incomplete
        // This syncs module completion with actual video playback position
        // ============================================================
        // AUTO MODULE COMPLETION: Check ALL modules for YouTube single videos
        // Simple and reliable: Mark complete when video passes 90% of module duration
        if (
          playback.kind === "youtube" &&
          !playback.playlistId &&
          moduleTimeMap.length > 0
        ) {
          const completionThreshold = 0.9; // Mark complete at 90% of module duration

          // Check ALL modules and sync their completion state with video playback position
          for (let i = 0; i < moduleTimeMap.length; i++) {
            const moduleItem = moduleTimeMap[i];
            const module = moduleItem.module;

            // Skip if timing data is invalid
            if (
              moduleItem.startTime < 0 ||
              moduleItem.endTime <= moduleItem.startTime
            ) {
              continue;
            }

            const moduleDuration = moduleItem.endTime - moduleItem.startTime;
            if (moduleDuration <= 0) {
              continue;
            }

            // Calculate threshold: 90% through the module
            const thresholdTime =
              moduleItem.startTime + moduleDuration * completionThreshold;
            const moduleProgress =
              ((currentTime - moduleItem.startTime) / moduleDuration) * 100;

            // Mark complete if we've passed the threshold OR passed the end time
            const shouldBeCompleted =
              currentTime >= thresholdTime || currentTime >= moduleItem.endTime;
            const currentlyCompleted = module.isCompleted;

            // Only update if state needs to change
            if (shouldBeCompleted !== currentlyCompleted) {
              // Respect manual unchecks - if user manually unchecked, don't auto-check
              if (
                shouldBeCompleted &&
                manuallyUncheckedModulesRef.current.has(module.id)
              ) {
                continue;
              }

              // Skip if we just processed this module (prevent rapid toggling)
              const lastProcessed = completedModulesThisSessionRef.current.get(
                module.id
              );
              const timeSinceLastProcess = lastProcessed
                ? Date.now() - lastProcessed
                : Infinity;

              // Only process if enough time has passed (at least 1 second)
              if (timeSinceLastProcess < 1000) {
                continue;
              }

              // Mark as processed
              completedModulesThisSessionRef.current.set(module.id, Date.now());

              try {
                console.log(
                  `[Progress] ${shouldBeCompleted ? "✅" : "❌"} Module '${
                    module.title
                  }' ${
                    shouldBeCompleted ? "completed" : "incomplete"
                  } (time: ${currentTime.toFixed(1)}s ${
                    shouldBeCompleted ? ">=" : "<"
                  } ${thresholdTime.toFixed(
                    1
                  )}s, progress: ${moduleProgress.toFixed(1)}%)`
                );

                // Use set-completion endpoint for auto-tracking (ensures persistence)
                await courseApi.setModuleCompletion(
                  module.id,
                  shouldBeCompleted
                );

                // When module is completed, track it for smart resume (but DON'T overwrite actual playback position)
                // The actual playback position should be saved separately in syncPlayback, not here
                if (shouldBeCompleted) {
                  if (moduleItem && moduleItem.startTime > 0) {
                    lastCompletedModuleRef.current = {
                      moduleId: module.id,
                      startTimeSeconds: moduleItem.startTime,
                      moduleIndex: i,
                    };
                    // NOTE: We don't save module start time here - that would overwrite the actual playback position
                    // The actual position is saved in syncPlayback function, and smart resume uses this ref as fallback
                  }
                }

                // Update local state immediately
                setCourse((prev) => {
                  if (!prev) return prev;
                  const updatedModules = prev.modules.map((m) =>
                    m.id === module.id
                      ? { ...m, isCompleted: shouldBeCompleted }
                      : m
                  );

                  // Recalculate progress
                  const totalModules = updatedModules.length;
                  const completedModules = updatedModules.filter(
                    (m) => m.isCompleted
                  ).length;
                  const progressPercentage =
                    totalModules > 0
                      ? Math.round((completedModules / totalModules) * 100)
                      : 0;

                  return {
                    ...prev,
                    modules: updatedModules,
                    progressPercentage: progressPercentage,
                    completedModules: completedModules,
                  };
                });

                // Sync with backend after a short delay
                setTimeout(() => fetchCourse({ silent: true }), 500);

                // Update scheduler when module completes
                if (shouldBeCompleted) {
                  try {
                    await maybeAdjustSchedule(
                      "module_completed",
                      currentTime,
                      duration
                    );
                  } catch (scheduleErr) {
                    console.warn("Schedule update failed:", scheduleErr);
                  }
                }
              } catch (err) {
                // Remove from processed set on error so we can retry
                completedModulesThisSessionRef.current.delete(module.id);
                console.error(
                  `❌ Failed to update module '${module.title}':`,
                  err
                );
              }
            }
          }
        }

        // ============================================================
        // PLAYLIST MODULE COMPLETION (YouTube Playlists)
        // ============================================================
        // When a playlist video ends OR reaches 80% completion, mark the corresponding module as complete
        // This is ISOLATED from single video logic above - does NOT modify single video logic
        // ============================================================
        if (playback.kind === "youtube" && playback.playlistId) {
          // Get playlist video info - use provided or try to extract
          let currentPlaylistVideoId = playlistVideoId;
          let currentPlaylistVideoIndex = playlistVideoIndex;

          // Check if video ended OR reached 80% completion (playlist-specific threshold)
          const videoEndedOrComplete =
            videoEnded || (duration > 0 && percent >= 80);

          // Debug logging for playlist completion
          if (videoEndedOrComplete || (duration > 0 && percent >= 75)) {
            console.log(
              `[Playlist Progress] Checking completion - videoEnded: ${videoEnded}, percent: ${percent.toFixed(
                1
              )}%, videoId: ${currentPlaylistVideoId || "NONE"}, index: ${
                currentPlaylistVideoIndex !== undefined
                  ? currentPlaylistVideoIndex
                  : "NONE"
              }`
            );
          }

          // For playlists, we need either videoId OR index to identify the module
          // If video ended, we should still try to mark the module complete even if videoId is missing
          if (
            videoEndedOrComplete &&
            (currentPlaylistVideoId ||
              (currentPlaylistVideoIndex !== undefined &&
                currentPlaylistVideoIndex >= 0))
          ) {
            const statusText = videoEnded ? "ended" : "reached 80%";
            const videoIdStr =
              currentPlaylistVideoId ||
              `index-${
                currentPlaylistVideoIndex !== undefined
                  ? currentPlaylistVideoIndex + 1
                  : "unknown"
              }`;
            console.log(
              `[Playlist Progress] Video ${statusText}: ${videoIdStr} (index: ${
                currentPlaylistVideoIndex !== undefined
                  ? currentPlaylistVideoIndex + 1
                  : "unknown"
              }, progress: ${percent.toFixed(1)}%)`
            );

            // Find the module that corresponds to this playlist video
            const modules = (course.modules || []).sort(
              (a, b) => (a.order || 0) - (b.order || 0)
            );
            let matchingModule = null;

            // Try to find module by videoId in Notes field
            for (const module of modules) {
              try {
                const notes = module.notes || module.Notes || "";
                if (notes) {
                  const metadata = JSON.parse(notes);
                  // Check if this module's videoId matches the playlist video
                  if (metadata.videoId === currentPlaylistVideoId) {
                    matchingModule = module;
                    console.log(
                      `[Playlist Progress] ✅ Found matching module: '${module.title}' for video ${currentPlaylistVideoId}`
                    );
                    break;
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }

            // If no match by videoId, try by index (if playlistVideoIndex is available)
            // IMPORTANT: For playlists, modules are typically in the same order as videos
            if (
              !matchingModule &&
              currentPlaylistVideoIndex !== undefined &&
              currentPlaylistVideoIndex >= 0 &&
              currentPlaylistVideoIndex < modules.length
            ) {
              matchingModule = modules[currentPlaylistVideoIndex];
              console.log(
                `[Playlist Progress] ✅ Using module by index ${
                  currentPlaylistVideoIndex + 1
                }: '${matchingModule.title}'`
              );
            } else if (
              !matchingModule &&
              !currentPlaylistVideoId &&
              currentPlaylistVideoIndex === undefined
            ) {
              // Last resort: if we have no videoId or index, but video ended, try to find first incomplete module
              // This handles cases where YouTube API doesn't provide playlist info
              if (videoEnded) {
                const firstIncomplete = modules.find((m) => !m.isCompleted);
                if (firstIncomplete) {
                  matchingModule = firstIncomplete;
                  console.log(
                    `[Playlist Progress] ⚠️ No videoId/index available, using first incomplete module: '${firstIncomplete.title}'`
                  );
                }
              }
            }

            // Mark module as complete if found
            if (matchingModule) {
              // Respect manual unchecks - if user manually unchecked, don't auto-check
              if (manuallyUncheckedModulesRef.current.has(matchingModule.id)) {
                console.log(
                  `[Playlist Progress] ⚠️ Skipping auto-complete for '${matchingModule.title}' - manually unchecked`
                );
              } else if (!matchingModule.isCompleted) {
                // Skip if we just processed this module (prevent rapid toggling)
                const lastProcessed =
                  completedModulesThisSessionRef.current.get(matchingModule.id);
                const timeSinceLastProcess = lastProcessed
                  ? Date.now() - lastProcessed
                  : Infinity;

                // Only process if enough time has passed (at least 1 second)
                if (timeSinceLastProcess >= 1000) {
                  // Mark as processed
                  completedModulesThisSessionRef.current.set(
                    matchingModule.id,
                    Date.now()
                  );

                  try {
                    console.log(
                      `[Playlist Progress] ✅ Marking module '${matchingModule.title}' as complete (playlist video ${currentPlaylistVideoId} ${statusText})`
                    );

                    // Use set-completion endpoint for persistence
                    await courseApi.setModuleCompletion(
                      matchingModule.id,
                      true
                    );

                    // Update local state immediately
                    setCourse((prev) => {
                      if (!prev) return prev;
                      const updatedModules = prev.modules.map((m) =>
                        m.id === matchingModule.id
                          ? { ...m, isCompleted: true }
                          : m
                      );

                      // Recalculate progress
                      const totalModules = updatedModules.length;
                      const completedModules = updatedModules.filter(
                        (m) => m.isCompleted
                      ).length;
                      const progressPercentage =
                        totalModules > 0
                          ? Math.round((completedModules / totalModules) * 100)
                          : 0;

                      return {
                        ...prev,
                        modules: updatedModules,
                        progressPercentage: progressPercentage,
                        completedModules: completedModules,
                      };
                    });

                    // Sync with backend after a short delay
                    setTimeout(() => fetchCourse({ silent: true }), 500);

                    // Update scheduler when module completes
                    try {
                      await maybeAdjustSchedule(
                        "module_completed",
                        currentTime,
                        duration
                      );
                    } catch (scheduleErr) {
                      console.warn("Schedule update failed:", scheduleErr);
                    }
                  } catch (err) {
                    // Remove from processed set on error so we can retry
                    completedModulesThisSessionRef.current.delete(
                      matchingModule.id
                    );
                    console.error(
                      `❌ Failed to mark playlist module '${matchingModule.title}' as complete:`,
                      err
                    );
                  }
                }
              } else {
                console.log(
                  `[Playlist Progress] Module '${matchingModule.title}' already completed`
                );
              }
            } else {
              const videoIdStr =
                currentPlaylistVideoId ||
                `index-${
                  currentPlaylistVideoIndex !== undefined
                    ? currentPlaylistVideoIndex + 1
                    : "unknown"
                }`;
              console.log(
                `[Playlist Progress] ⚠️ No matching module found for playlist video ${videoIdStr} (index: ${currentPlaylistVideoIndex})`
              );
            }
          }
        }

        // Mark submodule complete when ~85% of its time range is watched (for non-YouTube videos)
        if (
          currentSubModule &&
          !currentSubModule.isCompleted &&
          currentSubModuleIndex >= 0 &&
          playback.kind !== "youtube"
        ) {
          const item = subModuleTimeMap[currentSubModuleIndex];
          if (item.duration > 0) {
            const subModuleProgress =
              ((currentTime - item.startTime) / item.duration) * 100;
            if (subModuleProgress >= 85) {
              try {
                const subModules = (item.module.subModules || []).sort(
                  (a, b) => (a.order || 0) - (b.order || 0)
                );
                const subModuleIndex = subModules.findIndex(
                  (sm) => sm.id === currentSubModule.id
                );
                if (subModuleIndex >= 0) {
                  await courseApi.updateChapterProgress(
                    course.id,
                    currentSubModule.title,
                    subModuleIndex,
                    100
                  );
                  console.log(
                    `[Progress] SubModule '${
                      currentSubModule.title
                    }' marked complete (${subModuleProgress.toFixed(1)}%)`
                  );

                  // Update local state optimistically and check if module should be marked complete
                  setCourse((prev) => {
                    if (!prev) return prev;
                    const updatedModules = prev.modules.map((m) => {
                      if (m.id === item.module.id) {
                        const updatedSubModules = (m.subModules || []).map(
                          (sm) =>
                            sm.id === currentSubModule.id
                              ? { ...sm, isCompleted: true }
                              : sm
                        );

                        // Check if all submodules are now complete
                        const allSubModulesComplete =
                          updatedSubModules.length > 0 &&
                          updatedSubModules.every((sm) => sm.isCompleted);

                        // If all submodules complete, mark module complete and update backend
                        if (allSubModulesComplete && !m.isCompleted) {
                          courseApi
                            .toggleModuleCompletion(m.id)
                            .then(() => {
                              console.log(
                                `[Progress] ✅ Module '${m.title}' marked complete (all submodules done)`
                              );
                              fetchCourse({ silent: true });
                            })
                            .catch((err) => {
                              console.warn(
                                `Failed to mark module ${m.id} as complete:`,
                                err
                              );
                            });

                          return {
                            ...m,
                            subModules: updatedSubModules,
                            isCompleted: true,
                          };
                        }

                        return {
                          ...m,
                          subModules: updatedSubModules,
                        };
                      }
                      return m;
                    });

                    return {
                      ...prev,
                      modules: updatedModules,
                    };
                  });

                  // Refresh course data to sync with backend
                  setTimeout(() => fetchCourse({ silent: true }), 300);
                }
              } catch (err) {
                console.warn(
                  `Failed to mark submodule ${currentSubModule.id}:`,
                  err
                );
              }
            }
          }
        }

        // Check if any module should be marked complete (all submodules done)
        // This handles cases where submodules were completed via seek or other means
        for (const module of modules) {
          if (!module.isCompleted) {
            const subModules = (module.subModules || []).sort(
              (a, b) => (a.order || 0) - (b.order || 0)
            );
            if (
              subModules.length > 0 &&
              subModules.every((sm) => sm.isCompleted)
            ) {
              try {
                await courseApi.toggleModuleCompletion(module.id);
                console.log(
                  `[Progress] ✅ Module '${module.title}' marked complete (all submodules done)`
                );

                setCourse((prev) => {
                  if (!prev) return prev;
                  const updatedModules = prev.modules.map((m) =>
                    m.id === module.id ? { ...m, isCompleted: true } : m
                  );

                  // Calculate new progress percentage
                  const totalModules = updatedModules.length;
                  const completedModules = updatedModules.filter(
                    (m) => m.isCompleted
                  ).length;
                  const progressPercentage =
                    totalModules > 0
                      ? Math.round((completedModules / totalModules) * 100)
                      : 0;

                  return {
                    ...prev,
                    modules: updatedModules,
                    progressPercentage: progressPercentage,
                  };
                });

                setTimeout(() => fetchCourse({ silent: true }), 500);

                // Trigger scheduler update
                try {
                  await maybeAdjustSchedule(
                    "module_completed",
                    currentTime,
                    duration
                  );
                } catch (scheduleErr) {
                  console.warn("Failed to update schedule:", scheduleErr);
                }
              } catch (err) {
                console.warn(
                  `Failed to mark module ${module.id} as complete:`,
                  err
                );
              }
            }
          }
        }

        // IMPROVED: Handle playlist video progress and completion
        // For playlists, each video is a module - track progress based on current video
        if (playback.playlistId && playlistVideoId) {
          // Find module that matches the current playlist video
          const currentPlaylistModule = modules.find((m) => {
            try {
              const notes = m.notes || m.Notes || "";
              if (notes) {
                const metadata = JSON.parse(notes);
                return metadata.videoId === playlistVideoId;
              }
            } catch (e) {
              // Ignore parse errors
            }
            return false;
          });

          if (currentPlaylistModule && !currentPlaylistModule.isCompleted) {
            // For playlist videos, mark complete when video ends or reaches 80% (playlist-specific threshold)
            const shouldComplete =
              videoEnded || (duration > 0 && percent >= 80);

            if (shouldComplete) {
              try {
                await courseApi.toggleModuleCompletion(
                  currentPlaylistModule.id
                );
                console.log(
                  `[Playlist Progress] ✅ Module '${
                    currentPlaylistModule.title
                  }' marked complete (video: ${playlistVideoId}, ${
                    videoEnded ? "ended" : `${percent.toFixed(1)}% watched`
                  })`
                );

                // Update local state and progress
                setCourse((prev) => {
                  if (!prev) return prev;
                  const updatedModules = prev.modules.map((m) =>
                    m.id === currentPlaylistModule.id
                      ? { ...m, isCompleted: true }
                      : m
                  );

                  // Calculate new progress percentage
                  const totalModules = updatedModules.length;
                  const completedModules = updatedModules.filter(
                    (m) => m.isCompleted
                  ).length;
                  const progressPercentage =
                    totalModules > 0
                      ? Math.round((completedModules / totalModules) * 100)
                      : 0;

                  return {
                    ...prev,
                    modules: updatedModules,
                    progressPercentage: progressPercentage,
                  };
                });

                // Refresh course data
                setTimeout(() => fetchCourse({ silent: true }), 500);

                // Trigger scheduler update
                try {
                  await maybeAdjustSchedule(
                    "playlist_module_completed",
                    currentTime,
                    duration
                  );
                } catch (scheduleErr) {
                  console.warn(
                    "Failed to update schedule on playlist module completion:",
                    scheduleErr
                  );
                }
              } catch (err) {
                console.warn(
                  `Failed to mark playlist module ${currentPlaylistModule.id}:`,
                  err
                );
              }
            }
          }
        }

        // Also handle playlist video end event (legacy support)
        if (
          playback.playlistId &&
          videoEnded &&
          playlistVideoIndex !== undefined
        ) {
          const sortedModules = modules.sort(
            (a, b) => (a.order || 0) - (b.order || 0)
          );
          if (
            playlistVideoIndex >= 0 &&
            playlistVideoIndex < sortedModules.length
          ) {
            const module = sortedModules[playlistVideoIndex];
            if (module && !module.isCompleted) {
              try {
                await courseApi.toggleModuleCompletion(module.id);
                console.log(
                  `[Playlist] Module '${module.title}' marked complete (video ${
                    playlistVideoIndex + 1
                  } ended)`
                );

                setCourse((prev) => {
                  if (!prev) return prev;
                  const updatedModules = prev.modules.map((m) =>
                    m.id === module.id ? { ...m, isCompleted: true } : m
                  );

                  const totalModules = updatedModules.length;
                  const completedModules = updatedModules.filter(
                    (m) => m.isCompleted
                  ).length;
                  const progressPercentage =
                    totalModules > 0
                      ? Math.round((completedModules / totalModules) * 100)
                      : 0;

                  return {
                    ...prev,
                    modules: updatedModules,
                    progressPercentage: progressPercentage,
                  };
                });

                setTimeout(() => fetchCourse({ silent: true }), 500);

                // Trigger scheduler update
                try {
                  await maybeAdjustSchedule(
                    "playlist_video_ended",
                    currentTime,
                    duration
                  );
                } catch (scheduleErr) {
                  console.warn("Failed to update schedule:", scheduleErr);
                }
              } catch (err) {
                console.warn(`Failed to mark playlist module:`, err);
              }
            }
          }
        }

        // Debounced backend sync for progress updates
        await debouncedBackendSync(course.id, currentTime, reason);

        // Update schedule dynamically based on completed submodules
        await maybeAdjustSchedule(reason, currentTime, duration);
      } catch (err) {
        console.error("syncPlayback error:", err);
        setError(err.message || "Failed to update progress");
      }
    },
    [
      course,
      fetchCourse,
      maybeAdjustSchedule,
      playbackStats.duration,
      debouncedBackendSync,
    ]
  );

  const handleUpdateCourse = async (updates) => {
    try {
      // Use editCourse endpoint which handles full course updates including modules
      await courseApi.editCourse(id, updates);
      // Refresh course data to get updated modules
      await fetchCourse({ silent: true });
      setShowEditModal(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    setError("");
    try {
      await courseApi.updateCourse(id, { notes: noteDraft });
      setCourse((prev) => (prev ? { ...prev, notes: noteDraft } : prev));
      setEditingNotes(false);
    } catch (err) {
      setError(err.message || "Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const moduleTotals = () => {
    const flat = flatModules;
    const total = flat.length;
    const completed = flat.filter((m) => m.isCompleted).length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percent };
  };

  // Helper function to detect if course is YouTube-based
  const isYouTubeCourse = useCallback(() => {
    if (!course?.externalLinks || course.externalLinks.length === 0)
      return false;
    return course.externalLinks.some(
      (link) =>
        link.platform?.toLowerCase().includes("youtube") ||
        link.url?.includes("youtube.com") ||
        link.url?.includes("youtu.be")
    );
  }, [course]);

  // Helper function to detect if course is external (non-YouTube)
  const isExternalCourse = useCallback(() => {
    if (!course?.externalLinks || course.externalLinks.length === 0)
      return false;
    return !isYouTubeCourse();
  }, [course, isYouTubeCourse]);

  const handleToggleModules = async (moduleIds, targetCompleted) => {
    try {
      setError("");

      // Optimistic local update to avoid page reload flicker
      setCourse((prev) => {
        if (!prev) return prev;
        const ids = new Set(moduleIds);
        const updatedModules = (prev.modules || []).map((mod) => {
          const topHit = ids.has(mod.id);
          const updatedSubs = (mod.subModules || []).map((sm) => ({
            ...sm,
            isCompleted:
              ids.has(sm.id) || topHit ? targetCompleted : sm.isCompleted,
          }));
          return {
            ...mod,
            isCompleted: topHit ? targetCompleted : mod.isCompleted,
            subModules: updatedSubs,
          };
        });
        return { ...prev, modules: updatedModules };
      });

      // Track manual unchecks - if user manually unchecks, prevent auto-tracking from re-checking
      if (!targetCompleted) {
        moduleIds.forEach((id) => {
          manuallyUncheckedModulesRef.current.add(id);
          console.log(
            `[Manual Override] Module ${id} manually unchecked - will prevent auto-tracking`
          );
        });
      } else {
        // If user manually checks, remove from manually unchecked set (allow auto-tracking again)
        moduleIds.forEach((id) => {
          manuallyUncheckedModulesRef.current.delete(id);
          console.log(
            `[Manual Override] Module ${id} manually checked - allowing auto-tracking`
          );
        });
      }

      // If quizzes are enabled for this course: show quiz modal when marking complete
      if (course?.isQuizEnabled && targetCompleted && moduleIds.length > 0) {
        // Find the top-level module that was toggled (the one that is not a submodule)
        // In this context, top-level modules have no parentModuleId
        const toggledModuleId = (() => {
          // If only one module, use it
          if (moduleIds.length === 1) return moduleIds[0];
          // Otherwise, prefer a module with no parentModuleId
          const topLevel = flatModules.find(
            (m) => moduleIds.includes(m.id) && !m.parentModuleId
          );
          return topLevel ? topLevel.id : moduleIds[0];
        })();
        // Validate moduleId exists and is a valid number
        if (
          toggledModuleId === null ||
          toggledModuleId === undefined ||
          toggledModuleId === "undefined"
        ) {
          setError("Invalid module ID. Please try again.");
          return;
        }
        const numericModuleId =
          typeof toggledModuleId === "number"
            ? toggledModuleId
            : parseInt(toggledModuleId, 10);
        if (isNaN(numericModuleId)) {
          setError("Invalid module ID. Please try again.");
          return;
        }
        // Find the module in the flat list
        const originalModule = flatModules.find(
          (m) => m.id === numericModuleId || m.id === toggledModuleId
        );
        if (!originalModule) {
          setError("Module not found. Please refresh and try again.");
          return;
        }

        // Only show quiz modal for top-level modules (no parent). Submodules
        // should be allowed to be marked complete directly.
        if (!originalModule.parentModuleId) {
          setQuizModal({
            isOpen: true,
            moduleId: numericModuleId,
            moduleTitle: originalModule.title || "Module",
          });
          // Revert optimistic update for this module only
          setCourse((prev) => {
            if (!prev) return prev;
            const ids = new Set([numericModuleId]);
            const updatedModules = (prev.modules || []).map((mod) => {
              const topHit = ids.has(mod.id);
              const updatedSubs = (mod.subModules || []).map((sm) => ({
                ...sm,
                isCompleted: ids.has(sm.id) || topHit ? false : sm.isCompleted,
              }));
              return {
                ...mod,
                isCompleted: topHit ? false : mod.isCompleted,
                subModules: updatedSubs,
              };
            });
            return { ...prev, modules: updatedModules };
          });
          return;
        }
      }

      const moduleMap = new Map(flatModules.map((m) => [m.id, m]));
      const toToggle = moduleIds.filter(
        (mid) => moduleMap.get(mid)?.isCompleted !== targetCompleted
      );

      // Use set-completion for manual toggles to ensure persistence
      await Promise.all(
        toToggle.map((mid) => {
          const currentState = moduleMap.get(mid)?.isCompleted;
          return courseApi.setModuleCompletion(mid, !currentState);
        })
      );

      // Refresh quietly to ensure totals stay accurate
      fetchCourse({ silent: true });
    } catch (err) {
      setError(err?.message || "Failed to update module");
      fetchCourse({ silent: true });
    }
  };

  const flatModules = useMemo(() => {
    if (!course?.modules) return [];
    const roots = course.modules || [];
    const result = [];
    roots.forEach((root) => {
      result.push({ ...root, parentModuleId: null });
      (root.subModules || []).forEach((sub) => {
        result.push({ ...sub, parentModuleId: root.id });
      });
    });
    return result;
  }, [course]);

  const sourceLink = useMemo(
    () => pickSourceLink(course?.externalLinks || []),
    [course]
  );

  const playback = useMemo(
    () => detectPlayback(sourceLink?.url),
    [sourceLink?.url]
  );

  const loadCourse = useCallback(() => {
    setError("");
    setLoading(true);
    fetchCourse();
  }, [fetchCourse]);

  if (loading) {
    return (
      <div className={styles.container}>
        <Loading message="Loading course details..." />
      </div>
    );
  }

  if (error && !course) {
    return (
      <div className={styles.container}>
        <ErrorMessage
          error={error}
          onRetry={loadCourse}
          title="Failed to load course"
        />
      </div>
    );
  }

  const reminderLastSentText = course?.lastReminderSentAt
    ? new Date(course.lastReminderSentAt).toLocaleString()
    : "Not sent yet";

  const isCourseComplete =
    typeof course?.progressPercentage === "number" &&
    Math.round(course.progressPercentage) >= 100;

  const certificateRecipientName = course?.userFullName || "Learner";
  const certificateCompletionDate = course?.lastStudiedAt
    ? new Date(course.lastStudiedAt).toLocaleDateString()
    : new Date().toLocaleDateString();

  const escapeXml = (unsafe = "") =>
    String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const downloadSvg = (svgText, filename) => {
    const blob = new Blob([svgText], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const buildCertificateSvg = () => {
    const recipient = escapeXml(certificateRecipientName);
    const title = escapeXml(course?.title || "");
    const dateText = escapeXml(certificateCompletionDate);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0e27"/>
      <stop offset="100%" stop-color="#132a5a"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  <rect x="80" y="80" width="1040" height="640" rx="24" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
  <text x="600" y="185" text-anchor="middle" fill="#ffffff" font-size="44" font-family="Arial, Helvetica, sans-serif" font-weight="700">Certificate of Completion</text>
  <text x="600" y="250" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="22" font-family="Arial, Helvetica, sans-serif">This certifies that</text>
  <text x="600" y="330" text-anchor="middle" fill="#ffffff" font-size="40" font-family="Arial, Helvetica, sans-serif" font-weight="700">${recipient}</text>
  <text x="600" y="400" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="22" font-family="Arial, Helvetica, sans-serif">has successfully completed</text>
  <text x="600" y="480" text-anchor="middle" fill="#ffffff" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="600">${title}</text>
  <text x="600" y="585" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="20" font-family="Arial, Helvetica, sans-serif">Date: ${dateText}</text>
  <text x="600" y="655" text-anchor="middle" fill="rgba(255,255,255,0.65)" font-size="18" font-family="Arial, Helvetica, sans-serif">Learnit</text>
</svg>`;
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <Button variant="ghost" onClick={() => navigate("/app/course")}>
          <FaArrowLeft /> Back
        </Button>

        <div className={styles.title}>
          <h1>{course.title}</h1>
          <p className={styles.reminderMeta}>
            Reminder email: {course.reminderEmail || "Not set"} · Last reminder:{" "}
            {reminderLastSentText}
          </p>
          <div className={styles.meta}>
            <span
              className={`${styles.badge} ${
                styles[course.difficulty?.toLowerCase()]
              }`}
            >
              {course.difficulty}
            </span>
            <span
              className={`${styles.badge} ${
                styles[course.priority?.toLowerCase()]
              }`}
            >
              {course.priority}
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <div className={styles.timer}>
            <FaClock /> {moduleTotals().completed}/{moduleTotals().total}{" "}
            modules · {moduleTotals().percent}%
          </div>
          <Button variant="secondary" onClick={() => setShowShareModal(true)}>
            <FaShare /> Share
          </Button>
          <Button variant="primary" onClick={() => setShowEditModal(true)}>
            <FaCog /> Edit
          </Button>
        </div>
      </header>

      {error && <div className={ui.errorBanner}>{error}</div>}

      <div className={styles.content}>
        <main className={styles.main}>
          {(() => {
            const url = String(sourceLink?.url || "");
            const isYouTube =
              url.includes("youtube.com") ||
              url.includes("youtu.be") ||
              String(sourceLink?.platform || "")
                .toLowerCase()
                .includes("youtube") ||
              playback.kind === "youtube";

            if (!isYouTube) return null;

            return (
              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2>
                    <FaPlay /> Course Content
                  </h2>
                  {sourceLink?.url && (
                    <a
                      className={styles.sourceLink}
                      href={sourceLink.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source
                    </a>
                  )}
                </div>

                <div className={styles.playerShell}>
                  {playback.kind === "youtube" ? (
                    <YouTubePlayer
                      key={`yt-${
                        playback.videoId || playback.playlistId || "default"
                      }`}
                      playback={playback}
                      courseId={course.id}
                      onProgress={syncPlayback}
                      course={course}
                    />
                  ) : (
                    <p className={styles.subtle}>
                      No YouTube content available for this course.
                    </p>
                  )}
                </div>

                {syncingProgress && (
                  <p className={styles.syncHint}>Saving watch progress...</p>
                )}
              </section>
            );
          })()}

          <section className={styles.section}>
            <ModuleTree
              modules={flatModules}
              isExternalCourse={
                course?.externalLinks &&
                course.externalLinks.length > 0 &&
                !course.externalLinks.some(
                  (link) =>
                    link.platform?.toLowerCase().includes("youtube") ||
                    link.url?.includes("youtube.com") ||
                    link.url?.includes("youtu.be")
                )
              }
              onUpdate={async (moduleId, updates) => {
                await courseApi.updateModule(moduleId, updates);
                fetchCourse();
              }}
              onToggleCompletion={handleToggleModules}
              onResetCompletion={async (moduleId) => {
                await courseApi.setModuleCompletion(moduleId, false);
                fetchCourse({ silent: true });
              }}
              isQuizEnabled={course?.isQuizEnabled}
              onAdd={async (payload) => {
                await courseApi.createModule(id, payload);
                fetchCourse();
              }}
            />
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>
                <FaStickyNote /> Notes
              </h2>
              <div className={styles.noteActions}>
                {editingNotes ? (
                  <>
                    <Button
                      variant="primary"
                      onClick={handleSaveNotes}
                      disabled={savingNotes}
                    >
                      <FaSave /> {savingNotes ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditingNotes(false);
                        setNoteDraft(course?.notes || "");
                      }}
                    >
                      <FaTimes /> Cancel
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setEditingNotes(true)}>
                    <FaEdit /> Edit
                  </Button>
                )}
              </div>
            </div>

            {editingNotes ? (
              <div className={styles.notesEditor}>
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={8}
                  placeholder="Write notes in Markdown..."
                />
                <p className={styles.noteHint}>
                  Markdown supported (bold, lists, links).
                </p>
              </div>
            ) : (
              <div className={styles.notePreview}>
                {noteDraft?.trim() ? (
                  <ReactMarkdown>{noteDraft}</ReactMarkdown>
                ) : (
                  <p className={styles.notesEmpty}>
                    No notes yet. Click Edit to add some.
                  </p>
                )}
              </div>
            )}
          </section>
        </main>

        <aside className={styles.sidebar}>
          <section className={styles.section}>
            <h2>Reminders</h2>
            <p className={styles.subtle}>Send a test email to verify SMTP.</p>
            <Button
              variant="primary"
              disabled={sendingTestReminder}
              onClick={async () => {
                try {
                  setSendingTestReminder(true);
                  await courseApi.sendTestReminder(id);
                  toast.success("Test reminder email sent.");
                  fetchCourse();
                } catch (err) {
                  toast.error(err.message || "Failed to send test reminder.");
                } finally {
                  setSendingTestReminder(false);
                }
              }}
            >
              {sendingTestReminder ? "Sending..." : "Send test reminder"}
            </Button>
          </section>
          <section className={styles.section}>
            <h2>
              <FaClock /> Progress
            </h2>
            <ProgressCard
              progressPercentage={course.progressPercentage}
              completedModules={course.completedModules}
              totalModules={course.totalModules}
              totalHours={course.totalEstimatedHours}
              completedHours={course.completedHours}
              hoursRemaining={course.hoursRemaining}
            />
          </section>

          <section className={styles.section}>
            <h2>e-Certificate</h2>
            {isCourseComplete ? (
              <>
                <p className={styles.subtle}>
                  Recipient: {certificateRecipientName}
                </p>
                <Button
                  variant="primary"
                  disabled={issuingCertificate}
                  onClick={async () => {
                    try {
                      setIssuingCertificate(true);

                      if (!course.certificateIssuedAt) {
                        await courseApi.issueCertificate(id);
                        await fetchCourse();
                      }

                      const svg = buildCertificateSvg();
                      downloadSvg(
                        svg,
                        `learnit-certificate-${id}.svg`
                      );
                      toast.success("E-certificate ready.");
                    } catch (err) {
                      toast.error(
                        err.message || "Failed to generate certificate."
                      );
                    } finally {
                      setIssuingCertificate(false);
                    }
                  }}
                >
                  {course.certificateIssuedAt
                    ? "Download e-certificate"
                    : issuingCertificate
                      ? "Preparing..."
                      : "Get e-certificate"}
                </Button>
              </>
            ) : (
              <p className={styles.subtle}>
                Complete the course to unlock your e-certificate.
              </p>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>
                <FaLink /> Resources
              </h2>
              <Button
                variant="primary"
                onClick={async () => {
                  await courseApi.addExternalLink(id, {
                    platform: "Website",
                    title: "",
                    url: "",
                  });
                  fetchCourse();
                }}
              >
                + Add
              </Button>
            </div>
            <ExternalLinks
              links={course.externalLinks || []}
              onUpdate={async (linkId, updates) => {
                await courseApi.updateExternalLink(linkId, updates);
                fetchCourse();
              }}
              onDelete={async (linkId) => {
                await courseApi.deleteExternalLink(linkId);
                fetchCourse();
              }}
            />
          </section>
        </aside>
      </div>

      {showEditModal && (
        <EditCourseModal
          course={course}
          onSave={handleUpdateCourse}
          onCancel={() => setShowEditModal(false)}
        />
      )}

      <ShareToClassroomModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        courseId={course?.id}
        onSubmit={(count) => {
          toast.success(`Successfully shared course to ${count} classroom(s)!`);
          setShowShareModal(false);
        }}
      />

      {/* Quiz Modal for External Courses */}
      <QuizModal
        moduleId={quizModal.moduleId}
        moduleTitle={quizModal.moduleTitle}
        isOpen={quizModal.isOpen}
        onClose={() =>
          setQuizModal({ isOpen: false, moduleId: null, moduleTitle: "" })
        }
        onQuizPassed={async () => {
          // Mark the module as complete after quiz is passed
          if (quizModal.moduleId) {
            try {
              console.log(
                `[Quiz] Quiz passed for module ${quizModal.moduleId}, marking as complete`
              );
              await courseApi.setModuleCompletion(quizModal.moduleId, true);

              // Update local state optimistically
              setCourse((prev) => {
                if (!prev) return prev;
                const updatedModules = prev.modules.map((m) => {
                  // Check if this is the module or a submodule
                  if (m.id === quizModal.moduleId) {
                    return { ...m, isCompleted: true };
                  }
                  // Check submodules
                  const updatedSubs = (m.subModules || []).map((sm) =>
                    sm.id === quizModal.moduleId
                      ? { ...sm, isCompleted: true }
                      : sm
                  );
                  if (updatedSubs.some((sm) => sm.id === quizModal.moduleId)) {
                    return { ...m, subModules: updatedSubs };
                  }
                  return m;
                });

                // Recalculate progress
                const totalModules = updatedModules.length;
                const completedModules = updatedModules.filter(
                  (m) => m.isCompleted
                ).length;
                const progressPercentage =
                  totalModules > 0
                    ? Math.round((completedModules / totalModules) * 100)
                    : 0;

                return {
                  ...prev,
                  modules: updatedModules,
                  progressPercentage: progressPercentage,
                  completedModules: completedModules,
                };
              });

              // Refresh course data to ensure consistency
              await fetchCourse({ silent: true });
            } catch (err) {
              console.error(
                `[Quiz] Failed to mark module ${quizModal.moduleId} as complete:`,
                err
              );
              setError(
                err.message ||
                  "Failed to mark module as complete. Please try again."
              );
            }
          }
        }}
      />
    </div>
  );
}

function InlineVideo({ src, courseId, onProgress, course }) {
  const videoRef = useRef(null);
  const intervalRef = useRef(null);
  const lastCheckRef = useRef(0);

  // Track active study session for streak tracking
  const activeStudySessionRef = useRef(null);
  const studySessionStartTimeRef = useRef(null);

  // Helper to get storage key for playback position (persists across sessions)
  const getPlaybackStorageKey = useCallback((courseId, videoId, playlistId) => {
    return `learnit_playback_${courseId}_${videoId || playlistId || "default"}`;
  }, []);

  const pushProgress = useCallback(
    (reason = "timeupdate") => {
      const el = videoRef.current;
      if (!el) return;
      const { currentTime, duration } = el;

      // Always update local state for display
      const stats = {
        currentTime,
        duration,
        percent: percentFromTimes(currentTime, duration),
      };

      // Save to backend on: start (play), stop (paused/ended), seek, and timeupdate (for module completion checks)
      // timeupdate is needed to check if modules should be marked complete at 80%
      const shouldSave =
        reason === "play" ||
        reason === "paused" ||
        reason === "seeked" ||
        reason === "ended" ||
        reason === "timeupdate";

      if (shouldSave) {
        onProgress?.(stats, reason);
      }

      // Always save to localStorage for resume (lightweight, no backend call, persists across sessions)
      if (courseId && Number.isFinite(currentTime)) {
        try {
          const sourceLink = pickSourceLink(course?.externalLinks);
          const playback = detectPlayback(sourceLink?.url);
          const storageKey = getPlaybackStorageKey(
            courseId,
            playback.videoId,
            playback.playlistId
          );
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              currentTime,
              duration: duration || 0,
              timestamp: Date.now(),
            })
          );
        } catch (e) {
          // ignore quota / privacy errors
        }
      }
    },
    [courseId, onProgress, course, getPlaybackStorageKey]
  );

  const handlePlay = () => {
    clearInterval(intervalRef.current);
    pushProgress("play"); // Save on play

    // AUTO-START STUDY SESSION FOR STREAK TRACKING (non-YouTube videos)
    if (courseId && !activeStudySessionRef.current) {
      try {
        // Find current module (first incomplete module, or first module if all complete)
        const modules = course?.modules || [];
        const sortedModules = [...modules].sort(
          (a, b) => (a.order || 0) - (b.order || 0)
        );
        const firstIncomplete = sortedModules.find((m) => !m.isCompleted);
        const currentModuleId =
          firstIncomplete?.id ||
          (sortedModules.length > 0 ? sortedModules[0].id : null);

        console.log(
          `[Streak] Attempting to create study session for course ${courseId}, module ${
            currentModuleId || "none"
          }`
        );
        courseApi
          .startStudySession(courseId, currentModuleId)
          .then((session) => {
            if (session && session.id) {
              activeStudySessionRef.current = session.id;
              studySessionStartTimeRef.current = Date.now();
              console.log(
                `[Streak] ✅ Auto-created study session ${
                  session.id
                } for course ${courseId} at ${new Date().toLocaleTimeString()}`
              );
            } else {
              console.warn(
                `[Streak] Session created but no ID returned:`,
                session
              );
            }
          })
          .catch(async (err) => {
            // If session already exists, try to get the active session
            if (
              err?.response?.status === 400 ||
              err?.message?.includes("already exists")
            ) {
              console.log(
                `[Streak] Session already exists for course ${courseId} - fetching existing session...`
              );
              try {
                const sessions = await courseApi.getCourseSessions(courseId);
                const activeSession = Array.isArray(sessions)
                  ? sessions.find((s) => {
                      const isCompleted =
                        s.isCompleted === true || s.IsCompleted === true;
                      const hasEndTime = s.endTime || s.EndTime;
                      return !isCompleted && !hasEndTime;
                    })
                  : null;

                if (activeSession) {
                  const sessionId = activeSession.id || activeSession.Id;
                  const startTimeStr =
                    activeSession.startTime || activeSession.StartTime;

                  if (sessionId) {
                    activeStudySessionRef.current = sessionId;
                    const startTime = startTimeStr
                      ? new Date(startTimeStr).getTime()
                      : Date.now();
                    studySessionStartTimeRef.current = startTime;
                    const duration = (Date.now() - startTime) / 1000 / 60; // minutes
                    console.log(
                      `[Streak] ✅ Using existing active session ${sessionId} (started ${duration.toFixed(
                        1
                      )} minutes ago)`
                    );
                  }
                }
              } catch (fetchErr) {
                console.warn(
                  `[Streak] Failed to get existing sessions:`,
                  fetchErr
                );
              }
            } else {
              console.error(`[Streak] ❌ Failed to create study session:`, err);
            }
          });
      } catch (err) {
        console.warn(`[Streak] Error creating study session:`, err);
      }
    }

    // Don't set interval - progress will be saved on pause/seeked/ended only
  };

  const handleSeeking = () => {
    clearInterval(intervalRef.current);
  };

  const handleSeeked = () => {
    pushProgress("seeked"); // Save on seek - important for progress tracking
    // Don't restart interval, just let it play
  };

  const handlePause = () => {
    clearInterval(intervalRef.current);
    pushProgress("paused");

    // AUTO-COMPLETE STUDY SESSION WHEN PAUSED (if watched for minimum duration)
    if (activeStudySessionRef.current && courseId) {
      const sessionId = activeStudySessionRef.current;
      const startTime = studySessionStartTimeRef.current;
      const watchedDuration = startTime
        ? (Date.now() - startTime) / 1000 / 60
        : 0; // minutes
      const MIN_SESSION_MINUTES = 1; // Minimum 1 minute to count toward streak

      if (watchedDuration >= MIN_SESSION_MINUTES) {
        console.log(
          `[Streak] Video paused after ${watchedDuration.toFixed(
            1
          )} minutes - completing session ${sessionId}`
        );
        courseApi
          .stopStudySession(
            sessionId,
            `Auto-completed: Video paused (watched ${watchedDuration.toFixed(
              1
            )} minutes)`
          )
          .then(() => {
            console.log(
              `[Streak] ✅ Auto-completed study session ${sessionId} on pause`
            );
            activeStudySessionRef.current = null;
            studySessionStartTimeRef.current = null;
          })
          .catch((err) => {
            console.warn(
              `[Streak] Failed to complete study session on pause:`,
              err
            );
          });
      } else {
        console.log(
          `[Streak] Video paused but session too short (${watchedDuration.toFixed(
            1
          )} min < ${MIN_SESSION_MINUTES} min) - keeping session active`
        );
      }
    }
  };

  const handleEnded = () => {
    clearInterval(intervalRef.current);
    pushProgress("ended");

    // AUTO-COMPLETE STUDY SESSION FOR STREAK TRACKING (when video ends)
    if (activeStudySessionRef.current && courseId) {
      const sessionId = activeStudySessionRef.current;
      const startTime = studySessionStartTimeRef.current;
      const watchedDuration = startTime
        ? (Date.now() - startTime) / 1000 / 60
        : 0; // minutes
      const MIN_SESSION_MINUTES = 1; // Minimum 1 minute to count toward streak

      if (watchedDuration >= MIN_SESSION_MINUTES) {
        courseApi
          .stopStudySession(sessionId, "Auto-completed: Video ended")
          .then(() => {
            console.log(
              `[Streak] ✅ Auto-completed study session ${sessionId} (watched ${watchedDuration.toFixed(
                1
              )} minutes)`
            );
            activeStudySessionRef.current = null;
            studySessionStartTimeRef.current = null;
          })
          .catch((err) => {
            console.warn(`[Streak] Failed to complete study session:`, err);
            activeStudySessionRef.current = null;
            studySessionStartTimeRef.current = null;
          });
      } else {
        // Session too short - complete anyway
        console.log(
          `[Streak] Session ${sessionId} too short (${watchedDuration.toFixed(
            1
          )} min < ${MIN_SESSION_MINUTES} min), completing anyway`
        );
        courseApi
          .stopStudySession(
            sessionId,
            "Auto-completed: Video ended (short session)"
          )
          .then(() => {
            activeStudySessionRef.current = null;
            studySessionStartTimeRef.current = null;
          })
          .catch((err) => {
            console.warn(`[Streak] Failed to complete short session:`, err);
            activeStudySessionRef.current = null;
            studySessionStartTimeRef.current = null;
          });
      }
    }
  };

  useEffect(() => {
    // On mount, attempt to restore last position
    const el = videoRef.current;
    if (courseId && el) {
      const restorePosition = () => {
        try {
          const sourceLink = pickSourceLink(course?.externalLinks);
          const playback = detectPlayback(sourceLink?.url);
          const storageKey = `learnit_playback_${courseId}_${
            playback.videoId || playback.playlistId || "default"
          }`;
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            const saved = JSON.parse(raw);
            if (
              Number.isFinite(saved.currentTime) &&
              saved.currentTime > 0 &&
              saved.duration > 0
            ) {
              const seekTime = Math.min(saved.currentTime, saved.duration - 1);
              if (el.readyState >= 1) {
                el.currentTime = seekTime;
                console.log(`[Video] Resumed at ${seekTime.toFixed(1)}s`);
              } else {
                const onLoadedMetadata = () => {
                  if (el.readyState >= 1) {
                    el.currentTime = seekTime;
                    console.log(`[Video] Resumed at ${seekTime.toFixed(1)}s`);
                  }
                  el.removeEventListener("loadedmetadata", onLoadedMetadata);
                };
                el.addEventListener("loadedmetadata", onLoadedMetadata, {
                  once: true,
                });
              }
            }
          }
        } catch (e) {
          console.warn("Failed to restore video position:", e);
        }
      };

      restorePosition();
      el.addEventListener("loadedmetadata", restorePosition, { once: true });
    }

    // Save position when tab becomes hidden
    const handleVisibilityChange = () => {
      if (document.hidden && activeStudySessionRef.current && courseId) {
        const sessionId = activeStudySessionRef.current;
        const startTime = studySessionStartTimeRef.current;
        const watchedDuration = startTime
          ? (Date.now() - startTime) / 1000 / 60
          : 0; // minutes
        const MIN_SESSION_MINUTES = 1;

        if (watchedDuration >= MIN_SESSION_MINUTES) {
          courseApi
            .stopStudySession(
              sessionId,
              `Auto-completed: Tab hidden (watched ${watchedDuration.toFixed(
                1
              )} minutes)`
            )
            .then(() => {
              console.log(
                `[Streak] ✅ Auto-completed study session ${sessionId} on tab hidden`
              );
              activeStudySessionRef.current = null;
              studySessionStartTimeRef.current = null;
            })
            .catch((err) => {
              console.warn(
                `[Streak] Failed to complete study session on tab hidden:`,
                err
              );
              activeStudySessionRef.current = null;
              studySessionStartTimeRef.current = null;
            });
        }
      }
    };

    // Save position when page is about to unload
    const handleBeforeUnload = () => {
      if (activeStudySessionRef.current && courseId) {
        const sessionId = activeStudySessionRef.current;
        const startTime = studySessionStartTimeRef.current;
        const watchedDuration = startTime
          ? (Date.now() - startTime) / 1000 / 60
          : 0; // minutes
        const MIN_SESSION_MINUTES = 1;

        // Use fetch with keepalive for reliable completion on page unload
        if (watchedDuration >= MIN_SESSION_MINUTES) {
          const notes = `Auto-completed: Page unload (watched ${watchedDuration.toFixed(
            1
          )} minutes)`;
          const apiBase = import.meta.env.VITE_API_URL || "";
          fetch(`${apiBase}/api/courses/sessions/${sessionId}/stop`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
            },
            body: JSON.stringify(notes),
            keepalive: true,
          }).catch(() => {}); // Ignore errors on unload
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      clearInterval(intervalRef.current);

      // AUTO-COMPLETE STUDY SESSION ON CLEANUP (for streak tracking)
      if (activeStudySessionRef.current && courseId) {
        const sessionId = activeStudySessionRef.current;
        const startTime = studySessionStartTimeRef.current;
        const watchedDuration = startTime
          ? (Date.now() - startTime) / 1000 / 60
          : 0; // minutes
        const MIN_SESSION_MINUTES = 1;

        if (watchedDuration >= MIN_SESSION_MINUTES) {
          courseApi
            .stopStudySession(sessionId, "Auto-completed: User navigated away")
            .then(() => {
              console.log(
                `[Streak] ✅ Auto-completed study session ${sessionId} on cleanup (watched ${watchedDuration.toFixed(
                  1
                )} minutes)`
              );
            })
            .catch((err) => {
              console.warn(
                `[Streak] Failed to complete study session on cleanup:`,
                err
              );
            });
        } else {
          // Session too short - complete anyway
          courseApi
            .stopStudySession(
              sessionId,
              "Auto-completed: User navigated away (short session)"
            )
            .catch((err) => {
              console.warn(
                `[Streak] Failed to complete short session on cleanup:`,
                err
              );
            });
        }

        activeStudySessionRef.current = null;
        studySessionStartTimeRef.current = null;
      }

      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [courseId, course]);

  return (
    <video
      ref={videoRef}
      src={src}
      className={styles.videoPlayer}
      controls
      onPlay={handlePlay}
      onPause={handlePause}
      onEnded={handleEnded}
      onTimeUpdate={() => {
        const el = videoRef.current;
        if (!el || !courseId) return;

        const { currentTime, duration } = el;
        if (!Number.isFinite(currentTime) || currentTime < 0) return;

        // Save to localStorage for resume (always, lightweight)
        try {
          const sourceLink = pickSourceLink(course?.externalLinks);
          const playback = detectPlayback(sourceLink?.url);
          const storageKey = `learnit_playback_${courseId}_${
            playback.videoId || playback.playlistId || "default"
          }`;
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              currentTime,
              duration: duration || 0,
              timestamp: Date.now(),
            })
          );
        } catch (e) {
          // Ignore storage errors
        }

        // Check module completion periodically (every 3 seconds for more responsive updates)
        const now = Date.now();
        if (now - lastCheckRef.current > 3000) {
          lastCheckRef.current = now;
          pushProgress("timeupdate");
        }
      }}
      onSeeking={handleSeeking}
      onSeeked={handleSeeked}
    />
  );
}

const loadYouTube = (() => {
  let loadingPromise = null;
  return () => {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (loadingPromise) return loadingPromise;
    loadingPromise = new Promise((resolve) => {
      const existing = document.getElementById("youtube-iframe-api");
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      if (existing) {
        window.onYouTubeIframeAPIReady = () => resolve(window.YT);
        return;
      }
      const tag = document.createElement("script");
      tag.id = "youtube-iframe-api";
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    });
    return loadingPromise;
  };
})();

function YouTubePlayer({ playback, courseId, onProgress, course }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const intervalRef = useRef(null);
  const hasResumedRef = useRef(false);
  const isResumingRef = useRef(false); // Track if resume is in progress
  const lastSavedTimeRef = useRef(0);

  // Track active study session for streak tracking
  const activeStudySessionRef = useRef(null);
  const studySessionStartTimeRef = useRef(null);
  const studySessionUpdateIntervalRef = useRef(null);

  // Save position when leaving the page
  const savePositionOnLeave = useCallback(async () => {
    if (!playerRef.current || !courseId || !playback.videoId) return;

    try {
      let currentTime = 0;
      let duration = 0;

      try {
        if (typeof playerRef.current.getCurrentTime === "function") {
          currentTime = playerRef.current.getCurrentTime();
        }
        if (typeof playerRef.current.getDuration === "function") {
          duration = playerRef.current.getDuration();
        }
      } catch (e) {
        // SecurityError is expected - ignore
        if (e.name !== "SecurityError") {
          console.warn("Error getting player time on leave:", e);
        }
        return;
      }

      // Only save if we have a meaningful position (> 2 seconds)
      if (
        currentTime >= 2 &&
        Number.isFinite(currentTime) &&
        Number.isFinite(duration) &&
        duration > 0
      ) {
        console.log(
          `[YouTube] Saving position on page leave: ${currentTime.toFixed(
            1
          )}s / ${duration.toFixed(1)}s`
        );

        // Find current module
        let currentModule = null;
        if (course?.modules) {
          const modules = (course.modules || []).sort(
            (a, b) => (a.order || 0) - (b.order || 0)
          );
          for (const module of modules) {
            try {
              const notes = module.notes || module.Notes || "";
              if (notes) {
                const metadata = JSON.parse(notes);
                if (
                  metadata.startTimeSeconds !== undefined &&
                  currentTime >= metadata.startTimeSeconds
                ) {
                  if (
                    !currentModule ||
                    metadata.startTimeSeconds >
                      (JSON.parse(
                        currentModule.notes || currentModule.Notes || "{}"
                      ).startTimeSeconds || 0)
                  ) {
                    currentModule = module;
                  }
                }
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }

        // Save to database (use sendBeacon for reliability during page unload)
        try {
          // Get the current playlist videoId if available
          let saveVideoId = playback.videoId || "";
          if (playback.playlistId && playerRef.current) {
            try {
              const videoData = playerRef.current.getVideoData?.();
              if (videoData?.video_id) {
                saveVideoId = videoData.video_id;
              }
            } catch (e) {
              // Ignore SecurityError
            }
          }

          await courseApi.savePlaybackPosition(courseId, {
            moduleId: currentModule?.id || null,
            videoId: saveVideoId,
            playlistId: playback.playlistId || "",
            currentTimeSeconds: currentTime,
            durationSeconds: duration,
          });

          // For playlists, save the last watched videoId to localStorage for resume
          if (playback.playlistId && saveVideoId) {
            try {
              const lastVideoKey = `learnit_playlist_last_video_${courseId}_${playback.playlistId}`;
              localStorage.setItem(
                lastVideoKey,
                JSON.stringify({
                  videoId: saveVideoId,
                  timestamp: Date.now(),
                })
              );
            } catch (e) {
              console.warn(
                "Failed to save last video to localStorage on leave:",
                e
              );
            }
          }

          console.log(
            `[YouTube] ✓ Position saved on leave: ${currentTime.toFixed(
              1
            )}s (videoId: ${saveVideoId || "NONE"})`
          );
        } catch (err) {
          console.warn("Failed to save position on leave:", err);
        }

        // Also save to localStorage as backup
        try {
          const storageKey = `learnit_playback_${courseId}_${
            playback.videoId || playback.playlistId || "default"
          }`;
          localStorage.setItem(
            storageKey,
            JSON.stringify({ currentTime, duration, timestamp: Date.now() })
          );
        } catch (e) {
          // Ignore storage errors
        }
      }
    } catch (err) {
      console.warn("Error in savePositionOnLeave:", err);
    }
  }, [courseId, playback.videoId, playback.playlistId, course]);

  // Helper to get storage key for playback position (persists across sessions)
  const getPlaybackStorageKey = useCallback((courseId, videoId, playlistId) => {
    return `learnit_playback_${courseId}_${videoId || playlistId || "default"}`;
  }, []);

  useEffect(() => {
    let cancelled = false;
    hasResumedRef.current = false;

    // Prevent duplicate player creation - check both ref and container
    if (playerRef.current || !containerRef.current) {
      console.log(
        "[YouTube Player] Player already exists or container missing, skipping creation"
      );
      return;
    }

    const setup = async () => {
      const YT = await loadYouTube();
      if (cancelled || !containerRef.current) return;

      // Prevent duplicate creation
      if (playerRef.current) {
        console.log(
          "[YouTube Player] Player was created during async setup, skipping"
        );
        return;
      }

      // Try to load saved position first to set start parameter
      let savedStartTime = 0;
      if (courseId && playback.videoId) {
        try {
          // PRIORITY 1: Try database first (more reliable)
          try {
            const dbPosition = await courseApi.getPlaybackPosition(
              courseId,
              playback.videoId,
              null
            );
            if (
              dbPosition &&
              Number.isFinite(dbPosition.currentTimeSeconds) &&
              dbPosition.currentTimeSeconds >= 2
            ) {
              savedStartTime = Math.floor(dbPosition.currentTimeSeconds);
              console.log(
                `[YouTube] Found database position for start parameter: ${savedStartTime}s`
              );
            }
          } catch (e) {
            // Ignore database errors, fall back to localStorage
          }

          // PRIORITY 2: Fallback to localStorage if database didn't have position
          if (savedStartTime === 0) {
            const storageKey = `learnit_playback_${courseId}_${
              playback.videoId || playback.playlistId || "default"
            }`;
            const raw = localStorage.getItem(storageKey);
            if (raw) {
              try {
                const saved = JSON.parse(raw);
                if (
                  Number.isFinite(saved.currentTime) &&
                  saved.currentTime >= 2
                ) {
                  savedStartTime = Math.floor(saved.currentTime);
                  console.log(
                    `[YouTube] Found localStorage position for start parameter: ${savedStartTime}s`
                  );
                }
              } catch (e) {
                // Ignore
              }
            }
          }
        } catch (e) {
          // Ignore
        }
      }

      // For playlists, use listType and list parameters
      const playerVars = {
        rel: 0, // Don't show related videos
        modestbranding: 1, // Minimal YouTube branding
        enablejsapi: 1, // Enable JavaScript API for control
        origin: window.location.origin, // Set origin to reduce CORS issues
        iv_load_policy: 3, // Hide video annotations
        fs: 1, // Allow fullscreen
        playsinline: 1, // Allow inline playback on mobile
      };

      let videoId = playback.videoId;
      let resumeTime = savedStartTime;

      if (playback.playlistId) {
        // Playlist mode - use list parameter
        playerVars.listType = "playlist";
        playerVars.list = playback.playlistId;

        // PRIORITY 1: Try to get last saved video and position from localStorage
        // This tracks the last video the user was watching in the playlist
        try {
          const lastVideoKey = `learnit_playlist_last_video_${courseId}_${playback.playlistId}`;
          const lastVideoData = localStorage.getItem(lastVideoKey);
          if (lastVideoData) {
            try {
              const lastVideo = JSON.parse(lastVideoData);
              if (lastVideo.videoId && lastVideo.timestamp) {
                // Check if the saved video is recent (within last 30 days)
                const age = Date.now() - lastVideo.timestamp;
                if (age < 30 * 24 * 60 * 60 * 1000) {
                  videoId = lastVideo.videoId;
                  console.log(
                    `[YouTube Playlist] Found last watched video in localStorage: ${videoId}`
                  );

                  // Try to get the saved position for this video
                  try {
                    const savedPos = await courseApi.getPlaybackPosition(
                      courseId,
                      videoId,
                      null
                    );
                    if (
                      savedPos &&
                      Number.isFinite(savedPos.currentTimeSeconds) &&
                      savedPos.currentTimeSeconds >= 2
                    ) {
                      resumeTime = Math.floor(savedPos.currentTimeSeconds);
                      console.log(
                        `[YouTube Playlist] Resuming from saved position: ${videoId} at ${resumeTime}s`
                      );
                    }
                  } catch (e) {
                    // Try localStorage as fallback
                    const storageKey = `learnit_playback_${courseId}_${videoId}`;
                    const raw = localStorage.getItem(storageKey);
                    if (raw) {
                      try {
                        const saved = JSON.parse(raw);
                        if (
                          Number.isFinite(saved.currentTime) &&
                          saved.currentTime >= 2
                        ) {
                          resumeTime = Math.floor(saved.currentTime);
                          console.log(
                            `[YouTube Playlist] Resuming from localStorage position: ${videoId} at ${resumeTime}s`
                          );
                        }
                      } catch (e2) {
                        // Ignore
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn(
                "[YouTube Playlist] Failed to parse last video data:",
                e
              );
            }
          }
        } catch (e) {
          console.warn(
            "[YouTube Playlist] Failed to get last video from localStorage:",
            e
          );
        }

        // PRIORITY 2: If no last video found, find the first incomplete module
        if (!videoId) {
          const sortedModules = (course?.modules || []).sort(
            (a, b) => (a.order || 0) - (b.order || 0)
          );
          const firstIncompleteModule = sortedModules.find(
            (m) => !m.isCompleted
          );

          if (firstIncompleteModule) {
            try {
              // Extract videoId from module's Notes field
              const notes =
                firstIncompleteModule.notes ||
                firstIncompleteModule.Notes ||
                "";
              if (notes) {
                const metadata = JSON.parse(notes);
                if (metadata.videoId) {
                  videoId = metadata.videoId;
                  console.log(
                    `[YouTube Playlist] Resuming from first incomplete module: '${firstIncompleteModule.title}' (video: ${videoId})`
                  );
                } else {
                  console.log(
                    `[YouTube Playlist] Module '${firstIncompleteModule.title}' has no videoId in Notes, starting from beginning`
                  );
                }
              } else {
                // If no Notes, try to use module index to estimate which video
                const moduleIndex = sortedModules.indexOf(
                  firstIncompleteModule
                );
                console.log(
                  `[YouTube Playlist] Module '${firstIncompleteModule.title}' (index ${moduleIndex}) has no Notes, starting from beginning`
                );
              }
            } catch (e) {
              console.warn(
                `[YouTube Playlist] Failed to parse Notes for module '${firstIncompleteModule.title}':`,
                e
              );
            }
          } else {
            console.log(
              "[YouTube Playlist] All modules completed, starting from beginning"
            );
          }
        }

        // For playlists, we can optionally include videoId to start at a specific video
        // If videoId is found, use it to start at that video
        if (videoId) {
          console.log(
            `[YouTube Player] Loading playlist from video: ${videoId}${
              resumeTime > 0 ? ` at ${resumeTime}s` : ""
            }`
          );
        } else {
          console.log(
            "[YouTube Player] Loading playlist from beginning (no resume data found)"
          );
        }
      } else if (playback.videoId) {
        // Single video mode
        console.log("[YouTube Player] Loading video:", playback.videoId);
      }

      const playerConfig = {
        height: "360",
        width: "100%",
        playerVars: playerVars,
      };

      // Add start parameter if we have a saved position (YouTube will start at this time)
      // This is the PRIMARY resume method - YouTube will start the video at this time automatically
      if (resumeTime > 0) {
        playerVars.start = resumeTime;
        console.log(
          `[YouTube Resume] ✓✓✓ Setting start parameter to ${resumeTime}s (${(
            resumeTime / 60
          ).toFixed(1)} minutes) - video will start here automatically`
        );
        // Mark that we're resuming so module checks are delayed
        isResumingRef.current = true;
        lastSavedTimeRef.current = resumeTime;
        // Mark as resumed so onReady doesn't try to seek again (start parameter handles it)
        hasResumedRef.current = true;
      } else {
        console.log(
          `[YouTube Resume] No saved start time found (resumeTime=${resumeTime}) - will start from beginning`
        );
        isResumingRef.current = false;
      }

      // For playlists: use list parameter, and optionally set videoId to start at specific video
      // For single videos: set videoId
      if (!playback.playlistId && videoId) {
        playerConfig.videoId = videoId;
      } else if (playback.playlistId) {
        // For playlists: if we have a videoId (from last watched or incomplete module), use it to start at that video
        // Otherwise, YouTube will start at first video
        if (videoId) {
          playerConfig.videoId = videoId;
          console.log(
            `[YouTube Player] Playlist will start at video: ${videoId}${
              resumeTime > 0 ? ` at ${resumeTime}s` : ""
            }`
          );
        } else {
          // No specific videoId - YouTube will start at first video
          delete playerConfig.videoId;
        }
      }
      // Note: For playlists, YouTube API handles videoId automatically via list parameter

      console.log("[YouTube Player] Creating player with config:", {
        videoId: playerConfig.videoId,
        playlistId: playback.playlistId,
        start: savedStartTime > 0 ? savedStartTime : undefined,
        hasContainer: !!containerRef.current,
      });

      try {
        // Ensure container exists and is ready
        if (!containerRef.current) {
          console.error("[YouTube Player] Container ref is null!");
          return;
        }

        // Final safety check before creating player
        if (playerRef.current) {
          console.log(
            "[YouTube Player] Player already exists, aborting creation"
          );
          return;
        }

        console.log("[YouTube Player] Initializing player...");
        playerRef.current = new YT.Player(containerRef.current, {
          ...playerConfig,
          events: {
            onReady: async (event) => {
              console.log("[YouTube Player] Player ready!");
              // CRITICAL: Only seek once on player ready to prevent YouTube glitches
              // Use ref to track if we've already attempted seek (prevents repeated seek loops)
              // NOTE: hasResumedRef is set when start parameter is used, so we skip seek in that case
              if (!courseId || cancelled) {
                console.log(
                  `[YouTube Resume] onReady: Skipping - courseId=${courseId}, cancelled=${cancelled}`
                );
                isResumingRef.current = false;
                return;
              }

              // If we already resumed via start parameter, skip the seek logic
              if (hasResumedRef.current) {
                console.log(
                  `[YouTube Resume] onReady: Already resumed via start parameter (start=${
                    playerVars.start || "none"
                  }), clearing resume flag in 3s`
                );
                // Still need to clear resume flag after a delay to allow module checks
                // The start parameter should have already positioned the video
                setTimeout(() => {
                  isResumingRef.current = false;
                  console.log(
                    `[YouTube Resume] Resume complete (start parameter) - module checks enabled`
                  );
                }, 3000);
                return;
              }

              console.log(
                `[YouTube Resume] onReady: Starting resume lookup...`
              );
              isResumingRef.current = true;

              try {
                let savedTime = 0;
                let savedDuration = 0;

                // Get the actual video ID - prioritize playback.videoId from URL detection (consistent with save logic)
                // This ensures we use the same videoId that was used when saving
                let actualVideoId = playback.videoId || "";

                // For playlists, try to get current video ID from player (since playback.videoId might be empty)
                if (
                  playback.playlistId &&
                  !actualVideoId &&
                  event.target &&
                  typeof event.target.getVideoData === "function"
                ) {
                  try {
                    const videoData = event.target.getVideoData();
                    if (videoData && videoData.video_id) {
                      actualVideoId = videoData.video_id;
                      console.log(
                        `[YouTube] Got playlist video ID from player: ${actualVideoId}`
                      );
                    }
                  } catch (e) {
                    // SecurityError is expected for cross-origin access - ignore it
                    if (e.name !== "SecurityError") {
                      console.warn("Could not get video data from player:", e);
                    }
                  }
                }
                // For single videos, also try player as fallback (but prefer playback.videoId)
                else if (
                  !playback.playlistId &&
                  !actualVideoId &&
                  event.target &&
                  typeof event.target.getVideoData === "function"
                ) {
                  try {
                    const videoData = event.target.getVideoData();
                    if (videoData && videoData.video_id) {
                      actualVideoId = videoData.video_id;
                      console.log(
                        `[YouTube] Got video ID from player (fallback): ${actualVideoId}`
                      );
                    }
                  } catch (e) {
                    // SecurityError is expected for cross-origin access - ignore it silently
                    if (e.name !== "SecurityError") {
                      console.warn("Could not get video data from player:", e);
                    }
                  }
                }

                console.log(
                  `[YouTube] Resume lookup - videoId: ${
                    actualVideoId || "NONE"
                  }, playlistId: ${
                    playback.playlistId || "NONE"
                  }, playback.videoId: ${playback.videoId || "NONE"}`
                );

                // PRIORITY 1: Try to load from database first (persists across logout/login)
                try {
                  // Use videoId for single videos, playlistId for playlists (as fallback)
                  const lookupVideoId =
                    actualVideoId || playback.playlistId || "";
                  if (lookupVideoId && courseId) {
                    // Try to find current module if available
                    let moduleId = null;
                    if (course?.modules) {
                      const modules = (course.modules || []).sort(
                        (a, b) => (a.order || 0) - (b.order || 0)
                      );

                      // For playlists, find module that matches the videoId
                      if (playback.playlistId && actualVideoId) {
                        for (const module of modules) {
                          try {
                            const notes = module.notes || module.Notes || "";
                            if (notes) {
                              const metadata = JSON.parse(notes);
                              if (metadata.videoId === actualVideoId) {
                                moduleId = module.id;
                                console.log(
                                  `[YouTube] Found matching module ${moduleId} for video ${actualVideoId}`
                                );
                                break;
                              }
                            }
                          } catch (e) {
                            // Ignore parse errors
                          }
                        }
                      }
                      // For single videos, try first module (chapters will be handled by startTimeSeconds)
                      else if (!playback.playlistId && modules.length > 0) {
                        // Try to find module with videoId match first
                        for (const module of modules) {
                          try {
                            const notes = module.notes || module.Notes || "";
                            if (notes) {
                              const metadata = JSON.parse(notes);
                              if (metadata.videoId === actualVideoId) {
                                moduleId = module.id;
                                break;
                              }
                            }
                          } catch (e) {
                            // Ignore
                          }
                        }
                        // If no match, use first module (for single videos without chapters in Notes)
                        if (!moduleId && modules.length > 0) {
                          moduleId = modules[0].id;
                        }
                      }
                    }

                    console.log(
                      `[YouTube Resume] Looking up playback position: courseId=${courseId}, videoId=${lookupVideoId}, moduleId=${
                        moduleId || "null"
                      }, actualVideoId=${
                        actualVideoId || "NONE"
                      }, playback.videoId=${playback.videoId || "NONE"}`
                    );

                    // SMART RESUME: First try to find last completed module and resume from its start time
                    let smartResumeTime = 0;
                    if (course?.modules) {
                      const sortedModules = (course.modules || []).sort(
                        (a, b) => (a.order || 0) - (b.order || 0)
                      );
                      // Find the last completed module
                      let lastCompletedModule = null;
                      let lastCompletedIndex = -1;
                      for (
                        let idx = sortedModules.length - 1;
                        idx >= 0;
                        idx--
                      ) {
                        const mod = sortedModules[idx];
                        if (mod.isCompleted) {
                          try {
                            const notes = mod.notes || mod.Notes || "";
                            if (notes) {
                              const metadata = JSON.parse(notes);
                              if (
                                metadata.startTimeSeconds !== undefined &&
                                metadata.startTimeSeconds > 0
                              ) {
                                lastCompletedModule = mod;
                                lastCompletedIndex = idx;
                                smartResumeTime = metadata.startTimeSeconds;
                                console.log(
                                  `[YouTube Resume] 🎯 Found last completed module: '${
                                    mod.title
                                  }' at ${smartResumeTime.toFixed(
                                    1
                                  )}s (index ${idx})`
                                );
                                break;
                              }
                            }
                          } catch (e) {
                            // Ignore parse errors
                          }
                        }
                      }

                      // If we found a completed module, try to resume from the NEXT module's start time
                      // (so user continues from where they left off, not repeating completed content)
                      if (
                        lastCompletedIndex >= 0 &&
                        lastCompletedIndex < sortedModules.length - 1
                      ) {
                        const nextModule =
                          sortedModules[lastCompletedIndex + 1];
                        try {
                          const notes =
                            nextModule.notes || nextModule.Notes || "";
                          if (notes) {
                            const metadata = JSON.parse(notes);
                            if (
                              metadata.startTimeSeconds !== undefined &&
                              metadata.startTimeSeconds > 0
                            ) {
                              smartResumeTime = metadata.startTimeSeconds;
                              console.log(
                                `[YouTube Resume] 🎯 Resuming from next module: '${
                                  nextModule.title
                                }' at ${smartResumeTime.toFixed(
                                  1
                                )}s (after completed '${
                                  lastCompletedModule.title
                                }')`
                              );
                            }
                          }
                        } catch (e) {
                          // If next module doesn't have startTime, use last completed module's start time
                          console.log(
                            `[YouTube Resume] Next module has no startTime, using last completed module's start: ${smartResumeTime.toFixed(
                              1
                            )}s`
                          );
                        }
                      }
                    }

                    // PRIORITY 1: Try to get actual saved playback position from database (where user left off)
                    const dbPosition = await courseApi.getPlaybackPosition(
                      courseId,
                      lookupVideoId,
                      moduleId
                    );

                    // Use actual saved position first (most accurate - where user actually left off)
                    if (
                      dbPosition &&
                      Number.isFinite(dbPosition.currentTimeSeconds) &&
                      dbPosition.currentTimeSeconds >= 2
                    ) {
                      savedTime = dbPosition.currentTimeSeconds;
                      savedDuration = dbPosition.durationSeconds || 0;
                      console.log(
                        `[YouTube Resume] ✓✓✓ Loaded actual saved position from database: ${savedTime.toFixed(
                          1
                        )}s / ${savedDuration.toFixed(1)}s (${(
                          savedTime / 60
                        ).toFixed(1)} minutes)`
                      );
                    } else if (
                      dbPosition &&
                      dbPosition.currentTimeSeconds > 0 &&
                      dbPosition.currentTimeSeconds < 2
                    ) {
                      console.log(
                        `[YouTube Resume] Database has position ${dbPosition.currentTimeSeconds.toFixed(
                          1
                        )}s but it's too small (< 2s), trying fallback...`
                      );
                      // Try without moduleId as fallback
                      if (moduleId) {
                        const dbPositionNoModule =
                          await courseApi.getPlaybackPosition(
                            courseId,
                            lookupVideoId,
                            null
                          );
                        if (
                          dbPositionNoModule &&
                          Number.isFinite(
                            dbPositionNoModule.currentTimeSeconds
                          ) &&
                          dbPositionNoModule.currentTimeSeconds >= 2
                        ) {
                          savedTime = dbPositionNoModule.currentTimeSeconds;
                          savedDuration =
                            dbPositionNoModule.durationSeconds || 0;
                          console.log(
                            `[YouTube Resume] ✓✓✓ Loaded from database (no moduleId): ${savedTime.toFixed(
                              1
                            )}s / ${savedDuration.toFixed(1)}s (${(
                              savedTime / 60
                            ).toFixed(1)} minutes)`
                          );
                        }
                      }
                    } else {
                      console.log(
                        `[YouTube Resume] No database position found for videoId=${lookupVideoId}, trying smart resume...`
                      );
                    }

                    // PRIORITY 2: Fallback to smart resume (from last completed module) only if no saved position
                    if (savedTime < 2 && smartResumeTime >= 2) {
                      savedTime = smartResumeTime;
                      savedDuration = dbPosition?.durationSeconds || 0;
                      console.log(
                        `[YouTube Resume] 🎯 Using smart resume from last completed module (no saved position): ${savedTime.toFixed(
                          1
                        )}s (${(savedTime / 60).toFixed(1)} minutes)`
                      );
                    }
                  }
                } catch (err) {
                  console.warn(
                    "Failed to load playback position from database:",
                    err
                  );
                }

                // PRIORITY 2: Fallback to localStorage if database didn't have valid position
                // Try multiple localStorage keys to find saved position
                const storageKeys = [
                  `learnit_playback_${courseId}_${actualVideoId}`,
                  `learnit_playback_${courseId}_${playback.videoId || ""}`,
                  `learnit_playback_${courseId}_${playback.playlistId || ""}`,
                  `learnit_playback_${courseId}_default`,
                ];

                // Only use localStorage if we don't have a valid database position (>= 2s)
                if (savedTime < 2) {
                  for (const storageKey of storageKeys) {
                    if (!storageKey.includes("_") || storageKey.endsWith("_"))
                      continue;

                    const raw = localStorage.getItem(storageKey);
                    if (raw) {
                      try {
                        const saved = JSON.parse(raw);
                        // Only use localStorage position if it's meaningful (>= 1 second)
                        if (
                          Number.isFinite(saved.currentTime) &&
                          saved.currentTime >= 1
                        ) {
                          // Prefer localStorage if it's better than database (or database was 0)
                          if (saved.currentTime > savedTime) {
                            savedTime = saved.currentTime;
                            savedDuration = saved.duration || 0;
                            console.log(
                              `[YouTube] ✓ Loaded from localStorage (${storageKey}): ${savedTime.toFixed(
                                1
                              )}s / ${savedDuration.toFixed(1)}s`
                            );
                            break;
                          }
                        }
                      } catch (e) {
                        // Ignore parse errors
                      }
                    }
                  }
                }

                // Seek to saved position if found
                if (savedTime >= 2) {
                  console.log(
                    `[YouTube Resume] Attempting to resume from ${savedTime.toFixed(
                      1
                    )}s (${(savedTime / 60).toFixed(1)} minutes)...`
                  );
                  // Mark that we're attempting resume to prevent duplicate seeks
                  hasResumedRef.current = true;
                  lastSavedTimeRef.current = savedTime;

                  // Wait for player to be fully ready before seeking
                  // Retry logic with exponential backoff for more reliable resume
                  let retryCount = 0;
                  const maxRetries = 8; // Increased retries for more reliability

                  const seekToPosition = () => {
                    if (cancelled || !event.target) {
                      console.log(
                        `[YouTube] Resume cancelled or player not available`
                      );
                      return;
                    }

                    try {
                      if (typeof event.target.seekTo !== "function") {
                        console.warn(`[YouTube] seekTo function not available`);
                        if (retryCount < maxRetries) {
                          retryCount++;
                          setTimeout(seekToPosition, 500 * retryCount);
                        }
                        return;
                      }

                      let duration = 0;
                      let currentTime = 0;
                      let playerState = -1;

                      try {
                        duration = event.target.getDuration();
                        currentTime = event.target.getCurrentTime();
                        playerState = event.target.getPlayerState();
                      } catch (e) {
                        // SecurityError is expected for cross-origin access - use saved duration as fallback
                        if (e.name === "SecurityError") {
                          duration = savedDuration > 0 ? savedDuration : 0;
                          currentTime = 0;
                          playerState = -1;
                          console.log(
                            `[YouTube] SecurityError getting player state, using saved duration: ${duration.toFixed(
                              1
                            )}s`
                          );
                        } else {
                          throw e;
                        }
                      }

                      console.log(
                        `[YouTube] Resume attempt ${
                          retryCount + 1
                        }/${maxRetries}: duration=${duration.toFixed(
                          1
                        )}s, current=${currentTime.toFixed(
                          1
                        )}s, state=${playerState}`
                      );

                      if (duration > 0 && duration > 1) {
                        // Use saved duration if available, otherwise use player duration
                        const maxTime =
                          savedDuration > 0
                            ? Math.min(savedDuration, duration)
                            : duration;
                        const seekTime = Math.max(
                          0,
                          Math.min(savedTime, maxTime - 1)
                        );

                        // Only seek if the time difference is significant (more than 2 seconds)
                        const timeDiff = Math.abs(seekTime - currentTime);
                        if (timeDiff > 2) {
                          console.log(
                            `[YouTube] Seeking from ${currentTime.toFixed(
                              1
                            )}s to ${seekTime.toFixed(
                              1
                            )}s (diff: ${timeDiff.toFixed(1)}s)`
                          );
                          try {
                            // Try to seek - YouTube API will handle the seek even if video is paused/ended
                            event.target.seekTo(seekTime, true);
                            lastSavedTimeRef.current = seekTime;
                            console.log(
                              `[YouTube] ✓ Resumed playback at ${seekTime.toFixed(
                                1
                              )}s / ${duration.toFixed(1)}s`
                            );

                            // Mark resume as complete immediately - seek is done
                            isResumingRef.current = false;
                            console.log(
                              `[YouTube] Resume complete - module checks enabled`
                            );

                            // If video is ended or paused, try to play it
                            if (
                              playerState === YT.PlayerState.ENDED ||
                              playerState === YT.PlayerState.PAUSED
                            ) {
                              setTimeout(() => {
                                try {
                                  if (
                                    event.target &&
                                    typeof event.target.playVideo === "function"
                                  ) {
                                    event.target.playVideo();
                                    console.log(
                                      `[YouTube] Attempted to play video after seek`
                                    );
                                  }
                                } catch (e) {
                                  // Ignore play errors
                                }
                              }, 500);
                            }
                          } catch (seekErr) {
                            if (seekErr.name !== "SecurityError") {
                              throw seekErr;
                            }
                            // SecurityError on seek - ignore, player will handle it
                            console.log(
                              `[YouTube] Seek attempted (SecurityError ignored): ${seekTime.toFixed(
                                1
                              )}s`
                            );
                          }
                        } else {
                          console.log(
                            `[YouTube] Already at saved position (${currentTime.toFixed(
                              1
                            )}s ≈ ${seekTime.toFixed(
                              1
                            )}s, diff: ${timeDiff.toFixed(1)}s)`
                          );
                          // Mark resume as complete if already at position
                          setTimeout(() => {
                            isResumingRef.current = false;
                            console.log(
                              `[YouTube] Resume complete (already at position) - module checks enabled`
                            );
                          }, 1000);
                        }
                      } else if (retryCount < maxRetries) {
                        // Duration not ready yet, retry after a delay
                        retryCount++;
                        const delay = 500 * retryCount; // 500ms, 1000ms, 1500ms, etc.
                        console.log(
                          `[YouTube] Player duration not ready (${duration}), retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`
                        );
                        setTimeout(seekToPosition, delay);
                      } else {
                        console.warn(
                          `[YouTube] Could not get valid duration after ${maxRetries} retries (got ${duration}), skipping resume`
                        );
                        // Mark resume as complete even if failed (to prevent blocking forever)
                        isResumingRef.current = false;
                        console.log(
                          `[YouTube] Resume failed - module checks enabled`
                        );
                      }
                    } catch (err) {
                      // Ignore SecurityError - it's expected for cross-origin access
                      if (err.name === "SecurityError") {
                        console.log(
                          `[YouTube] SecurityError on resume (expected for cross-origin), attempting seek anyway: ${savedTime.toFixed(
                            1
                          )}s`
                        );
                        // Try to seek anyway even with SecurityError
                        try {
                          if (
                            event.target &&
                            typeof event.target.seekTo === "function"
                          ) {
                            const seekTime = Math.min(
                              savedTime,
                              savedDuration > 0 ? savedDuration - 1 : savedTime
                            );
                            event.target.seekTo(seekTime, true);
                            console.log(
                              `[YouTube] Seek attempted despite SecurityError: ${seekTime.toFixed(
                                1
                              )}s`
                            );
                          }
                        } catch (e) {
                          // Ignore
                        }
                        return;
                      }

                      if (retryCount < maxRetries) {
                        retryCount++;
                        const delay = 500 * retryCount;
                        console.warn(
                          `[YouTube] Seek failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries}):`,
                          err
                        );
                        setTimeout(seekToPosition, delay);
                      } else {
                        console.warn(
                          "Failed to seek on resume after retries:",
                          err
                        );
                      }
                    }
                  };

                  // Initial delay to ensure player is fully ready (increased for reliability)
                  setTimeout(seekToPosition, 1000);
                } else {
                  console.log(
                    `[YouTube Resume] No saved playback position found (savedTime=${savedTime.toFixed(
                      1
                    )}s, required >= 2s), starting from beginning`
                  );
                  // No resume needed - mark as complete immediately
                  isResumingRef.current = false;
                  hasResumedRef.current = true; // Mark as resumed so we don't try again
                }
              } catch (e) {
                console.warn("Failed to restore playback position:", e);
                // Mark resume as complete even on error (to prevent blocking forever)
                isResumingRef.current = false;
              }
            },
            onStateChange: (event) => {
              if (cancelled || !event.target) return;

              try {
                let current = 0;
                let duration = 0;

                try {
                  current = event.target.getCurrentTime();
                  duration = event.target.getDuration();
                } catch (e) {
                  // SecurityError is expected for cross-origin access - skip this update
                  if (e.name === "SecurityError") {
                    return;
                  }
                  throw e;
                }

                // Validate time values
                if (
                  !Number.isFinite(current) ||
                  !Number.isFinite(duration) ||
                  duration <= 0
                ) {
                  console.warn("[YouTube Player] Invalid time values:", {
                    current,
                    duration,
                  });
                  return;
                }

                const percent = percentFromTimes(current, duration);

                // Log state changes for debugging
                const stateNames = [
                  "UNSTARTED",
                  "ENDED",
                  "PLAYING",
                  "PAUSED",
                  "BUFFERING",
                  "CUED",
                ];
                console.log(
                  `[YouTube Player] State: ${
                    stateNames[event.data] || event.data
                  }, Time: ${current.toFixed(1)}s / ${duration.toFixed(
                    1
                  )}s (${percent.toFixed(1)}%)`
                );

                if (event.data === YT.PlayerState.PLAYING) {
                  clearInterval(intervalRef.current);

                  // AUTO-CREATE STUDY SESSION FOR STREAK TRACKING
                  // Create session automatically when video starts playing (if not already created)
                  // Use courseId directly from closure (it's in the dependency array)
                  if (!activeStudySessionRef.current && courseId) {
                    try {
                      // Find current module if available
                      const modules = (course?.modules || []).sort(
                        (a, b) => (a.order || 0) - (b.order || 0)
                      );
                      let currentModuleId = null;

                      // Try to find module based on current time
                      for (const module of modules) {
                        try {
                          const notes = module.notes || module.Notes || "";
                          if (notes) {
                            const metadata = JSON.parse(notes);
                            if (
                              metadata.startTimeSeconds !== undefined &&
                              current >= metadata.startTimeSeconds
                            ) {
                              currentModuleId = module.id;
                              break;
                            }
                          }
                        } catch (e) {
                          // Ignore parse errors
                        }
                      }

                      // If no module found by time, use first incomplete module
                      if (!currentModuleId) {
                        const firstIncomplete = modules.find(
                          (m) => !m.isCompleted
                        );
                        if (firstIncomplete) {
                          currentModuleId = firstIncomplete.id;
                        }
                      }

                      console.log(
                        `[Streak] Attempting to create study session for course ${courseId}, module ${
                          currentModuleId || "none"
                        }`
                      );
                      courseApi
                        .startStudySession(courseId, currentModuleId)
                        .then((session) => {
                          if (session && session.id) {
                            activeStudySessionRef.current = session.id;
                            studySessionStartTimeRef.current = Date.now();
                            console.log(
                              `[Streak] ✅ Auto-created study session ${
                                session.id
                              } for course ${courseId} at ${new Date().toLocaleTimeString()}`
                            );
                          } else {
                            console.warn(
                              `[Streak] Session created but no ID returned:`,
                              session
                            );
                          }
                        })
                        .catch(async (err) => {
                          // If session already exists, try to get the active session
                          if (
                            err?.response?.status === 400 ||
                            err?.message?.includes("already exists")
                          ) {
                            console.log(
                              `[Streak] Session already exists for course ${courseId} - fetching existing session...`
                            );
                            try {
                              const sessions =
                                await courseApi.getCourseSessions(courseId);
                              console.log(
                                `[Streak] Fetched ${
                                  Array.isArray(sessions) ? sessions.length : 0
                                } sessions for course ${courseId}`
                              );

                              // Find active session (not completed and no end time)
                              const activeSession = Array.isArray(sessions)
                                ? sessions.find((s) => {
                                    const isCompleted =
                                      s.isCompleted === true ||
                                      s.IsCompleted === true;
                                    const hasEndTime = s.endTime || s.EndTime;
                                    return !isCompleted && !hasEndTime;
                                  })
                                : null;

                              if (activeSession) {
                                const sessionId =
                                  activeSession.id || activeSession.Id;
                                const startTimeStr =
                                  activeSession.startTime ||
                                  activeSession.StartTime;

                                if (sessionId) {
                                  activeStudySessionRef.current = sessionId;
                                  // Use the session's start time if available, otherwise use current time
                                  const startTime = startTimeStr
                                    ? new Date(startTimeStr).getTime()
                                    : Date.now();
                                  studySessionStartTimeRef.current = startTime;
                                  const duration =
                                    (Date.now() - startTime) / 1000 / 60; // minutes
                                  console.log(
                                    `[Streak] ✅ Using existing active session ${sessionId} (started ${duration.toFixed(
                                      1
                                    )} minutes ago)`
                                  );
                                } else {
                                  console.warn(
                                    `[Streak] Active session found but no ID:`,
                                    activeSession
                                  );
                                }
                              } else {
                                console.warn(
                                  `[Streak] No active session found. All sessions:`,
                                  sessions
                                );
                              }
                            } catch (fetchErr) {
                              console.warn(
                                `[Streak] Failed to get existing sessions:`,
                                fetchErr
                              );
                            }
                          } else {
                            console.error(
                              `[Streak] ❌ Failed to create study session:`,
                              err
                            );
                            console.error(
                              `[Streak] Error details:`,
                              err?.response?.data || err?.message || err
                            );
                          }
                        });
                    } catch (err) {
                      console.warn(
                        `[Streak] Error creating study session:`,
                        err
                      );
                    }
                  }

                  // If we're resuming and video just started playing, check if we're at the saved position
                  // If not, wait a bit more for the seek to complete
                  if (
                    isResumingRef.current &&
                    current < 5 &&
                    lastSavedTimeRef.current > 5
                  ) {
                    // Video started playing but we're not at saved position yet - wait for seek
                    console.log(
                      `[YouTube Resume] Video playing but not at saved position yet (current: ${current.toFixed(
                        1
                      )}s, saved: ${lastSavedTimeRef.current.toFixed(
                        1
                      )}s), waiting for seek...`
                    );
                    setTimeout(() => {
                      // Check again after delay
                      try {
                        const checkTime = event.target.getCurrentTime();
                        if (
                          Math.abs(checkTime - lastSavedTimeRef.current) < 3
                        ) {
                          // Close enough to saved position
                          isResumingRef.current = false;
                          console.log(
                            `[YouTube Resume] Resume complete after play - module checks enabled`
                          );
                        } else {
                          // Still not at position, but enable checks anyway after timeout
                          setTimeout(() => {
                            isResumingRef.current = false;
                            console.log(
                              `[YouTube Resume] Resume timeout - module checks enabled`
                            );
                          }, 2000);
                        }
                      } catch (e) {
                        // Ignore errors, just enable checks after timeout
                        setTimeout(() => {
                          isResumingRef.current = false;
                          console.log(
                            `[YouTube Resume] Resume timeout (error) - module checks enabled`
                          );
                        }, 2000);
                      }
                    }, 1000);
                  } else if (isResumingRef.current && current >= 5) {
                    // We're past the initial seconds, resume likely complete
                    isResumingRef.current = false;
                    console.log(
                      `[YouTube Resume] Resume complete (video past initial seconds) - module checks enabled`
                    );
                  }

                  // Save on play
                  onProgress?.(
                    { currentTime: current, duration, percent },
                    "play"
                  );
                  // Save to localStorage on play (persists across sessions)
                  // Only save meaningful positions (> 1 second) to avoid overwriting good positions
                  if (courseId && Number.isFinite(current) && current >= 1) {
                    lastSavedTimeRef.current = current;
                    try {
                      const storageKey = `learnit_playback_${courseId}_${
                        playback.videoId || playback.playlistId || "default"
                      }`;
                      localStorage.setItem(
                        storageKey,
                        JSON.stringify({
                          currentTime: current,
                          duration,
                          timestamp: Date.now(),
                        })
                      );
                    } catch (e) {
                      // Ignore storage errors
                    }
                  }
                  // Interval to update progress during playback and detect seeks
                  let lastCheckTime = Date.now();
                  intervalRef.current = setInterval(() => {
                    if (cancelled || !event.target) {
                      clearInterval(intervalRef.current);
                      return;
                    }
                    try {
                      let cur = 0;
                      let dur = 0;

                      try {
                        cur = event.target.getCurrentTime();
                        dur = event.target.getDuration();
                      } catch (e) {
                        // SecurityError is expected for cross-origin access - skip this update
                        if (e.name === "SecurityError") {
                          return;
                        }
                        throw e;
                      }

                      if (
                        Number.isFinite(cur) &&
                        Number.isFinite(dur) &&
                        dur > 0 &&
                        cur >= 0
                      ) {
                        // Get playlist video info for playlists
                        let playlistVideoIndex = undefined;
                        let playlistVideoId = undefined;

                        if (playback.playlistId && event.target) {
                          try {
                            const playlistInfo = event.target.getPlaylist();
                            const videoData = event.target.getVideoData();
                            playlistVideoId = videoData?.video_id;

                            if (
                              playlistVideoId &&
                              playlistInfo &&
                              Array.isArray(playlistInfo)
                            ) {
                              playlistVideoIndex =
                                playlistInfo.indexOf(playlistVideoId);
                            }
                          } catch (err) {
                            // SecurityError is expected for cross-origin access - ignore it
                            if (err.name !== "SecurityError") {
                              console.warn(
                                "Failed to get playlist info during playback:",
                                err
                              );
                            }
                          }
                        }

                        // Always update localStorage for resume (but only meaningful positions)
                        if (courseId && cur >= 1) {
                          try {
                            const storageKey = `learnit_playback_${courseId}_${
                              playback.videoId ||
                              playlistVideoId ||
                              playback.playlistId ||
                              "default"
                            }`;
                            localStorage.setItem(
                              storageKey,
                              JSON.stringify({
                                currentTime: cur,
                                duration: dur,
                                timestamp: Date.now(),
                              })
                            );
                          } catch (e) {
                            // Ignore storage errors
                          }
                        }

                        // Check if time jumped significantly (seek detected)
                        const timeJump = Math.abs(
                          cur - lastSavedTimeRef.current
                        );
                        if (timeJump > 5) {
                          // Significant time jump = seek happened
                          lastSavedTimeRef.current = cur;
                          onProgress?.(
                            {
                              currentTime: cur,
                              duration: dur,
                              percent: percentFromTimes(cur, dur),
                              playlistVideoIndex,
                              playlistVideoId,
                            },
                            "seeked"
                          );
                        } else {
                          // Normal playback - check module completion every 3 seconds for more responsive updates
                          const now = Date.now();
                          if (now - lastCheckTime > 3000) {
                            lastCheckTime = now;
                            const percent = percentFromTimes(cur, dur);
                            // Always pass playlist info and videoEnded flag for proper module completion tracking
                            onProgress?.(
                              {
                                currentTime: cur,
                                duration: dur,
                                percent,
                                playlistVideoIndex,
                                playlistVideoId,
                                videoEnded: false,
                              },
                              "timeupdate"
                            );
                          }
                        }
                        lastSavedTimeRef.current = cur;
                      }
                    } catch (err) {
                      console.warn("YouTube progress check error:", err);
                    }
                  }, 2000); // Check every 2 seconds for seek detection and timeupdate
                } else if (event.data === YT.PlayerState.BUFFERING) {
                  // Don't do anything during buffering
                } else if (
                  event.data === YT.PlayerState.PAUSED ||
                  event.data === YT.PlayerState.ENDED
                ) {
                  clearInterval(intervalRef.current);
                  // Save on pause/end (persists across sessions)
                  // Only save meaningful positions (> 0 seconds, or ended state with any progress)
                  if (
                    courseId &&
                    Number.isFinite(current) &&
                    (current >= 1 ||
                      (event.data === YT.PlayerState.ENDED && current > 0))
                  ) {
                    lastSavedTimeRef.current = current;
                    try {
                      const storageKey = `learnit_playback_${courseId}_${
                        playback.videoId || playback.playlistId || "default"
                      }`;
                      localStorage.setItem(
                        storageKey,
                        JSON.stringify({
                          currentTime: current,
                          duration,
                          timestamp: Date.now(),
                        })
                      );
                    } catch (e) {
                      // Ignore storage errors
                    }
                  }
                  onProgress?.(
                    { currentTime: current, duration, percent },
                    "paused"
                  );

                  // AUTO-COMPLETE STUDY SESSION WHEN PAUSED (if watched for minimum duration)
                  // This ensures sessions are completed even if user pauses and doesn't resume
                  if (
                    event.data === YT.PlayerState.PAUSED &&
                    activeStudySessionRef.current &&
                    courseId
                  ) {
                    const sessionId = activeStudySessionRef.current;
                    const startTime = studySessionStartTimeRef.current;
                    const watchedDuration = startTime
                      ? (Date.now() - startTime) / 1000 / 60
                      : 0; // minutes
                    const MIN_SESSION_MINUTES = 1; // Minimum 1 minute to count toward streak

                    // Only complete if watched for at least 1 minute
                    if (watchedDuration >= MIN_SESSION_MINUTES) {
                      console.log(
                        `[Streak] Video paused after ${watchedDuration.toFixed(
                          1
                        )} minutes - completing session ${sessionId}`
                      );
                      courseApi
                        .stopStudySession(
                          sessionId,
                          `Auto-completed: Video paused (watched ${watchedDuration.toFixed(
                            1
                          )} minutes)`
                        )
                        .then(() => {
                          console.log(
                            `[Streak] ✅ Auto-completed study session ${sessionId} on pause`
                          );
                          activeStudySessionRef.current = null;
                          studySessionStartTimeRef.current = null;
                        })
                        .catch((err) => {
                          console.warn(
                            `[Streak] Failed to complete study session on pause:`,
                            err
                          );
                          // Don't reset refs on error - might retry later
                        });
                    } else {
                      console.log(
                        `[Streak] Video paused but session too short (${watchedDuration.toFixed(
                          1
                        )} min < ${MIN_SESSION_MINUTES} min) - keeping session active`
                      );
                    }
                  }

                  if (event.data === YT.PlayerState.ENDED) {
                    // AUTO-COMPLETE STUDY SESSION FOR STREAK TRACKING
                    // Complete session when video ends (if watched for minimum duration)
                    // Use courseId directly from closure (it's in the dependency array)
                    if (activeStudySessionRef.current && courseId) {
                      const sessionId = activeStudySessionRef.current;
                      const startTime = studySessionStartTimeRef.current;
                      const watchedDuration = startTime
                        ? (Date.now() - startTime) / 1000 / 60
                        : 0; // minutes
                      const MIN_SESSION_MINUTES = 1; // Minimum 1 minute to count toward streak

                      if (watchedDuration >= MIN_SESSION_MINUTES) {
                        courseApi
                          .stopStudySession(
                            sessionId,
                            "Auto-completed: Video ended"
                          )
                          .then(() => {
                            console.log(
                              `[Streak] ✅ Auto-completed study session ${sessionId} (watched ${watchedDuration.toFixed(
                                1
                              )} minutes)`
                            );
                            activeStudySessionRef.current = null;
                            studySessionStartTimeRef.current = null;
                          })
                          .catch((err) => {
                            console.warn(
                              `[Streak] Failed to complete study session:`,
                              err
                            );
                            activeStudySessionRef.current = null;
                            studySessionStartTimeRef.current = null;
                          });
                      } else {
                        // Session too short - don't count toward streak, but still complete it
                        console.log(
                          `[Streak] Session ${sessionId} too short (${watchedDuration.toFixed(
                            1
                          )} min < ${MIN_SESSION_MINUTES} min), completing anyway`
                        );
                        courseApi
                          .stopStudySession(
                            sessionId,
                            "Auto-completed: Video ended (short session)"
                          )
                          .then(() => {
                            activeStudySessionRef.current = null;
                            studySessionStartTimeRef.current = null;
                          })
                          .catch((err) => {
                            console.warn(
                              `[Streak] Failed to complete short session:`,
                              err
                            );
                            activeStudySessionRef.current = null;
                            studySessionStartTimeRef.current = null;
                          });
                      }
                    }

                    // Video ended - mark as 100% complete
                    let playlistVideoIndex = undefined;
                    let playlistVideoId = undefined;

                    // For playlists: get current video info
                    if (playback.playlistId && event.target) {
                      try {
                        const playlistInfo = event.target.getPlaylist();
                        const videoData = event.target.getVideoData();
                        playlistVideoId = videoData?.video_id;

                        if (
                          playlistVideoId &&
                          playlistInfo &&
                          Array.isArray(playlistInfo)
                        ) {
                          playlistVideoIndex =
                            playlistInfo.indexOf(playlistVideoId);
                          console.log(
                            `[Playlist] Video ${
                              playlistVideoIndex + 1
                            } ended: ${playlistVideoId}`
                          );
                        }
                      } catch (err) {
                        // SecurityError is expected for cross-origin access - ignore it
                        if (err.name !== "SecurityError") {
                          console.warn(
                            "Failed to get playlist info on video end:",
                            err
                          );
                        }
                      }
                    }

                    onProgress?.(
                      {
                        currentTime: duration,
                        duration,
                        percent: 100,
                        playlistVideoIndex,
                        playlistVideoId,
                        videoEnded: true,
                      },
                      "ended"
                    );
                  }
                }
              } catch (err) {
                console.warn("YouTube state change error:", err);
              }
            },
          },
        });
        console.log("[YouTube Player] Player created successfully");
      } catch (err) {
        console.error("[YouTube Player] Failed to create player:", err);
        if (onProgress) {
          onProgress({ currentTime: 0, duration: 0, percent: 0 }, "error");
        }
      }
    };

    setup();

    // Save position when page is about to unload
    const handleBeforeUnload = () => {
      savePositionOnLeave();

      // AUTO-COMPLETE STUDY SESSION ON PAGE UNLOAD (for streak tracking)
      // Use courseId directly from closure (it's in the dependency array)
      if (activeStudySessionRef.current && courseId) {
        const sessionId = activeStudySessionRef.current;
        const startTime = studySessionStartTimeRef.current;
        const watchedDuration = startTime
          ? (Date.now() - startTime) / 1000 / 60
          : 0; // minutes
        const MIN_SESSION_MINUTES = 1; // Changed from 5 to 1 minute

        // Use fetch with keepalive for reliable completion on page unload
        if (watchedDuration >= MIN_SESSION_MINUTES) {
          const notes = `Auto-completed: Page unload (watched ${watchedDuration.toFixed(
            1
          )} minutes)`;
          // Use fetch with keepalive for reliability (more reliable than courseApi on unload)
          const apiBase = import.meta.env.VITE_API_URL || "";
          fetch(`${apiBase}/api/courses/sessions/${sessionId}/stop`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
            },
            body: JSON.stringify(notes),
            keepalive: true,
          }).catch(() => {}); // Ignore errors on unload
        }
      }
    };

    // Save position when tab becomes hidden
    const handleVisibilityChange = () => {
      if (document.hidden) {
        savePositionOnLeave();

        // AUTO-COMPLETE STUDY SESSION WHEN TAB HIDDEN (for streak tracking)
        // Only complete if watched for minimum duration
        // Use courseId directly from closure (it's in the dependency array)
        if (activeStudySessionRef.current && courseId) {
          const sessionId = activeStudySessionRef.current;
          const startTime = studySessionStartTimeRef.current;
          const watchedDuration = startTime
            ? (Date.now() - startTime) / 1000 / 60
            : 0; // minutes
          const MIN_SESSION_MINUTES = 1; // Changed from 5 to 1 minute

          if (watchedDuration >= MIN_SESSION_MINUTES) {
            courseApi
              .stopStudySession(
                sessionId,
                `Auto-completed: Tab hidden (watched ${watchedDuration.toFixed(
                  1
                )} minutes)`
              )
              .then(() => {
                console.log(
                  `[Streak] ✅ Auto-completed study session ${sessionId} on tab hidden`
                );
                activeStudySessionRef.current = null;
                studySessionStartTimeRef.current = null;
              })
              .catch((err) => {
                console.warn(
                  `[Streak] Failed to complete study session on tab hidden:`,
                  err
                );
                activeStudySessionRef.current = null;
                studySessionStartTimeRef.current = null;
              });
          }
        }
      }
    };

    // Add event listeners for page leave
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      // CRITICAL: Proper cleanup to prevent memory leaks and YouTube glitches
      cancelled = true;

      // AUTO-COMPLETE STUDY SESSION ON CLEANUP (for streak tracking)
      // Complete session when user navigates away (if watched for minimum duration)
      // Use courseId directly from closure (it's in the dependency array)
      if (activeStudySessionRef.current && courseId) {
        const sessionId = activeStudySessionRef.current;
        const startTime = studySessionStartTimeRef.current;
        const watchedDuration = startTime
          ? (Date.now() - startTime) / 1000 / 60
          : 0; // minutes
        const MIN_SESSION_MINUTES = 1; // Minimum 1 minute to count toward streak

        if (watchedDuration >= MIN_SESSION_MINUTES) {
          // Use synchronous approach or fire-and-forget since we're unmounting
          courseApi
            .stopStudySession(sessionId, "Auto-completed: User navigated away")
            .then(() => {
              console.log(
                `[Streak] ✅ Auto-completed study session ${sessionId} on cleanup (watched ${watchedDuration.toFixed(
                  1
                )} minutes)`
              );
            })
            .catch((err) => {
              console.warn(
                `[Streak] Failed to complete study session on cleanup:`,
                err
              );
            });
        } else {
          // Session too short - complete anyway but log it
          console.log(
            `[Streak] Session ${sessionId} too short on cleanup (${watchedDuration.toFixed(
              1
            )} min < ${MIN_SESSION_MINUTES} min)`
          );
          courseApi
            .stopStudySession(
              sessionId,
              "Auto-completed: User navigated away (short session)"
            )
            .catch((err) => {
              console.warn(
                `[Streak] Failed to complete short session on cleanup:`,
                err
              );
            });
        }

        activeStudySessionRef.current = null;
        studySessionStartTimeRef.current = null;
      }

      // Clear session update interval if exists
      if (studySessionUpdateIntervalRef.current) {
        clearInterval(studySessionUpdateIntervalRef.current);
        studySessionUpdateIntervalRef.current = null;
      }

      // Save position before cleanup
      savePositionOnLeave();

      // Remove event listeners
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      // Clear interval immediately to prevent callbacks after unmount
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      // Reset resume flag for next mount
      hasResumedRef.current = false;

      if (playerRef.current) {
        try {
          // Stop the player first to prevent state changes during cleanup
          if (typeof playerRef.current.stopVideo === "function") {
            try {
              playerRef.current.stopVideo();
            } catch (e) {
              // Ignore stop errors during cleanup
            }
          }

          // Clear player reference - don't call destroy() to avoid React DOM conflicts
          // YouTube's destroy() removes the iframe, which conflicts with React's unmount
          playerRef.current = null;

          // Clear container content - React will handle DOM removal
          if (containerRef.current) {
            try {
              containerRef.current.innerHTML = "";
            } catch (err) {
              // Ignore - container may already be removed by React
            }
          }
        } catch (err) {
          // Ignore cleanup errors - component is unmounting
        }
      }
    };
  }, [playback.playlistId, playback.videoId, courseId]); // Removed savePositionOnLeave to prevent player recreation

  return (
    <div className={styles.youtubeWrapper}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: "360px" }}
      />
    </div>
  );
}

export default CourseDetails;
