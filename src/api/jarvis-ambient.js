/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the opt-in ambient speech client with configurable wake phrases, transcript batching, daily transcript/review controls, and privacy-safe lifecycle handling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added speaker-recognition settings transport, trusted audio-path transcript handoff, honest ephemeral-audio disclosure, and speaker labels in transcript history.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Made consent changes synchronous, reconciled rejected settings, added explicit diarization acknowledgements with text fallback, and completed modal focus/inert behavior.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Promoted the under-orb control with explicit Always listening ON/OFF state and wake-word/transcript copy.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Coalesced streaming recognizer hypotheses in the pending queue: engines that mark every growing hypothesis final (Edge) were persisting each prefix as its own segment (~40 rows for one sentence, observed live 2026-07-11); in-flight flush batches stay frozen so a supersede can never drop an already-sent segment's fuller text.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed the over-cap file (~1044 code lines > the 1000 hard cap) into load-ordered classic-script siblings: constants + pure helpers moved to jarvis-ambient-core.js, panel/transcript UI methods to jarvis-ambient-ui.js, recognition/wake/diarization methods to jarvis-ambient-recognition.js. This file is now the coordinator: AmbientClient shell, settings sync, segment queue/flush, and the unchanged public JarvisAmbient API. Pure decomposition — all bodies verbatim; behavior is unchanged.
 */

