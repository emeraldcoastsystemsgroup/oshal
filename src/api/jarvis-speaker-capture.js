/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added ephemeral browser audio capture for deterministic diarization, recording import, and signed-in-user voice enrollment.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Closed late-permission and TTS races, bounded uploads and files, and added transcript outcome acknowledgements for lossless generic fallback.
 */

(function attachJarvisSpeakerCapture(root) {
  'use strict';

  const DEFAULT_API_BASE = '/api/jarvis/ambient';
  // Stay below the server's decoded-audio ceilings so timer/MediaRecorder stop
  // latency cannot turn an otherwise valid browser recording into a rejection.
  const CHUNK_DURATION_MS = 18000;
  const ENROLLMENT_DURATION_MS = 8000;
  const RECORDING_DURATION_MS = 30000;
  const MAX_RECORDING_DURATION_MS = 55000;
  const MAX_FILE_BYTES = 7 * 1024 * 1024;
  const MAX_IN_FLIGHT = 2;
  const MIN_AUDIO_BYTES = 800;
  const UPLOAD_TIMEOUT_MS = 120000;

  function createId(prefix) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return `${prefix}-${root.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function selectMimeType(MediaRecorderType) {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/mp4',
    ];
    if (!MediaRecorderType || typeof MediaRecorderType.isTypeSupported !== 'function') return '';
    return candidates.find((type) => MediaRecorderType.isTypeSupported(type)) || '';
  }

  function shouldCapture(settings, state) {
    return Boolean(
      settings && settings.enabled && settings.speakerDiarizationEnabled
      && state && state.supported && state.online && state.visible
      && !state.assistantSpeaking && !state.suspended,
    );
  }

  function eventDetail(event) {
    return event && event.detail && typeof event.detail === 'object' ? event.detail : {};
  }

  class SpeakerCaptureClient {
    constructor(options) {
      this.options = options || {};
      this.apiBase = String(this.options.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
      this.settings = { enabled: false, speakerDiarizationEnabled: false, rememberSpeakers: false };
      this.supported = Boolean(
        root.MediaRecorder && root.navigator && root.navigator.mediaDevices
        && typeof root.navigator.mediaDevices.getUserMedia === 'function',
      );
      this.stream = null;
      this.recorder = null;
      this.recorderStartedAt = null;
      this.rotateTimer = null;
      this.destroyed = false;
      this.assistantSpeaking = false;
      this.suspendReasons = new Set();
      this.discardCurrent = false;
      this.handlers = [];
      this.inFlight = new Set();
      this.recentTranscripts = [];
      this.starting = null;
      this.oneShot = false;
      this.oneShotPurpose = null;
      this.oneShotTimer = null;
      const requestedTimeout = Number(this.options.uploadTimeoutMs);
      this.uploadTimeoutMs = Number.isFinite(requestedTimeout)
        ? Math.min(UPLOAD_TIMEOUT_MS, Math.max(50, Math.floor(requestedTimeout)))
        : UPLOAD_TIMEOUT_MS;
    }

    mount() {
      this.bind(document, 'jarvis:ambient-ready', (event) => this.applySettings(eventDetail(event).settings));
      this.bind(document, 'jarvis:ambient-settings-changed', (event) => this.applySettings(eventDetail(event).settings));
      this.bind(document, 'jarvis:ambient-recognized', (event) => this.rememberTranscript(eventDetail(event)));
      this.bind(document, 'jarvis:speaking-start', () => this.setAssistantSpeaking(true));
      this.bind(document, 'jarvis:speaking-end', () => this.setAssistantSpeaking(false));
      this.bind(document, 'jarvis:speaker-capture-suspend', (event) => this.suspend(eventDetail(event).reason));
      this.bind(document, 'jarvis:speaker-capture-resume', (event) => this.resume(eventDetail(event).reason));
      this.bind(document, 'jarvis:speakers-file-selected', (event) => void this.importRecording(eventDetail(event)));
      this.bind(document, 'jarvis:speakers-enroll-requested', () => void this.enrollCurrentUser());
      this.bind(document, 'jarvis:speakers-capture-requested', (event) => void this.captureConversation(eventDetail(event)));
      this.bind(document, 'visibilitychange', () => this.refresh());
      this.bind(root, 'online', () => this.refresh());
      this.bind(root, 'offline', () => this.refresh());
      this.bind(root, 'pagehide', () => this.destroy());
      if (!this.supported) {
        this.emit('jarvis:speakers-capture-state', { state: 'unsupported' });
      }
      return this;
    }

    bind(target, name, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(name, handler);
      this.handlers.push([target, name, handler]);
    }

    applySettings(settings) {
      const source = settings && typeof settings === 'object' ? settings : {};
      const wasContinuous = Boolean(this.settings.enabled && this.settings.speakerDiarizationEnabled);
      this.settings = {
        ...this.settings,
        enabled: source.enabled === undefined && source.ambientEnabled === undefined
          ? this.settings.enabled : Boolean(source.enabled ?? source.ambientEnabled),
        speakerDiarizationEnabled: source.speakerDiarizationEnabled === undefined
          ? this.settings.speakerDiarizationEnabled : Boolean(source.speakerDiarizationEnabled),
        rememberSpeakers: source.rememberSpeakers === undefined
          ? this.settings.rememberSpeakers : Boolean(source.rememberSpeakers),
      };
      if (wasContinuous && (!this.settings.enabled || !this.settings.speakerDiarizationEnabled)) {
        this.inFlight.forEach((request) => {
          if (request.purpose === 'ambient') request.abort();
        });
      }
      this.refresh();
    }

    environmentState() {
      return {
        supported: this.supported,
        online: !root.navigator || root.navigator.onLine !== false,
        visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        assistantSpeaking: this.assistantSpeaking,
        suspended: this.suspendReasons.size > 0 || this.oneShot,
      };
    }

    refresh() {
      if (this.destroyed) return;
      if (shouldCapture(this.settings, this.environmentState())) {
        void this.startContinuous();
      } else {
        const release = !this.settings.enabled || !this.settings.speakerDiarizationEnabled
          || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
        this.stopCurrent(true, release);
      }
    }

    captureAuthorized() {
      if (this.destroyed) return false;
      if (shouldCapture(this.settings, this.environmentState())) return true;
      return Boolean(this.oneShot && this.oneShotPurpose && this.oneShotAllowed(this.oneShotPurpose));
    }

    oneShotAllowed(purpose) {
      const state = this.environmentState();
      if (!state.supported || !state.online || !state.visible || state.assistantSpeaking
          || this.suspendReasons.size > 0 || this.destroyed) return false;
      if (purpose === 'self_enrollment') return Boolean(this.settings.rememberSpeakers);
      return purpose === 'recording_import';
    }

    oneShotBlockMessage(purpose) {
      const state = this.environmentState();
      if (!state.supported) return 'This browser cannot record audio for speaker recognition.';
      if (!state.online) return 'Connect to the internet before recording audio for speaker recognition.';
      if (!state.visible) return 'Return to this tab before starting a speaker recording.';
      if (state.assistantSpeaking) return 'Wait until Jarvis finishes speaking before starting the recording.';
      if (this.suspendReasons.size > 0) return 'Another microphone action is active. Finish it before starting this recording.';
      if (purpose === 'self_enrollment' && !this.settings.rememberSpeakers) {
        return 'Turn on Remember encrypted voice profiles before enrolling your voice.';
      }
      return 'The recording could not start because audio capture is no longer authorized.';
    }

    stopTracks(stream) {
      for (const track of stream && stream.getTracks ? stream.getTracks() : []) {
        try { track.stop(); } catch (_error) { /* best effort */ }
      }
    }

    async ensureStream() {
      if (this.stream && this.stream.active !== false) {
        if (this.captureAuthorized()) return this.stream;
        this.releaseStream();
        throw new Error('audio capture is no longer authorized');
      }
      if (this.starting) return this.starting;
      this.starting = root.navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }).then((stream) => {
        if (!this.captureAuthorized()) {
          this.stopTracks(stream);
          throw new Error('audio capture was cancelled before microphone access completed');
        }
        this.stream = stream;
        this.emit('jarvis:speakers-capture-state', { state: 'microphone-ready' });
        return stream;
      }).catch((error) => {
        if (this.captureAuthorized()) {
          this.emit('jarvis:speakers-capture-state', { state: 'unavailable' });
          this.emitError('Microphone permission is required for speaker recognition.', error);
        }
        throw error;
      }).finally(() => { this.starting = null; });
      return this.starting;
    }

    async startContinuous() {
      if (this.recorder || this.starting || !shouldCapture(this.settings, this.environmentState())) return;
      try {
        const stream = await this.ensureStream();
        if (!shouldCapture(this.settings, this.environmentState())) {
          if (!this.captureAuthorized()) this.releaseStream();
          return;
        }
        this.beginRecorder(stream, 'ambient', CHUNK_DURATION_MS);
      } catch (_error) {
        // ensureStream emits the actionable error.
      }
    }

    beginRecorder(stream, purpose, durationMs) {
      if (this.recorder || this.destroyed) return;
      const mimeType = selectMimeType(root.MediaRecorder);
      const options = mimeType ? { mimeType, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 };
      let recorder;
      try { recorder = new root.MediaRecorder(stream, options); }
      catch (error) {
        this.releaseStream();
        this.emit('jarvis:speakers-capture-state', { state: 'unavailable' });
        this.emitError('This browser could not start the speaker-recognition recorder.', error);
        return;
      }

      const chunks = [];
      const startedAt = new Date();
      this.recorder = recorder;
      this.recorderStartedAt = startedAt;
      this.discardCurrent = false;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('error', (event) => this.emitError('Audio capture failed.', event.error || event));
      recorder.addEventListener('stop', () => {
        root.clearTimeout(this.rotateTimer);
        const endedAt = new Date();
        const discard = this.discardCurrent || this.destroyed;
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = chunks.length ? new Blob(chunks, { type }) : null;
        const transcript = discard
          ? { text: '', recognitionIds: [] }
          : this.takeTranscript(startedAt, endedAt);
        this.recorder = null;
        this.recorderStartedAt = null;
        this.discardCurrent = false;
        if (!discard && blob && blob.size >= MIN_AUDIO_BYTES) {
          void this.uploadAudio(blob, purpose, {
            startedAt, endedAt, clientTranscript: transcript.text, recognitionIds: transcript.recognitionIds,
          });
        } else if (!discard && transcript.recognitionIds.length) {
          this.emitTranscriptOutcome(transcript.recognitionIds, 'fallback_required', 'audio_too_short');
        }
        if (purpose === 'ambient') this.refresh();
      }, { once: true });
      recorder.start();
      this.emit('jarvis:speakers-capture-state', { state: 'recording', purpose, startedAt: startedAt.toISOString() });
      this.rotateTimer = root.setTimeout(() => this.stopCurrent(false, false), durationMs);
    }

    stopCurrent(discard, releaseStream) {
      root.clearTimeout(this.rotateTimer);
      let stopped = Promise.resolve();
      if (this.recorder && this.recorder.state !== 'inactive') {
        const recorder = this.recorder;
        let resolveStop;
        stopped = new Promise((resolve) => { resolveStop = resolve; recorder.addEventListener('stop', resolve, { once: true }); });
        this.discardCurrent = Boolean(discard);
        try { recorder.stop(); } catch (_error) { this.recorder = null; resolveStop(); }
      }
      if (releaseStream) this.releaseStream();
      return stopped;
    }

    releaseStream() {
      if (!this.stream) return;
      this.stopTracks(this.stream);
      this.stream = null;
    }

    setAssistantSpeaking(active) {
      this.assistantSpeaking = Boolean(active);
      // Seal and upload everything captured before TTS begins; only audio recorded
      // during assistant speech is excluded. Discarding the whole open chunk here
      // would lose the user's wake command and preceding conversation.
      if (this.assistantSpeaking) this.stopCurrent(false, false);
      else root.setTimeout(() => this.refresh(), 450);
    }

    suspend(reason) {
      this.suspendReasons.add(String(reason || 'external'));
      this.refresh();
    }

    resume(reason) {
      if (reason) this.suspendReasons.delete(String(reason));
      else this.suspendReasons.clear();
      this.refresh();
    }

    rememberTranscript(detail) {
      const text = String(detail.text || detail.transcript || '').trim().slice(0, 4000);
      if (!text) return;
      const capturedAt = new Date(detail.capturedAt || Date.now());
      if (Number.isNaN(capturedAt.getTime())) return;
      const recognitionId = String(detail.recognitionId || '').trim();
      if (recognitionId && this.recentTranscripts.some((item) => item.recognitionId === recognitionId)) return;
      this.recentTranscripts.push({ text, capturedAt, recognitionId });
      const cutoff = Date.now() - (CHUNK_DURATION_MS * 3);
      this.recentTranscripts = this.recentTranscripts.filter((item) => item.capturedAt.getTime() >= cutoff).slice(-20);
    }

    takeTranscript(startedAt, endedAt) {
      const matches = this.recentTranscripts.filter((item) => item.capturedAt >= startedAt && item.capturedAt <= endedAt);
      this.recentTranscripts = this.recentTranscripts.filter((item) => item.capturedAt > endedAt);
      return {
        text: matches.map((item) => item.text).join(' ').slice(0, 8000),
        recognitionIds: matches.map((item) => item.recognitionId).filter(Boolean),
      };
    }

    async importRecording(detail) {
      const file = detail.file;
      if (!file || typeof file.size !== 'number') {
        this.emitError('Choose an audio recording to analyze.');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.emitError('That recording is larger than the 7 MiB processing limit.');
        return;
      }
      const measuredSeconds = await this.measureAudioDuration(file);
      if (measuredSeconds && measuredSeconds > MAX_RECORDING_DURATION_MS / 1000) {
        this.emitError('That recording is longer than the 55 second transcription limit.');
        return;
      }
      const startedAt = detail.capturedAt ? new Date(detail.capturedAt) : new Date();
      const endedAt = detail.endedAt ? new Date(detail.endedAt)
        : new Date(startedAt.getTime() + Math.max(1, measuredSeconds || 1) * 1000);
      await this.uploadAudio(file, detail.purpose || 'recording_import', {
        startedAt,
        endedAt,
        clientTranscript: String(detail.clientTranscript || '').slice(0, 8000),
        recognitionIds: [],
      });
    }

    measureAudioDuration(file) {
      if (typeof root.Audio !== 'function' || !root.URL || typeof root.URL.createObjectURL !== 'function') {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const audio = new root.Audio();
        const url = root.URL.createObjectURL(file);
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          root.clearTimeout(timer);
          audio.removeAttribute('src');
          try { root.URL.revokeObjectURL(url); } catch (_error) { /* best effort */ }
          resolve(value);
        };
        const timer = root.setTimeout(() => finish(null), 5000);
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
        audio.onerror = () => finish(null);
        audio.src = url;
      });
    }

    async enrollCurrentUser() {
      return this.recordOneShot('self_enrollment', ENROLLMENT_DURATION_MS, 'jarvis:speakers-enrollment-started');
    }

    async captureConversation(detail) {
      if (detail.action === 'stop') {
        root.clearTimeout(this.oneShotTimer);
        await this.stopCurrent(false, false);
        this.oneShot = false;
        this.oneShotPurpose = null;
        this.refresh();
        return;
      }
      const requested = Number(detail.durationMs || RECORDING_DURATION_MS);
      const durationMs = Number.isFinite(requested)
        ? Math.min(MAX_RECORDING_DURATION_MS, Math.max(1000, Math.floor(requested)))
        : RECORDING_DURATION_MS;
      return this.recordOneShot('recording_import', durationMs, 'jarvis:speakers-recording-started');
    }

    async recordOneShot(purpose, durationMs, startedEvent) {
      if (!this.supported || this.oneShot) {
        if (!this.supported) this.emitError('This browser cannot record audio for speaker recognition.');
        return;
      }
      if (!this.oneShotAllowed(purpose)) {
        this.emitError(this.oneShotBlockMessage(purpose));
        return;
      }
      root.clearTimeout(this.oneShotTimer);
      this.oneShot = true;
      this.oneShotPurpose = purpose;
      await this.stopCurrent(false, false);
      try {
        const stream = await this.ensureStream();
        if (!this.oneShotAllowed(purpose)) {
          this.releaseStream();
          throw new Error(this.oneShotBlockMessage(purpose));
        }
        this.emit(startedEvent, { durationSeconds: durationMs / 1000 });
        this.beginRecorder(stream, purpose, durationMs);
      } catch (error) {
        if (!this.destroyed && !this.oneShotAllowed(purpose)) {
          this.emitError(this.oneShotBlockMessage(purpose), error);
        }
        this.oneShot = false;
        this.oneShotPurpose = null;
        this.refresh();
        return;
      }
      this.oneShotTimer = root.setTimeout(() => {
        this.oneShot = false;
        this.oneShotPurpose = null;
        this.refresh();
      }, durationMs + 250);
    }

    async uploadAudio(audio, purpose, metadata) {
      const recognitionIds = Array.isArray(metadata.recognitionIds) ? metadata.recognitionIds.filter(Boolean) : [];
      if (root.navigator && root.navigator.onLine === false) {
        this.emitTranscriptOutcome(recognitionIds, 'fallback_required', 'offline');
        this.emitError('Audio was not retained because the device is offline. Recognized text will wait to sync without speaker names.');
        return null;
      }
      if (this.inFlight.size >= MAX_IN_FLIGHT) {
        this.emitTranscriptOutcome(recognitionIds, 'fallback_required', 'busy');
        this.emitError('Speaker analysis is busy. Recognized text will be saved without speaker names.');
        return null;
      }
      if (audio.size > MAX_FILE_BYTES) {
        this.emitTranscriptOutcome(recognitionIds, 'fallback_required', 'audio_too_large');
        this.emitError('That recording is larger than the 7 MiB processing limit.');
        return null;
      }
      if (typeof root.AbortController !== 'function') {
        this.emitTranscriptOutcome(recognitionIds, 'fallback_required', 'abort_unavailable');
        this.emitError('This browser cannot safely bound the speaker-analysis request. Recognized text will be saved without speaker names.');
        return null;
      }
      const controller = new root.AbortController();
      const token = { abort: () => controller.abort(), controller, purpose };
      this.inFlight.add(token);
      let timedOut = false;
      const timeout = root.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.uploadTimeoutMs);
      const form = new FormData();
      const extension = String(audio.type || '').includes('ogg') ? 'ogg'
        : String(audio.type || '').includes('mp4') ? 'm4a' : 'webm';
      form.append('audio', audio, audio.name || `speaker-audio.${extension}`);
      form.append('purpose', String(purpose || 'ambient'));
      form.append('clientChunkId', createId('speaker-chunk'));
      form.append('capturedAt', metadata.startedAt.toISOString());
      form.append('endedAt', metadata.endedAt.toISOString());
      if (metadata.clientTranscript) form.append('clientTranscript', metadata.clientTranscript);
      this.emit('jarvis:speakers-upload-started', { purpose, bytes: audio.size });
      try {
        const response = await root.fetch(`${this.apiBase}/audio`, {
          method: 'POST', credentials: 'include', body: form, signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
        const persisted = this.resultPersistedTranscript(data);
        this.emitTranscriptOutcome(
          recognitionIds,
          persisted ? 'audio_persisted' : 'fallback_required',
          persisted ? 'server_acknowledged' : 'no_transcript_persisted',
        );
        this.emit('jarvis:speakers-upload-completed', {
          purpose, result: data, transcriptOutcome: persisted ? 'audio_persisted' : 'fallback_required',
          genericFallbackAvailable: recognitionIds.length > 0,
        });
        this.emit('jarvis:speakers-refresh-requested', { reason: purpose });
        return data;
      } catch (error) {
        this.emitTranscriptOutcome(recognitionIds, 'fallback_required', timedOut ? 'timeout' : 'upload_failed');
        if (timedOut) {
          this.emitError('Speaker analysis timed out. Recognized text will be saved without speaker names.', error);
          return null;
        }
        if (!this.destroyed && (!error || error.name !== 'AbortError')) {
          this.emitError('Speaker analysis could not process that audio.', error);
        }
        return null;
      } finally {
        root.clearTimeout(timeout);
        this.inFlight.delete(token);
      }
    }

    resultPersistedTranscript(result) {
      const segments = Array.isArray(result && result.segments) ? result.segments : [];
      const accepted = Number(result && result.accepted) || 0;
      const duplicates = Number(result && result.duplicates) || 0;
      return segments.length > 0 || accepted > 0 || duplicates > 0;
    }

    emitTranscriptOutcome(recognitionIds, outcome, reason) {
      if (!recognitionIds || !recognitionIds.length) return;
      this.emit('jarvis:speakers-transcript-outcome', {
        recognitionIds: [...new Set(recognitionIds)], outcome, reason,
      });
    }

    emitError(message, error) {
      this.emit('jarvis:speakers-upload-error', { message, error: error || null });
    }

    emit(name, detail) {
      if (typeof root.CustomEvent !== 'function' || typeof document === 'undefined') return;
      document.dispatchEvent(new root.CustomEvent(name, { detail }));
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.oneShot = false;
      this.oneShotPurpose = null;
      this.stopCurrent(true, true);
      root.clearTimeout(this.oneShotTimer);
      this.inFlight.forEach((request) => request.abort());
      this.inFlight.clear();
      this.recentTranscripts = [];
      this.handlers.forEach(([target, name, handler]) => target.removeEventListener(name, handler));
      this.handlers = [];
    }
  }

  let activeClient = null;

  function mount(options) {
    if (activeClient) activeClient.destroy();
    activeClient = new SpeakerCaptureClient(options).mount();
    return activeClient;
  }

  function unmount() {
    if (activeClient) activeClient.destroy();
    activeClient = null;
  }

  function getInstance() { return activeClient; }

  root.JarvisSpeakerCapture = Object.freeze({ mount, unmount, getInstance, selectMimeType, shouldCapture });
}(typeof window !== 'undefined' ? window : globalThis));
