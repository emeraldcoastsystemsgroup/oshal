/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Carved out of jarvis-ambient.js (over the 1000-code-line cap): the shared constants, settings normalization/sanitizers, wake-phrase parsing, and pending-segment coalescing now live here as the JarvisAmbientCore namespace. Pure decomposition — every constant and function body is verbatim from jarvis-ambient.js; behavior is unchanged. Must load before jarvis-ambient-ui.js, jarvis-ambient-recognition.js, and jarvis-ambient.js.
 */

(function attachJarvisAmbientCore(root) {
  'use strict';

  /*
   * Pure, DOM-free foundation of the ambient client: tuning constants, the
   * settings normalization pipeline, wake-phrase parsing, and streaming-segment
   * coalescing. No state lives here; jarvis-ambient.js (the coordinator) and the
   * jarvis-ambient-ui/recognition method bags consume this namespace.
   */

  const STORAGE_KEY = 'oshal.jarvis.ambient.settings.v1';
  const DEFAULT_API_BASE = '/api/jarvis/ambient';
  const MAX_PENDING_SEGMENTS = 5000;
  const BATCH_SIZE = 12;
  const FLUSH_DELAY_MS = 5000;
  const SEGMENT_COALESCE_WINDOW_MS = 15000;
  const ARMED_WINDOW_MS = 12000;
  const SPEAKER_ACK_TIMEOUT_MS = 155000;
  const RETENTION_OPTIONS = new Set([1, 7, 30, 90, 365]);

  const STATE_COPY = Object.freeze({
    paused: ['Always listening: OFF', 'Tap to enable wake word and transcript memory'],
    starting: ['Always listening: STARTING', 'Waiting for microphone permission'],
    listening: ['Always listening: ON', 'Listening for your wake word and saving transcript text'],
    armed: ['Jarvis is awake', 'Listening for your command'],
    hidden: ['Always listening: PAUSED', 'Return to this tab to resume'],
    reconnecting: ['Always listening: RECONNECTING', 'Speech recognition will resume automatically'],
    blocked: ['Always listening needs permission', 'Allow microphone access in browser settings'],
    unsupported: ['Always listening unavailable', 'Use current Chrome or Edge'],
    offline: ['Always listening: OFFLINE', 'Transcript text is waiting in this tab'],
    error: ['Always listening needs attention', 'Open settings for details'],
  });

  function defaultSettings(name) {
    const assistantName = sanitizeName(name || 'Jarvis');
    return {
      enabled: false,
      assistantName,
      wakePhrases: [`Hey ${assistantName}`, assistantName],
      locale: 'en-US',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      retentionDays: 30,
      dailyReviewEnabled: false,
      dailyReviewTime: '21:00',
      suggestFollowUps: true,
      speakerDiarizationEnabled: false,
      rememberSpeakers: false,
      speakerTenantId: null,
    };
  }

  function sanitizeName(value) {
    const clean = String(value || '').replace(/[^\p{L}\p{N} '\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return clean || 'Jarvis';
  }

  function sanitizePhrase(value) {
    return String(value || '').replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function normalizePhrases(value, assistantName) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,]+/);
    const unique = [];
    for (const candidate of source) {
      const phrase = sanitizePhrase(candidate);
      if (phrase && !unique.some((item) => item.toLowerCase() === phrase.toLowerCase())) unique.push(phrase);
      if (unique.length === 8) break;
    }
    return unique.length ? unique : [`Hey ${assistantName}`, assistantName];
  }

  function normalizeSettings(value, prior) {
    const source = value && typeof value === 'object' ? value : {};
    const base = prior || defaultSettings(source.assistantName);
    const assistantName = sanitizeName(source.assistantName || base.assistantName);
    const retention = Number(source.retentionDays ?? source.transcriptRetentionDays ?? base.retentionDays);
    const enabled = source.enabled ?? source.ambientEnabled;
    return {
      enabled: enabled === undefined ? Boolean(base.enabled) : Boolean(enabled),
      assistantName,
      wakePhrases: normalizePhrases(source.wakePhrases ?? base.wakePhrases, assistantName),
      locale: sanitizeLocale(source.locale || base.locale),
      timeZone: sanitizeTimeZone(source.timeZone || base.timeZone),
      retentionDays: RETENTION_OPTIONS.has(retention) ? retention : 30,
      dailyReviewEnabled: source.dailyReviewEnabled === undefined
        ? Boolean(base.dailyReviewEnabled) : Boolean(source.dailyReviewEnabled),
      dailyReviewTime: sanitizeTime(source.dailyReviewTime || base.dailyReviewTime),
      suggestFollowUps: source.suggestFollowUps === undefined
        ? Boolean(base.suggestFollowUps) : Boolean(source.suggestFollowUps),
      speakerDiarizationEnabled: source.speakerDiarizationEnabled === undefined
        ? Boolean(base.speakerDiarizationEnabled) : Boolean(source.speakerDiarizationEnabled),
      rememberSpeakers: source.rememberSpeakers === undefined
        ? Boolean(base.rememberSpeakers) : Boolean(source.rememberSpeakers),
      speakerTenantId: sanitizeTenantId(source.speakerTenantId ?? base.speakerTenantId),
    };
  }

  function settingsForApi(settings) {
    return {
      assistantName: settings.assistantName,
      wakePhrases: settings.wakePhrases,
      ambientEnabled: settings.enabled,
      transcriptRetentionDays: settings.retentionDays,
      timeZone: settings.timeZone,
      dailyReviewEnabled: settings.dailyReviewEnabled,
      dailyReviewTime: settings.dailyReviewTime,
      suggestFollowUps: settings.suggestFollowUps,
      speakerDiarizationEnabled: settings.speakerDiarizationEnabled,
      rememberSpeakers: settings.rememberSpeakers,
      speakerTenantId: settings.speakerTenantId,
    };
  }

  function sanitizeLocale(value) {
    const clean = String(value || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24);
    return clean || 'en-US';
  }

  function sanitizeTime(value) {
    const clean = String(value || '21:00');
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(clean) ? clean : '21:00';
  }

  function sanitizeTimeZone(value) {
    const clean = String(value || '').replace(/[^a-zA-Z0-9_+\-/]/g, '').slice(0, 80);
    return clean || 'UTC';
  }

  function sanitizeTenantId(value) {
    const clean = String(value || '').trim();
    return /^[a-zA-Z0-9_-]{1,128}$/.test(clean) ? clean : null;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function phrasePattern(phrase) {
    return escapeRegExp(phrase).replace(/\s+/g, '[\\s,;:!?._-]+');
  }

  /**
   * @description Detects a wake phrase only at the beginning of a finalized utterance, preventing incidental mid-sentence mentions from dispatching commands.
   * @param {string} transcript Finalized speech-recognition transcript.
   * @param {string[]} wakePhrases Configured phrases ordered by user preference.
   * @returns {{wakePhrase:string, command:string}|null} The matched phrase and trailing command, or null when the utterance is ambient-only.
   */
  function parseWakeCommand(transcript, wakePhrases) {
    const text = String(transcript || '').trim();
    const phrases = normalizePhrases(wakePhrases, 'Jarvis').sort((a, b) => b.length - a.length);
    for (const wakePhrase of phrases) {
      const pattern = new RegExp(`^\\s*${phrasePattern(wakePhrase)}(?:[\\s,;:!?._-]+|$)([\\s\\S]*)$`, 'i');
      const match = text.match(pattern);
      if (match) return { wakePhrase, command: String(match[1] || '').trim() };
    }
    return null;
  }

  function safeJsonParse(value) {
    try { return JSON.parse(value); } catch (_error) { return null; }
  }

  function createId(prefix) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return `${prefix}-${root.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function todayLocal() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function trapFocus(event, container) {
    if (!container) return;
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusable = [...container.querySelectorAll(selector)]
      .filter((node) => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  /**
   * @description Collapses streaming-recognizer output into the pending queue. Some engines
   * (notably Edge's Azure-backed webkitSpeechRecognition) mark every growing hypothesis of one
   * utterance as final, so trusting isFinal alone persisted each prefix as its own segment. A
   * candidate that repeats, extends, or shrinks the newest replaceable pending segment within
   * the coalesce window supersedes it in place — keeping the original clientSegmentId and
   * capturedAt — instead of appending. Entries below frozenCount are part of an in-flight
   * flush batch and are never replaced: superseding one would let the flush completion splice
   * away text the server never received.
   * @param {Array<object>} pending Pending segment queue, newest last; mutated in place.
   * @param {object} segment Normalized candidate segment for the newest recognizer text.
   * @param {number} windowMs Maximum age of the newest pending segment for it to be superseded.
   * @param {number} frozenCount Count of head entries currently inside an in-flight flush.
   * @returns {object} The segment now representing the utterance (kept or appended).
   */
  function coalescePendingSegment(pending, segment, windowMs, frozenCount) {
    const lastIndex = pending.length - 1;
    const last = lastIndex >= 0 ? pending[lastIndex] : null;
    if (last && lastIndex >= (frozenCount || 0) && last.sessionId === segment.sessionId) {
      const lastText = String(last.text).trim().toLowerCase();
      const nextText = String(segment.text).trim().toLowerCase();
      const ageMs = Date.parse(segment.capturedAt) - Date.parse(last.capturedAt);
      const inWindow = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= windowMs;
      if (inWindow && lastText && nextText.startsWith(lastText)) {
        segment.clientSegmentId = last.clientSegmentId;
        segment.capturedAt = last.capturedAt;
        pending[lastIndex] = segment;
        return segment;
      }
      // The recognizer re-hypothesized shorter text: the fuller pending entry stays.
      if (inWindow && nextText && lastText.startsWith(nextText)) return last;
    }
    pending.push(segment);
    return segment;
  }

  /**
   * @description Shared foundation namespace for the ambient client siblings: tuning constants,
   * the settings normalization/sanitization pipeline, wake-phrase parsing, id/date utilities,
   * modal focus trapping, and streaming-hypothesis coalescing. Load-order contract: this file
   * must execute before jarvis-ambient-ui.js, jarvis-ambient-recognition.js, and jarvis-ambient.js.
   */
  root.JarvisAmbientCore = Object.freeze({
    STORAGE_KEY,
    DEFAULT_API_BASE,
    MAX_PENDING_SEGMENTS,
    BATCH_SIZE,
    FLUSH_DELAY_MS,
    SEGMENT_COALESCE_WINDOW_MS,
    ARMED_WINDOW_MS,
    SPEAKER_ACK_TIMEOUT_MS,
    RETENTION_OPTIONS,
    STATE_COPY,
    defaultSettings,
    sanitizeName,
    sanitizePhrase,
    normalizePhrases,
    normalizeSettings,
    settingsForApi,
    sanitizeLocale,
    sanitizeTime,
    sanitizeTimeZone,
    sanitizeTenantId,
    parseWakeCommand,
    safeJsonParse,
    createId,
    todayLocal,
    trapFocus,
    coalescePendingSegment,
  });
}(typeof window !== 'undefined' ? window : globalThis));