(function attachJarvisAmbient(root) {
  'use strict';

  /*
   * Jarvis integration (the module never reaches into jarvis.html globals):
   *
   *   const ambient = JarvisAmbient.mount({
   *     mountTarget: document.querySelector('.hero'),
   *     onWakeCommand: ({ command }) => handleInput(command),
   *   });
   *
   * The client also bubbles jarvis:ambient-command, jarvis:ambient-segment,
   * jarvis:ambient-open-transcript, and jarvis:ambient-review-requested DOM events.
   * Call ambient.setAssistantSpeaking(true/false), or dispatch the document events
   * jarvis:speaking-start / jarvis:speaking-end, around TTS. A speechSynthesis monitor
   * supplies a fallback so the assistant's own voice is not transcribed.
   * Call ambient.suspend('Using push-to-talk') before Jarvis's manual microphone and
   * ambient.resume() after it finishes so two recognition sessions never compete.
   *
   * API contract:
   *   GET/PUT /api/jarvis/ambient/settings
   *   POST    /api/jarvis/ambient/segments
   *   GET     /api/jarvis/ambient/days/:date
   *   POST    /api/jarvis/ambient/days/:date/review
   *
   * File layout (classic scripts, load-ordered by jarvis.html):
   *   jarvis-ambient-core.js        → JarvisAmbientCore (constants + pure helpers)
   *   jarvis-ambient-ui.js          → JarvisAmbientUi (panel template + UI prototype methods)
   *   jarvis-ambient-recognition.js → JarvisAmbientRecognition (listening prototype methods)
   *   jarvis-ambient.js (this file) → coordinator class + the public JarvisAmbient API
   */

  if (!root.JarvisAmbientCore || !root.JarvisAmbientUi || !root.JarvisAmbientRecognition) {
    throw new Error('jarvis-ambient.js requires jarvis-ambient-core.js, jarvis-ambient-ui.js, and jarvis-ambient-recognition.js to load first');
  }

  const {
    STORAGE_KEY, DEFAULT_API_BASE, MAX_PENDING_SEGMENTS, BATCH_SIZE, FLUSH_DELAY_MS,
    SEGMENT_COALESCE_WINDOW_MS, SPEAKER_ACK_TIMEOUT_MS,
    defaultSettings, normalizeSettings, settingsForApi, parseWakeCommand, safeJsonParse,
    createId, coalescePendingSegment,
  } = root.JarvisAmbientCore;
  const { htmlTemplate } = root.JarvisAmbientUi;

  class AmbientClient {
    constructor(options) {
      this.options = options || {};
      this.apiBase = String(this.options.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
      this.settings = defaultSettings(this.options.assistantName);
      this.supported = Boolean(root.SpeechRecognition || root.webkitSpeechRecognition);
      this.sessionId = createId('ambient');
      this.pending = [];
      this.savedCount = 0;
      this.recognition = null;
      this.recognitionRunning = false;
      this.stopRequested = false;
      this.destroyed = false;
      this.assistantSpeaking = false;
      this.externallySuspended = false;
      this.permissionBlocked = false;
      this.armedUntil = 0;
      this.restartAttempts = 0;
      this.flushTimer = null;
      this.restartTimer = null;
      this.speechMonitor = null;
      this.lastError = '';
      this.handlers = [];
      this.settingsRevision = 0;
      this.pendingDiarization = new Map();
      this.speakerPersistenceAvailable = null;
      this.speakerCaptureAvailable = null;
      this.speakerDialogOpen = false;
      this.settingsReturnFocus = null;
      const requestedAckTimeout = Number(this.options.speakerAckTimeoutMs);
      this.speakerAckTimeoutMs = Number.isFinite(requestedAckTimeout)
        ? Math.min(SPEAKER_ACK_TIMEOUT_MS, Math.max(50, Math.floor(requestedAckTimeout)))
        : SPEAKER_ACK_TIMEOUT_MS;
    }

    mount() {
      const target = this.resolveTarget();
      this.element = document.createElement('div');
      this.element.className = 'jarvis-ambient';
      this.element.innerHTML = htmlTemplate();
      target.appendChild(this.element);
      this.cacheElements();
      this.bindUi();
      this.bindLifecycle();
      this.renderSettings();
      this.setState(this.supported ? 'paused' : 'unsupported');
      void this.initialize();
      return this;
    }

    resolveTarget() {
      const target = this.options.mountTarget;
      if (typeof target === 'string') return document.querySelector(target) || document.body;
      return target && typeof target.appendChild === 'function' ? target : document.body;
    }

    bindLifecycle() {
      this.on(document, 'visibilitychange', () => this.handleVisibility());
      this.on(root, 'online', () => this.handleOnline());
      this.on(root, 'offline', () => this.handleOffline());
      this.on(root, 'pagehide', () => {
        this.releaseAllDiarizationFallback('page_exit');
        this.flushOnExit();
      });
      this.on(document, 'jarvis:speaking-start', () => this.setAssistantSpeaking(true));
      this.on(document, 'jarvis:speaking-end', () => this.setAssistantSpeaking(false));
      this.on(document, 'jarvis:speakers-transcript-outcome', (event) => this.handleSpeakerTranscriptOutcome(event));
      this.on(document, 'jarvis:speakers-capture-state', (event) => this.handleSpeakerCaptureState(event));
      this.on(document, 'jarvis:ambient-settings-changed', (event) => this.handleExternalSettingsChange(event));
      this.on(document, 'jarvis:speakers-refreshed', (event) => this.handleSpeakerContext(event));
      this.on(document, 'jarvis:speakers-opened', () => this.setSpeakerDialogOpen(true));
      this.on(document, 'jarvis:speakers-closed', () => this.setSpeakerDialogOpen(false));
      this.on(document, 'keydown', (event) => this.handleSettingsKeydown(event));
      this.speechMonitor = root.setInterval(() => this.monitorSpeechSynthesis(), 300);
    }

    on(target, event, handler) {
      target.addEventListener(event, handler);
      this.handlers.push([target, event, handler]);
    }

    async initialize() {
      const local = this.readLocalSettings();
      if (local) this.settings = normalizeSettings(local, this.settings);
      const [settingsResult, contextResult] = await Promise.allSettled([
        this.fetchJson(`${this.apiBase}/settings`),
        this.fetchJson(`${this.apiBase}/speaker-context`),
      ]);
      if (settingsResult.status === 'fulfilled') {
        const remote = settingsResult.value;
        this.settings = normalizeSettings(remote.settings || remote, this.settings);
      } else {
        this.reportError(settingsResult.reason, 'Settings are using this device until server sync is available', false);
      }
      if (contextResult.status === 'fulfilled') {
        const payload = contextResult.value;
        const context = payload && typeof payload === 'object' ? (payload.context || payload) : {};
        if (context.reason === 'public_tenant') {
          this.speakerPersistenceAvailable = false;
          this.settings = { ...this.settings, rememberSpeakers: false, speakerTenantId: null };
        } else {
          this.speakerPersistenceAvailable = true;
        }
      }
      this.writeLocalSettings();
      this.renderSettings();
      if (this.settings.enabled) this.startRecognition(false);
      this.emit('jarvis:ambient-ready', { settings: { ...this.settings } });
    }

    readLocalSettings() {
      try { return safeJsonParse(root.localStorage.getItem(STORAGE_KEY)); }
      catch (error) { this.reportError(error, 'Browser settings storage is unavailable', false); return null; }
    }

    writeLocalSettings() {
      try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); }
      catch (error) { this.reportError(error, 'Browser settings storage is unavailable', false); }
    }

    async saveForm() {
      const previous = { ...this.settings };
      const next = this.settingsFromForm();
      const revision = this.commitSettings(next, previous);
      try {
        const saved = await this.fetchJson(`${this.apiBase}/settings`, { method: 'PUT', body: settingsForApi(next) });
        this.reconcileSavedSettings(saved, revision);
        this.setNotice('Settings saved.');
      } catch (error) {
        await this.handleSettingsSaveError(error, previous, revision);
      }
    }

    commitSettings(next, previous) {
      this.settingsRevision += 1;
      this.settings = normalizeSettings(next, previous || this.settings);
      this.writeLocalSettings();
      this.applyRecognitionChanges(previous || this.settings);
      if (previous?.speakerDiarizationEnabled && !this.settings.speakerDiarizationEnabled) {
        this.releaseAllDiarizationFallback('diarization_disabled');
      }
      this.renderSettings();
      // Consent changes must reach the independent MediaRecorder before any network wait.
      this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
      return this.settingsRevision;
    }

    reconcileSavedSettings(payload, revision) {
      if (revision !== this.settingsRevision) return;
      const source = payload && typeof payload === 'object' ? (payload.settings || payload) : null;
      if (!source || typeof source !== 'object') return;
      const reconciled = normalizeSettings(source, this.settings);
      if (JSON.stringify(reconciled) === JSON.stringify(this.settings)) return;
      const previous = { ...this.settings };
      this.settings = reconciled;
      this.writeLocalSettings();
      this.applyRecognitionChanges(previous);
      this.renderSettings();
      this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
    }

    async handleSettingsSaveError(error, previous, revision) {
      if (revision !== this.settingsRevision) return;
      const status = Number(error && error.status);
      const code = String(error && error.code || '');
      if (status >= 400 && status < 500) {
        let restored = previous;
        if (code === 'public_tenant_profile_forbidden') {
          restored = { ...restored, rememberSpeakers: false, speakerTenantId: null };
          this.speakerPersistenceAvailable = false;
        }
        const attempted = { ...this.settings };
        this.settings = normalizeSettings(restored, previous);
        this.writeLocalSettings();
        this.applyRecognitionChanges(attempted);
        this.renderSettings();
        this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
        const message = code === 'public_tenant_profile_forbidden'
          ? 'Guest and public sessions cannot remember voice profiles. That option was turned back off.'
          : 'The server did not accept those settings, so the previous settings were restored.';
        this.reportError(error, message, false);
        try {
          const remote = await this.fetchJson(`${this.apiBase}/settings`);
          if (revision !== this.settingsRevision) return;
          const authoritative = normalizeSettings(remote.settings || remote, this.settings);
          const current = { ...this.settings };
          this.settings = code === 'public_tenant_profile_forbidden'
            ? { ...authoritative, rememberSpeakers: false, speakerTenantId: null }
            : authoritative;
          this.writeLocalSettings();
          this.applyRecognitionChanges(current);
          this.renderSettings();
          this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
        } catch (_readError) {
          // The rejected PUT was atomic; the previous snapshot remains the safest rollback.
        }
        return;
      }
      this.reportError(error, 'Saved on this device; server settings sync is unavailable', false);
    }

    applyRecognitionChanges(previous) {
      if (previous.locale !== this.settings.locale) this.recreateRecognition();
      if (!this.settings.enabled) this.stopRecognition('paused');
      else if (!previous.enabled || previous.locale !== this.settings.locale) this.startRecognition(true);
      else this.refreshState();
    }

    async toggleEnabled() {
      if (!this.supported) { this.openSettings(); return; }
      if (this.state === 'blocked' && this.settings.enabled) {
        this.permissionBlocked = false;
        this.startRecognition(true);
        return;
      }
      const next = !this.settings.enabled;
      const previous = { ...this.settings };
      const candidate = { ...this.settings, enabled: next };
      const revision = this.commitSettings(candidate, previous);
      try {
        const saved = await this.fetchJson(`${this.apiBase}/settings`, { method: 'PUT', body: settingsForApi(candidate) });
        this.reconcileSavedSettings(saved, revision);
      } catch (error) {
        await this.handleSettingsSaveError(error, previous, revision);
      }
    }

    queueSegment(text, wake, capturedAt, clientSegmentId) {
      const segment = {
        clientSegmentId: clientSegmentId || createId('segment'), capturedAt: capturedAt || new Date().toISOString(),
        text: String(text).slice(0, 4000), speakerLabel: null,
        wakePhraseDetected: Boolean(wake), matchedWakePhrase: wake ? wake.wakePhrase : null,
        sessionId: this.sessionId,
      };
      const kept = coalescePendingSegment(
        this.pending, segment, SEGMENT_COALESCE_WINDOW_MS, this.flushing ? BATCH_SIZE : 0,
      );
      if (this.pending.length > MAX_PENDING_SEGMENTS) {
        this.pending.splice(0, this.pending.length - MAX_PENDING_SEGMENTS);
        this.reportError(new Error('ambient queue full'), 'This tab reached its offline transcript limit; reconnect to continue reliable saving', true);
      }
      this.updateSyncCopy();
      this.emit('jarvis:ambient-segment', { segment: { ...kept } });
      if (this.pending.length >= BATCH_SIZE) void this.flushSegments();
      else this.scheduleFlush();
    }

    scheduleFlush() {
      root.clearTimeout(this.flushTimer);
      this.flushTimer = root.setTimeout(() => void this.flushSegments(), FLUSH_DELAY_MS);
    }

    async flushSegments() {
      root.clearTimeout(this.flushTimer);
      if (this.flushing || !this.pending.length || root.navigator.onLine === false) return;
      this.flushing = true;
      const batch = this.pending.slice(0, BATCH_SIZE);
      try {
        await this.fetchJson(`${this.apiBase}/segments`, {
          method: 'POST', body: { clientSessionId: this.sessionId, segments: batch }, keepalive: true,
        });
        this.pending.splice(0, batch.length);
        this.savedCount += batch.length;
        this.emit('jarvis:ambient-synced', { count: batch.length, savedThisSession: this.savedCount });
      } catch (error) {
        this.reportError(error, 'Transcript text is waiting to sync', false);
      } finally {
        this.flushing = false;
        this.updateSyncCopy();
        if (this.pending.length) this.scheduleFlush();
      }
    }

    flushOnExit() {
      if (!this.pending.length || !root.navigator.sendBeacon) return;
      const payload = JSON.stringify({ clientSessionId: this.sessionId, segments: this.pending });
      try { root.navigator.sendBeacon(`${this.apiBase}/segments`, new Blob([payload], { type: 'application/json' })); }
      catch (error) { this.reportError(error, 'Transcript text could not be synced before exit', false); }
    }

    async fetchJson(url, options) {
      const config = options || {};
      const headers = { Accept: 'application/json', ...(config.headers || {}) };
      if (config.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await root.fetch(url, {
        method: config.method || 'GET', credentials: 'include', headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        keepalive: Boolean(config.keepalive),
      });
      const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.message || data.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = data.error || null;
        throw error;
      }
      return data;
    }

    handleOnline() {
      if (this.pending.length) void this.flushSegments();
      if (this.settings.enabled) this.startRecognition(false);
    }

    handleOffline() {
      this.releaseAllDiarizationFallback('offline');
      if (this.settings.enabled) this.setState('offline');
    }

    handleSpeakerContext(event) {
      const context = event?.detail?.context;
      if (!context || typeof context !== 'object') return;
      const publicSession = context.reason === 'public_tenant';
      this.speakerPersistenceAvailable = publicSession ? false
        : (context.voiceProfilesAvailable ? true : this.speakerPersistenceAvailable);
      if (publicSession && this.settings.rememberSpeakers) {
        const previous = { ...this.settings };
        this.settings = { ...this.settings, rememberSpeakers: false, speakerTenantId: null };
        this.writeLocalSettings();
        this.applyRecognitionChanges(previous);
        this.emit('jarvis:ambient-settings-changed', { settings: { ...this.settings } });
      }
      this.renderSettings();
    }

    handleExternalSettingsChange(event) {
      if (event.target === this.element) return;
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      const source = detail.settings && typeof detail.settings === 'object' ? detail.settings : detail;
      if (!source || typeof source !== 'object') return;
      this.settingsRevision += 1;
      const previous = { ...this.settings };
      this.settings = normalizeSettings(source, this.settings);
      this.writeLocalSettings();
      this.applyRecognitionChanges(previous);
      if (previous.speakerDiarizationEnabled && !this.settings.speakerDiarizationEnabled) {
        this.releaseAllDiarizationFallback('diarization_disabled');
      }
      this.renderSettings();
    }

    reportError(error, message, fatal) {
      this.lastError = message || (error && error.message) || 'Ambient listening error';
      if (this.ui) this.setNotice(this.lastError);
      this.emit('jarvis:ambient-error', { message: this.lastError, error });
      if (fatal) this.setState('error', this.lastError);
    }

    emit(name, detail, cancelable) {
      if (!this.element || typeof root.CustomEvent !== 'function') return null;
      const event = new root.CustomEvent(name, { detail, bubbles: true, cancelable: Boolean(cancelable) });
      this.element.dispatchEvent(event);
      return event;
    }

    destroy() {
      this.destroyed = true;
      this.stopRecognition();
      this.releaseAllDiarizationFallback('destroy');
      void this.flushSegments();
      root.clearTimeout(this.flushTimer);
      root.clearInterval(this.speechMonitor);
      this.handlers.forEach(([target, event, handler]) => target.removeEventListener(event, handler));
      if (this.element) this.element.remove();
      document.body.classList.remove('jarvis-ambient-open');
      this.pendingDiarization.clear();
    }
  }

  // The panel/transcript UI and recognition/diarization halves of AmbientClient live in the
  // load-ordered sibling files; merge them onto the prototype before the first mount().
  Object.assign(
    AmbientClient.prototype,
    root.JarvisAmbientUi.clientMethods,
    root.JarvisAmbientRecognition.clientMethods,
  );

  let activeClient = null;

  /**
   * @description Mounts one ambient-listening controller and returns its lifecycle handle; callers pass Jarvis's handleInput through onWakeCommand.
   * @param {{mountTarget?:Element|string,apiBase?:string,assistantName?:string,onWakeCommand?:Function}} options Integration options for placement, API routing, and command dispatch.
   * @returns {AmbientClient} The mounted client, including setAssistantSpeaking and destroy lifecycle methods.
   */
  function mount(options) {
    if (activeClient) activeClient.destroy();
    activeClient = new AmbientClient(options).mount();
    return activeClient;
  }

  /**
   * @description Tears down the active listener so page transitions cannot leave recognition or timers running.
   * @returns {void} No value is returned.
   */
  function unmount() {
    if (activeClient) activeClient.destroy();
    activeClient = null;
  }

  /**
   * @description Returns the current controller for explicit speech-synthesis suppression or integration diagnostics.
   * @returns {AmbientClient|null} The mounted controller, or null before mount/after unmount.
   */
  function getInstance() {
    return activeClient;
  }

  root.JarvisAmbient = Object.freeze({ mount, unmount, getInstance, parseWakeCommand, coalescePendingSegment });
}(typeof window !== 'undefined' ? window : globalThis));
