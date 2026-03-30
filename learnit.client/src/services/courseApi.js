/**
 * Course API - Course management endpoints
 */
import http from "./http";

export const courseApi = {
  // Course CRUD
  async getCourses(params = {}) {
    const queryParams = new URLSearchParams();
    if (params.search) queryParams.append("search", params.search);
    if (params.priority) queryParams.append("priority", params.priority);
    if (params.difficulty) queryParams.append("difficulty", params.difficulty);
    if (params.duration) queryParams.append("duration", params.duration);
    if (params.sortBy) queryParams.append("sortBy", params.sortBy);
    if (params.sortOrder) queryParams.append("sortOrder", params.sortOrder);

    const queryString = queryParams.toString();
    const endpoint = `/api/courses${queryString ? `?${queryString}` : ""}`;
    return http.get(endpoint);
  },

  async getCourse(id) {
    return http.get(`/api/courses/${id}`);
  },

  async createCourse(courseData) {
    return http.post("/api/courses", courseData);
  },

  async updateCourse(id, courseData) {
    return http.put(`/api/courses/${id}`, courseData);
  },

  async editCourse(id, courseData) {
    return http.put(`/api/courses/${id}/edit`, courseData);
  },

  async deleteCourse(id) {
    return http.delete(`/api/courses/${id}`);
  },

  async getCourseStats() {
    return http.get("/api/courses/stats");
  },

  // Module Management
  async updateModule(moduleId, updates) {
    return http.put(`/api/courses/modules/${moduleId}`, updates);
  },

  async toggleModuleCompletion(moduleId) {
    return http.patch(`/api/courses/modules/${moduleId}/toggle-completion`, {});
  },

  async setModuleCompletion(moduleId, isCompleted) {
    return http.patch(`/api/courses/modules/${moduleId}/set-completion`, { isCompleted });
  },

  async createModule(courseId, payload) {
    return http.post(`/api/courses/${courseId}/modules`, payload);
  },

  // External Links
  async addExternalLink(courseId, link) {
    return http.post(`/api/courses/${courseId}/external-links`, link);
  },

  async updateExternalLink(linkId, updates) {
    return http.put(`/api/courses/external-links/${linkId}`, updates);
  },

  async deleteExternalLink(linkId) {
    return http.delete(`/api/courses/external-links/${linkId}`);
  },

  // Active Time Tracking
  async updateChapterProgress(courseId, chapterTitle, chapterIndex, watchedPercent) {
    return http.post("/api/progress/chapter-progress", {
      courseId,
      chapterTitle,
      chapterIndex,
      watchedPercent,
    });
  },

  async updateCourseActiveTime(courseId, hours) {
    return http.post(`/api/courses/${courseId}/active-time`, { hours });
  },

  // Study Sessions
  async startStudySession(courseId, moduleId = null) {
    const params = moduleId ? `?moduleId=${moduleId}` : "";
    return http.post(`/api/courses/${courseId}/sessions/start${params}`, {});
  },

  async stopStudySession(sessionId, notes = "") {
    return http.put(`/api/courses/sessions/${sessionId}/stop`, notes);
  },

  async getCourseSessions(courseId) {
    return http.get(`/api/courses/${courseId}/sessions`);
  },

  // Playback Position (for YouTube videos - persists across logout/login)
  async savePlaybackPosition(courseId, data) {
    return http.post(`/api/courses/${courseId}/playback-position`, {
      moduleId: data.moduleId || null,
      videoId: data.videoId || "",
      playlistId: data.playlistId || "",
      currentTimeSeconds: data.currentTimeSeconds || 0,
      durationSeconds: data.durationSeconds || 0,
    });
  },

  async getPlaybackPosition(courseId, videoId, moduleId = null) {
    const params = new URLSearchParams({ videoId });
    if (moduleId) params.append("moduleId", moduleId);
    return http.get(`/api/courses/${courseId}/playback-position?${params.toString()}`);
  },

  async sendTestReminder(courseId) {
    return http.post(`/api/courses/${courseId}/reminder/test`, {});
  },

  async issueCertificate(courseId) {
    return http.post(`/api/courses/${courseId}/certificate/issue`, {});
  },
};
