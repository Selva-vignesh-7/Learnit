import React, { useEffect, useRef, useState } from "react";
import { courseApi, scheduleApi } from "../../services";
import QuizModal from "../course/QuizModal";
import { AutoScheduleModal } from "./schedule/AutoScheduleModal";
import { EditEventModal } from "./schedule/EditEventModal";
import { ResetScheduleModal } from "./schedule/ResetScheduleModal";
import { RescheduleModal } from "./schedule/RescheduleModal";
import { ScheduleCalendar } from "./schedule/ScheduleCalendar";
import { MetricsRow } from "./schedule/MetricsRow";
import { NextSessions } from "./schedule/NextSessions";
import { Loading, ErrorMessage } from "../ui/index";
import styles from "./Schedule.module.css";
import { FiZap } from "react-icons/fi";

const colorPalette = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#ea580c",
  "#7c3aed",
  "#0ea5e9",
  "#d97706",
  "#22c55e",
];

const getCourseColor = (courseId) => {
  if (courseId === null || courseId === undefined) return "#1eaf53";
  const idx = Math.abs(courseId) % colorPalette.length;
  return colorPalette[idx];
};

const decorateEventColors = (event) => {
  if (!event.courseModuleId) {
    return {
      ...event,
      backgroundColor: undefined,
      borderColor: undefined,
      textColor: "#fff",
    };
  }

  const courseId = event.courseModule?.courseId;
  const isCompleted = event.courseModule?.isCompleted;
  const baseColor = getCourseColor(courseId);

  const color = isCompleted ? "#94a3b8" : baseColor;

  return {
    ...event,
    backgroundColor: color,
    borderColor: color,
    textColor: "#fff",
  };
};

export default function Schedule() {
  const calendarRef = useRef(null);
  const hasCheckedMissedEventsRef = useRef(false);

  const getNextMondayDate = () => {
    const now = new Date();
    const nextMonday = new Date(now);
    const day = nextMonday.getDay();
    const diff = (day === 0 ? 1 : 8) - day;
    nextMonday.setDate(nextMonday.getDate() + diff);
    return nextMonday.toISOString().slice(0, 10);
  };

  const getFutureStartDateTime = () => {
    const now = new Date();
    // Always use at least today's date
    const today = new Date(now);
    today.setHours(9, 0, 0, 0); // Set to 9 AM today

    // If 9 AM today has already passed, use tomorrow at 9 AM
    if (today <= now) {
      today.setDate(today.getDate() + 1);
    }

    return today.toISOString();
  };

  const [events, setEvents] = useState([]);
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [quizModal, setQuizModal] = useState({
    isOpen: false,
    moduleId: null,
    moduleTitle: "",
  });
  const [availableModules, setAvailableModules] = useState([]);
  const [showAutoSchedule, setShowAutoSchedule] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [missedEvents, setMissedEvents] = useState([]);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editForm, setEditForm] = useState({
    title: "",
    start: "",
    end: "",
    linkToModule: "",
    unlinkFromModule: false,
    markComplete: false,
  });
  const [autoOptions, setAutoOptions] = useState({
    startDate: getNextMondayDate(),
    preferredStartHour: 9,
    preferredEndHour: 18,
    dayStart: "09:00",
    dayEnd: "18:00",
    includeWeekends: false,
    maxSessionMinutes: 90,
    bufferMinutes: 15,
    weeklyLimitHours: 15,
    courseOrder: [],
  });
  const [notification, setNotification] = useState("");
  const notificationTimeoutRef = useRef(null);
  const [weeklyMetrics, setWeeklyMetrics] = useState({
    scheduled: 0,
    completed: 0,
  });

  // Helper function to set notification with auto-clear and timeout cleanup
  const showNotification = (message, duration = 5000) => {
    // Clear any existing timeout
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
    }

    setNotification(message);

    // Set new timeout
    notificationTimeoutRef.current = setTimeout(() => {
      setNotification("");
      notificationTimeoutRef.current = null;
    }, duration);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
      }
    };
  }, []);

  const formatHours = (hours) => {
    if (hours === null || hours === undefined) return "0 hours";
    const rounded = Math.round(hours * 10) / 10;
    const display = Number.isInteger(rounded)
      ? rounded.toFixed(0)
      : rounded.toFixed(1);
    return `${display} hours`;
  };

  const toLocalDateTimeInput = (value) => {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  };

  const updateAutoOptions = (updates) =>
    setAutoOptions((prev) => ({ ...prev, ...updates }));

  const toggleCourseSelection = (courseId) => {
    setAutoOptions((prev) => {
      const order = prev.courseOrder || [];
      const exists = order.includes(courseId);
      const next = exists
        ? order.filter((id) => id !== courseId)
        : [...order, courseId];
      return { ...prev, courseOrder: next };
    });
  };

  const moveCourseSelection = (courseId, delta) => {
    setAutoOptions((prev) => {
      const order = [...(prev.courseOrder || [])];
      const idx = order.indexOf(courseId);
      if (idx === -1) return prev;
      const swapWith = idx + delta;
      if (swapWith < 0 || swapWith >= order.length) return prev;
      [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
      return { ...prev, courseOrder: order };
    });
  };

  const setEventsWithMetrics = (updater) => {
    setEvents((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      computeWeeklyMetrics(next);
      return next;
    });
  };

  const updateEditForm = (updates) =>
    setEditForm((prev) => ({ ...prev, ...updates }));

  useEffect(() => {
    loadEvents();
    loadAvailableModules();
    loadCourses();
  }, []);

  const loadEvents = async () => {
    try {
      setLoading(true);
      setError("");
      const data = await scheduleApi.getScheduleEvents();
      // Map backend DTOs to FullCalendar events
      const mapped = data.map((e) => {
        const startUtc = e.startUtc;
        const startDate = startUtc ? new Date(startUtc) : null;
        const normalizedEndUtc =
          e.allDay && startDate
            ? new Date(startDate.getTime() + 60 * 60 * 1000).toISOString()
            : e.endUtc;

        return decorateEventColors({
          id: String(e.id),
          title: e.title,
          start: startUtc,
          end: normalizedEndUtc,
          allDay: false,
          courseModuleId: e.courseModuleId,
          courseModule: e.courseModule,
          originalId: e.id, // Keep original ID for API calls
        });
      });

      setEvents(mapped);
      computeWeeklyMetrics(mapped);

      // Check for missed incomplete events
      checkForMissedEvents(mapped);
    } catch (err) {
      console.error("Failed to load schedule events", err);
      setError(err.message || "Failed to load schedule");
    } finally {
      setLoading(false);
    }
  };

  const checkForMissedEvents = (eventList) => {
    // Only check once per component mount to avoid annoying the user
    if (hasCheckedMissedEventsRef.current) return;

    const now = new Date();
    const missed = eventList.filter((e) => {
      // Only check events linked to modules (course events)
      if (!e.courseModuleId || !e.courseModule) return false;

      // Check if module is incomplete
      if (e.courseModule.isCompleted) return false;

      // Check if event end time has passed
      const endTime = e.end
        ? new Date(e.end)
        : new Date(new Date(e.start).getTime() + 60 * 60 * 1000);
      return endTime < now;
    });

    if (missed.length > 0) {
      setMissedEvents(missed);
      setShowRescheduleModal(true);
      hasCheckedMissedEventsRef.current = true;
    }
  };

  const loadAvailableModules = async () => {
    try {
      const data = await scheduleApi.getAvailableModules();
      setAvailableModules(data);
    } catch (err) {
      console.error("Failed to load available modules", err);
    }
  };

  const loadCourses = async () => {
    try {
      const data = await courseApi.getCourses();
      setCourses(data || []);
    } catch (err) {
      console.error("Failed to load courses", err);
    }
  };

  const computeWeeklyMetrics = (list) => {
    const now = new Date();

    // Calculate current week boundaries (Monday to Sunday) - same as Sidebar
    const today = new Date(now);
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert Sunday (0) to 6
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    weekEnd.setHours(23, 59, 59, 999);

    let scheduled = 0;
    let completed = 0;

    list.forEach((e) => {
      if (!e.courseModuleId) return;

      const start = new Date(e.start);
      const end = e.end
        ? new Date(e.end)
        : new Date(start.getTime() + 60 * 60 * 1000);

      // Only count events that fall within the current week
      const eventEnd = end > start ? end : start;
      if (eventEnd < weekStart || start > weekEnd) {
        return; // Event is outside current week
      }

      // Calculate hours for the portion of event within the week
      const eventStartInWeek = start < weekStart ? weekStart : start;
      const eventEndInWeek = eventEnd > weekEnd ? weekEnd : eventEnd;

      const hours = Math.max(
        0.25,
        (eventEndInWeek - eventStartInWeek) / (1000 * 60 * 60)
      );
      scheduled += hours;
      if (e.courseModule?.isCompleted || eventEnd <= now) {
        completed += hours;
      }
    });

    setWeeklyMetrics({
      scheduled: Math.round(scheduled * 10) / 10,
      completed: Math.round(completed * 10) / 10,
    });
  };

  const createEventOnServer = async ({ title, start, end }) => {
    const payload = {
      title,
      startUtc: new Date(start).toISOString(),
      endUtc: end ? new Date(end).toISOString() : null,
      allDay: false,
    };

    const created = await scheduleApi.createScheduleEvent(payload);
    return decorateEventColors({
      id: String(created.id),
      title: created.title,
      start: created.startUtc,
      end: created.endUtc,
      allDay: false,
      courseModuleId: created.courseModuleId,
      courseModule: created.courseModule,
    });
  };

  const updateEventOnServer = async (id, { title, start, end }) => {
    const payload = {
      title,
      startUtc: new Date(start).toISOString(),
      endUtc: end ? new Date(end).toISOString() : null,
      allDay: false,
    };
    await scheduleApi.updateScheduleEvent(id, payload);
  };

  const handleAutoSchedule = async () => {
    try {
      setLoading(true);
      setError("");

      const selectedCourseIds = Array.isArray(autoOptions.courseOrder)
        ? autoOptions.courseOrder
        : [];

      if (selectedCourseIds.length === 0) {
        setError("Select at least one course to schedule.");
        return;
      }

      const startDate = autoOptions.startDate
        ? new Date(
            `${autoOptions.startDate}T${autoOptions.dayStart || "09:00"}`
          )
        : null;

      const payload = {
        startDateTime:
          startDate && !Number.isNaN(startDate.valueOf())
            ? startDate.toISOString()
            : null,
        preferredStartHour:
          Number(autoOptions.dayStart?.split(":")[0]) ||
          Number(autoOptions.preferredStartHour) ||
          9,
        preferredEndHour:
          Number(autoOptions.dayEnd?.split(":")[0]) ||
          Number(autoOptions.preferredEndHour) ||
          18,
        includeWeekends: autoOptions.includeWeekends,
        maxSessionMinutes: Number(autoOptions.maxSessionMinutes),
        bufferMinutes: Number(autoOptions.bufferMinutes),
        weeklyLimitHours: Number.isFinite(Number(autoOptions.weeklyLimitHours))
          ? Number(autoOptions.weeklyLimitHours)
          : null,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        courseOrderIds: selectedCourseIds.length > 0 ? selectedCourseIds : null,
        moduleIds: null,
      };

      const result = await scheduleApi.autoScheduleModules(payload);

      // Close the modal first
      setShowAutoSchedule(false);

      if (result.scheduledEvents > 0) {
        // Reload events and available modules to refresh the UI
        await Promise.all([loadEvents(), loadAvailableModules()]);
        showNotification(
          `Successfully scheduled ${result.scheduledEvents} session(s). ${
            result.scheduledEvents > 1 ? "All modules have been scheduled." : ""
          }`
        );
      } else {
        // Still reload to check if there are any modules available now
        await loadAvailableModules();
        showNotification(
          "No course modules available to schedule. All modules may already be scheduled."
        );
      }
    } catch (err) {
      console.error("Auto-schedule failed", err);
      setError(err.message || "Failed to auto-schedule modules");
    } finally {
      setLoading(false);
    }
  };

  const handleResetSchedule = async () => {
    try {
      setLoading(true);
      setError("");
      const result = await scheduleApi.resetSchedule();
      await loadEvents();
      setShowResetConfirm(false);
      showNotification(result.message || "Schedule cleared", 4000);
    } catch (err) {
      setError(err.message || "Failed to reset schedule");
    } finally {
      setLoading(false);
    }
  };

  const handleDismissMissedEvents = () => {
    setShowRescheduleModal(false);
    // Don't clear missedEvents - keep them for next time the page loads
    // Mark as checked so we don't show it again until next page load
    hasCheckedMissedEventsRef.current = true;
  };

  const handleLinkToModule = async (eventId, moduleId) => {
    try {
      await scheduleApi.linkEventToModule(eventId, moduleId);
      await loadEvents();
      await loadAvailableModules();
      showNotification("Event linked to course module successfully", 3000);
    } catch (err) {
      console.error("Failed to link event to module", err);
      const errorMessage =
        err.message || err.data?.message || "Failed to link event to module";
      setError(errorMessage);
      setTimeout(() => setError(""), 5000);
    }
  };

  const handleUnlinkFromModule = async (eventId) => {
    try {
      await scheduleApi.unlinkEventFromModule(eventId);
      await loadEvents();
      await loadAvailableModules();
    } catch (err) {
      console.error("Failed to unlink event from module", err);
      setError(err.message || "Failed to unlink event from module");
    }
  };

  const deleteEventOnServer = async (id) => {
    await scheduleApi.deleteScheduleEvent(id);
  };

  // Create event by selecting range
  async function handleSelect(info) {
    // Validate date range
    const start = new Date(info.startStr);
    const end = info.endStr
      ? new Date(info.endStr)
      : new Date(start.getTime() + 60 * 60 * 1000);

    // Validate dates are valid
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      setError("Invalid date selected");
      setTimeout(() => setError(""), 4000);
      return;
    }

    if (end <= start) {
      setError("End time must be after start time");
      setTimeout(() => setError(""), 4000);
      return;
    }

    // Validate minimum duration (15 minutes)
    const durationMinutes = (end - start) / (1000 * 60);
    if (durationMinutes < 15) {
      setError("Event duration must be at least 15 minutes");
      setTimeout(() => setError(""), 4000);
      return;
    }

    // Optional: Warn if outside preferred day window (but don't block)
    if (autoOptions.dayStart && autoOptions.dayEnd) {
      const startHour = start.getHours();
      const dayStartHour = parseInt(autoOptions.dayStart.split(":")[0]) || 9;
      const dayEndHour = parseInt(autoOptions.dayEnd.split(":")[0]) || 18;

      if (startHour < dayStartHour || startHour >= dayEndHour) {
        const confirm = window.confirm(
          `This event is scheduled outside your preferred day window (${dayStartHour}:00 - ${dayEndHour}:00). Do you want to continue?`
        );
        if (!confirm) return;
      }
    }

    const title = prompt("Enter study session title:", "New Study Session");
    if (!title || !title.trim()) {
      showNotification("Event title is required", 3000);
      return;
    }

    try {
      const created = await createEventOnServer({
        title: title.trim(),
        start: info.startStr,
        end: info.endStr,
      });
      setEventsWithMetrics((prev) => [...prev, created]);
      showNotification("Event created successfully", 3000);
    } catch (err) {
      const errorMessage =
        err.message || err.data?.message || "Failed to create event";
      if (err.status === 409) {
        setError(`Conflict: ${errorMessage}`);
      } else if (err.status === 400) {
        setError(`Validation error: ${errorMessage}`);
      } else {
        setError(errorMessage);
      }
      setTimeout(() => setError(""), 5000);
    }
  }

  // Create event by clicking single slot
  async function handleDateClick(info) {
    const title = prompt("Quick session title:", "New Session");
    if (!title || !title.trim()) {
      showNotification("Event title is required", 3000);
      return;
    }

    const start = info.date;
    const end = new Date(info.date.getTime() + 60 * 60 * 1000);

    try {
      const created = await createEventOnServer({
        title: title.trim(),
        start,
        end,
      });
      setEventsWithMetrics((prev) => [...prev, created]);
      showNotification("Event created successfully", 3000);
    } catch (err) {
      const errorMessage =
        err.message || err.data?.message || "Failed to create event";
      if (err.status === 409) {
        setError(`Conflict: ${errorMessage}`);
      } else if (err.status === 400) {
        setError(`Validation error: ${errorMessage}`);
      } else {
        setError(errorMessage);
      }
      setTimeout(() => setError(""), 5000);
    }
  }

  // Move sessions
  async function handleEventDrop(info) {
    const event = info.event;

    // Validate dates
    if (!event.start) {
      setError("Invalid event start time");
      info.revert();
      return;
    }

    const start =
      event.start instanceof Date ? event.start : new Date(event.start);
    const end = event.end
      ? event.end instanceof Date
        ? event.end
        : new Date(event.end)
      : null;

    if (end && end <= start) {
      setError("End time must be after start time");
      info.revert();
      setTimeout(() => setError(""), 4000);
      return;
    }

    try {
      await updateEventOnServer(event.id, {
        title: event.title,
        start: event.start,
        end: event.end,
      });

      setEventsWithMetrics((prev) =>
        prev.map((e) =>
          e.id === event.id
            ? decorateEventColors({
                ...e,
                title: event.title,
                start: event.start?.toISOString?.() ?? event.start,
                end: event.end?.toISOString?.() ?? event.end,
                allDay: false,
              })
            : e
        )
      );
      showNotification("Event moved successfully", 3000);
    } catch (err) {
      console.error("Failed to move event", err);
      const errorMessage = err.message || err.data?.message || "Unknown error";
      if (err.status === 409) {
        setError(`Conflict: ${errorMessage}`);
      } else if (err.status === 400) {
        setError(`Validation error: ${errorMessage}`);
      } else {
        setError(`Failed to update event: ${errorMessage}`);
      }
      setTimeout(() => setError(""), 5000);
      info.revert();
    }
  }

  // Resize sessions
  async function handleEventResize(info) {
    const event = info.event;

    // Validate dates
    if (!event.start || !event.end) {
      setError("Invalid event time");
      info.revert();
      return;
    }

    const start =
      event.start instanceof Date ? event.start : new Date(event.start);
    const end = event.end instanceof Date ? event.end : new Date(event.end);

    if (end <= start) {
      setError("End time must be after start time");
      info.revert();
      setTimeout(() => setError(""), 4000);
      return;
    }

    // Validate minimum duration (15 minutes)
    const durationMinutes = (end - start) / (1000 * 60);
    if (durationMinutes < 15) {
      setError("Event duration must be at least 15 minutes");
      info.revert();
      setTimeout(() => setError(""), 4000);
      return;
    }

    try {
      await updateEventOnServer(event.id, {
        title: event.title,
        start: event.start,
        end: event.end,
      });

      setEventsWithMetrics((prev) =>
        prev.map((e) =>
          e.id === event.id
            ? decorateEventColors({
                ...e,
                title: event.title,
                start: event.start?.toISOString?.() ?? event.start,
                end: event.end?.toISOString?.() ?? event.end,
                allDay: false,
              })
            : e
        )
      );
      showNotification("Event resized successfully", 3000);
    } catch (err) {
      console.error("Failed to resize event", err);
      const errorMessage = err.message || err.data?.message || "Unknown error";
      if (err.status === 409) {
        setError(`Conflict: ${errorMessage}`);
      } else if (err.status === 400) {
        setError(`Validation error: ${errorMessage}`);
      } else {
        setError(`Failed to update event: ${errorMessage}`);
      }
      setTimeout(() => setError(""), 5000);
      info.revert();
    }
  }

  // Hover effects for better UX
  function handleEventMouseEnter(info) {
    const el = info.el;
    el.style.cursor = "grab";
    el.style.transform = "scale(1.02)";
    el.style.transition = "transform 0.1s ease";
  }

  function handleEventMouseLeave(info) {
    const el = info.el;
    el.style.cursor = "default";
    el.style.transform = "scale(1)";
  }

  // Add drag indicator to events
  function handleEventDidMount(info) {
    // Add a subtle drag indicator
    const eventEl = info.el;
    eventEl.title = `${info.event.title} - Click to edit, drag to reschedule`;
  }

  // Open edit modal for event
  function handleEventClick(info) {
    const event = info.event;
    const currentEvent = events.find((e) => e.id === event.id);

    setEditingEvent({
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      courseModuleId: currentEvent?.courseModuleId,
      courseModule: currentEvent?.courseModule,
    });

    setEditForm({
      title: event.title,
      start: toLocalDateTimeInput(event.start),
      end: toLocalDateTimeInput(event.end),
      linkToModule: "",
      unlinkFromModule: false,
      markComplete: !!currentEvent?.courseModule?.isCompleted,
    });

    setShowEditModal(true);
  }

  // Handle saving changes from the edit modal
  const handleSaveEvent = async () => {
    if (!editingEvent) return;

    // Validation
    if (!editForm.title.trim()) {
      setError("Event title is required");
      return;
    }

    if (!editForm.start) {
      setError("Start time is required");
      return;
    }

    const startDate = new Date(editForm.start);
    const endDate = editForm.end ? new Date(editForm.end) : null;

    if (endDate && startDate >= endDate) {
      setError("End time must be after start time");
      return;
    }

    setError("");

    try {
      // Handle unlinking from module first
      if (editForm.unlinkFromModule && editingEvent.courseModuleId) {
        await handleUnlinkFromModule(editingEvent.id);
      }

      // Handle linking to module
      if (editForm.linkToModule && !editingEvent.courseModuleId) {
        const moduleId = parseInt(editForm.linkToModule);
        await handleLinkToModule(editingEvent.id, moduleId);
      }

      // Optionally mark linked module complete/incomplete
      let moduleCompletionChanged = false;
      if (!editForm.unlinkFromModule && editingEvent.courseModuleId) {
        const currentCompleted = !!editingEvent.courseModule?.isCompleted;
        if (editForm.markComplete !== currentCompleted) {
          // For manual completion via schedule, always require the quiz modal.
          if (editForm.markComplete) {
            setQuizModal({
              isOpen: true,
              moduleId: editingEvent.courseModuleId,
              moduleTitle: editingEvent.courseModule?.title || "Module",
            });
            // Do not mark complete yet; quiz will handle completion.
          } else {
            await courseApi.setModuleCompletion(
              editingEvent.courseModuleId,
              false
            );
            moduleCompletionChanged = true;
          }
        }
      }

      // Check if any event properties changed
      const startChanged =
        editForm.start !== toLocalDateTimeInput(editingEvent.start);
      const endChanged =
        editForm.end !== toLocalDateTimeInput(editingEvent.end);
      const titleChanged = editForm.title !== editingEvent.title;
      const shouldUpdateEvent = titleChanged || startChanged || endChanged;

      const startDate = editForm.start ? new Date(editForm.start) : null;
      const endDate = editForm.end ? new Date(editForm.end) : null;

      // Local helper to avoid duplication
      const applyLocalUpdate = () =>
        setEventsWithMetrics((prev) =>
          prev.map((e) =>
            e.id === editingEvent.id
              ? decorateEventColors({
                  ...e,
                  title: editForm.title,
                  start: startDate,
                  end: endDate,
                  allDay: false,
                  startUtc: startDate?.toISOString(),
                  endUtc: endDate?.toISOString(),
                  courseModule: moduleCompletionChanged
                    ? {
                        ...e.courseModule,
                        isCompleted: editForm.markComplete,
                      }
                    : e.courseModule,
                })
              : e
          )
        );

      // Update event if any properties changed
      if (shouldUpdateEvent) {
        await updateEventOnServer(editingEvent.id, {
          title: editForm.title,
          start: startDate,
          end: endDate,
        });

        if (moduleCompletionChanged) {
          await loadEvents();
          await loadAvailableModules();
        } else {
          applyLocalUpdate();
        }
      }

      if (!shouldUpdateEvent && moduleCompletionChanged) {
        await loadEvents();
        await loadAvailableModules();
      }

      setShowEditModal(false);
      setEditingEvent(null);
      showNotification("Event updated successfully", 3000);
    } catch (err) {
      const errorMessage =
        err.message || err.data?.message || "Failed to update event";
      if (err.status === 409) {
        setError(`Conflict: ${errorMessage}`);
      } else if (err.status === 400) {
        setError(`Validation error: ${errorMessage}`);
      } else {
        setError(errorMessage);
      }
    }
  };

  // Handle deleting event from modal
  const handleDeleteEvent = async () => {
    if (!editingEvent) return;

    if (confirm("Are you sure you want to delete this event?")) {
      try {
        await deleteEventOnServer(editingEvent.id);
        setEventsWithMetrics((prev) =>
          prev.filter((e) => e.id !== editingEvent.id)
        );
        setShowEditModal(false);
        setEditingEvent(null);
      } catch (err) {
        setError(err.message || "Failed to delete event");
      }
    }
  };

  const weeklyGoal = formatHours(weeklyMetrics.scheduled);
  const completedThisWeek = formatHours(weeklyMetrics.completed);

  if (loading && events.length === 0) {
    return (
      <section className={styles.page}>
        <Loading message="Loading schedule..." />
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <ErrorMessage
        error={error}
        onRetry={loadEvents}
        onDismiss={() => setError("")}
        title="Schedule error"
        variant="banner"
      />
      {notification && (
        <div className={styles.notification}>{notification}</div>
      )}

      <div className={styles.layout}>
        <div className={styles.leftPane}>
          <div className={styles.calendarCard}>
            <ScheduleCalendar
              calendarRef={calendarRef}
              events={events}
              onSelect={handleSelect}
              onDateClick={handleDateClick}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onEventClick={handleEventClick}
              onEventMouseEnter={handleEventMouseEnter}
              onEventMouseLeave={handleEventMouseLeave}
              onEventDidMount={handleEventDidMount}
            />
          </div>
        </div>

        <div className={styles.rightPane}>
          <div className={styles.sideCard}>
            <div className={styles.actionButtons}>
              {availableModules.length === 0 && courses.length > 0 ? (
                <div
                  style={{
                    padding: "12px",
                    textAlign: "center",
                    color: "var(--text-soft)",
                    fontSize: "0.9rem",
                  }}
                >
                  ✓ All modules are scheduled
                </div>
              ) : (
                <button
                  className={`${styles.primaryBtn} ${styles.compactBtn} ${styles.autoScheduleBtn}`}
                  type="button"
                  onClick={() => setShowAutoSchedule(true)}
                  disabled={loading || availableModules.length === 0}
                  title={
                    availableModules.length === 0
                      ? "No modules available to schedule"
                      : ""
                  }
                >
                  <FiZap size={18} />
                  <span>Auto-schedule</span>
                  {availableModules.length > 0 && (
                    <span
                      style={{
                        marginLeft: "8px",
                        fontSize: "0.85em",
                        opacity: 0.8,
                      }}
                    >
                      ({availableModules.length})
                    </span>
                  )}
                </button>
              )}

              <button
                className={`${styles.dangerBtn} ${styles.resetIconBtn}`}
                type="button"
                onClick={() => setShowResetConfirm(true)}
                disabled={loading}
                aria-label="Reset schedule"
                title="Reset schedule"
              >
                <span className={styles.resetGlyph} aria-hidden="true">
                  ↻
                </span>
              </button>
            </div>
          </div>

          <div className={styles.sideCard}>
            <MetricsRow
              weeklyGoal={weeklyGoal}
              completedThisWeek={completedThisWeek}
              loading={false}
            />
          </div>

          <NextSessions events={events} />
        </div>
      </div>

      {/* Auto-schedule options */}
      <AutoScheduleModal
        isOpen={showAutoSchedule}
        autoOptions={autoOptions}
        onChange={updateAutoOptions}
        courses={courses}
        onToggleCourse={toggleCourseSelection}
        onMoveCourse={moveCourseSelection}
        onClose={() => setShowAutoSchedule(false)}
        onSubmit={handleAutoSchedule}
        loading={loading}
        error={error}
      />

      {/* Edit Event Modal */}
      <EditEventModal
        isOpen={showEditModal}
        editingEvent={editingEvent}
        availableModules={availableModules}
        editForm={editForm}
        onChange={updateEditForm}
        onDelete={handleDeleteEvent}
        onSave={handleSaveEvent}
        onClose={() => {
          setShowEditModal(false);
          setEditingEvent(null);
          setError("");
        }}
        error={error}
      />

      {/* Reset schedule confirmation */}
      <ResetScheduleModal
        isOpen={showResetConfirm}
        error={error}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetSchedule}
        loading={loading}
      />

      {/* Reminder modal for missed events - user must manually reschedule */}
      <RescheduleModal
        isOpen={showRescheduleModal}
        onClose={handleDismissMissedEvents}
        missedEvents={missedEvents}
        onDismiss={handleDismissMissedEvents}
      />

      <QuizModal
        moduleId={quizModal.moduleId}
        moduleTitle={quizModal.moduleTitle}
        isOpen={quizModal.isOpen}
        allowRetake={Boolean(
          availableModules?.some((m) => m.id === quizModal.moduleId)
        )}
        onClose={() =>
          setQuizModal({ isOpen: false, moduleId: null, moduleTitle: "" })
        }
        onQuizPassed={async () => {
          if (!quizModal.moduleId) return;
          try {
            await courseApi.setModuleCompletion(quizModal.moduleId, true);
            await loadEvents();
            await loadAvailableModules();
          } catch (err) {
            setError(err?.message || "Failed to mark module as complete");
          }
        }}
      />
    </section>
  );
}
