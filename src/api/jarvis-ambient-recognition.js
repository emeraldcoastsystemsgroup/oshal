/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Carved out of jarvis-ambient.js (over the 1000-code-line cap): the SpeechRecognition lifecycle (start/stop/restart backoff), wake/armed command dispatch, diarization transcript handoff holds, assistant-speaking suppression, and visibility handling now live here as AmbientClient prototype methods (JarvisAmbientRecognition.clientMethods, mixed in by jarvis-ambient.js). Pure decomposition — every method body is verbatim from the AmbientClient class; behavior is unchanged. Loads after jarvis-ambient-core.js and before jarvis-ambient.js.
 */

(function attachJarvisAmbientRecognition(root) {
  'use strict';

  /*
   * Listening half of the ambient client: browser SpeechRecognition lifecycle,
   * wake-phrase/armed-window command dispatch, the trusted-audio-path
   * (diarization) handoff holds, and the suppression rules that keep the
   * assistant's own voice out of the transcript. These are AmbientClient
   * methods (they run with `this` bound to the client instance);
   * jarvis-ambient.js Object.assigns them onto AmbientClient.prototype, so the
   * split is invisible at runtime.
   */

  const { ARMED_WINDOW_MS, createId, parseWakeCommand } = root.JarvisAmbientCore;

  const clientMethods = {
    createRecognition() {
      if (this.recognition || !this.supported) return;
      const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
      this.recognition = new Recognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = this.settings.locale;
      this.recognition.onstart = () => this.handleRecognitionStart();
      this.recognition.onresult = (event) => this.handleRecognitionResult(event);
      this.recognition.onerror = (event) => this.handleRecognitionError(event);
      this.recognition.onend = () => this.handleRecognitionEnd();
    },

    startRecognition(userInitiated) {
      if (!this.settings.enabled || this.destroyed || !this.supported || this.externallySuspended) return;
      if (userInitiated) this.permissionBlocked = false;
      if (document.visibilityState === 'hidden') { this.setState('hidden'); return; }
      if (this.assistantSpeaking || this.recognitionRunning) return;
      this.createRecognition();
      this.stopRequested = false;
      this.setState('starting', userInitiated ? 'Allow microphone access if prompted' : undefined);
      try { this.recognition.start(); }
      catch (error) { this.reportError(error, 'Speech recognition is reconnecting', false); this.scheduleRestart(); }
    },

    handleRecognitionStart() {
      this.recognitionRunning = true;
      this.restartAttempts = 0;
      this.setState(Date.now() < this.armedUntil ? 'armed' : 'listening');
    },

    handleRecognitionResult(event) {
      if (this.assistantSpeaking || this.stopRequested) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result.isFinal || !result[0]) continue;
        const transcript = String(result[0].transcript || '').trim();
        if (transcript) this.acceptTranscript(transcript);
      }
    },

    handleRecognitionError(event) {
      const code = String(event.error || 'unknown');
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.permissionBlocked = true;
        this.lastError = 'Microphone permission was denied. Allow it in site and operating-system settings.';
        this.setState('blocked');
        return;
      }
      if (code === 'audio-capture') {
        this.lastError = 'No available microphone was found.';
        this.setState('error', this.lastError);
        return;
      }
      if (code === 'network') this.releaseAllDiarizationFallback('speech_network_error');
      if (code !== 'aborted' && code !== 'no-speech') this.reportError(new Error(code), `Speech recognition: ${code}`, false);
      if (this.shouldListen()) this.setState(code === 'network' ? 'offline' : 'reconnecting');
    },

    handleRecognitionEnd() {
      this.recognitionRunning = false;
      if (this.stopRequested || !this.shouldListen()) { this.refreshState(); return; }
      this.scheduleRestart();
    },

    shouldListen() {
      return this.settings.enabled && this.supported && !this.destroyed
        && !this.assistantSpeaking && !this.externallySuspended
        && !this.permissionBlocked && document.visibilityState !== 'hidden';
    },

    scheduleRestart(delay) {
      root.clearTimeout(this.restartTimer);
      if (!this.shouldListen()) return;
      this.restartAttempts += 1;
      const wait = delay ?? Math.min(10000, 350 * (2 ** Math.min(this.restartAttempts, 5)));
      this.setState('reconnecting');
      this.restartTimer = root.setTimeout(() => this.startRecognition(false), wait);
    },

    stopRecognition(nextState) {
      root.clearTimeout(this.restartTimer);
      this.stopRequested = true;
      if (this.recognition && this.recognitionRunning) {
        try { this.recognition.abort(); }
        catch (error) { this.reportError(error, 'Could not stop speech recognition cleanly', false); }
      }
      this.recognitionRunning = false;
      if (nextState) this.setState(nextState);
    },

    recreateRecognition() {
      this.stopRecognition();
      if (this.recognition) {
        this.recognition.onstart = null; this.recognition.onresult = null;
        this.recognition.onerror = null; this.recognition.onend = null;
      }
      this.recognition = null;
    },

    acceptTranscript(text) {
      const wake = parseWakeCommand(text, this.settings.wakePhrases);
      const armedCommand = !wake && Date.now() < this.armedUntil ? text : '';
      const capturedAt = new Date().toISOString();
      const recognitionId = createId('recognized');
      const clientSegmentId = createId('segment');
      const waitForSpeaker = this.settings.speakerDiarizationEnabled
        && this.speakerCaptureAvailable !== false && root.navigator.onLine !== false;
      if (waitForSpeaker) {
        this.holdForSpeakerOutcome({ recognitionId, clientSegmentId, text, wake, capturedAt });
      }
      this.emit('jarvis:ambient-recognized', {
        recognitionId, text, capturedAt,
        wakePhraseDetected: Boolean(wake), matchedWakePhrase: wake ? wake.wakePhrase : null,
      });
      // The deterministic audio route owns persistence while diarization is enabled so the
      // browser transcript cannot create a duplicate or claim a trusted speaker profile.
      if (!waitForSpeaker) {
        this.queueSegment(text, wake, capturedAt, clientSegmentId);
      }
      if (wake && !wake.command) {
        this.armedUntil = Date.now() + ARMED_WINDOW_MS;
        this.setState('armed');
        this.emit('jarvis:ambient-wake', { wakePhrase: wake.wakePhrase, transcript: text });
        return;
      }
      const command = wake ? wake.command : armedCommand;
      if (command) this.dispatchCommand(command, text, wake && wake.wakePhrase);
    },

    holdForSpeakerOutcome(entry) {
      const timer = root.setTimeout(() => {
        this.releaseDiarizationFallback([entry.recognitionId], 'ack_timeout');
      }, this.speakerAckTimeoutMs);
      this.pendingDiarization.set(entry.recognitionId, { ...entry, timer });
    },

    handleSpeakerTranscriptOutcome(event) {
      const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
      const recognitionIds = Array.isArray(detail.recognitionIds)
        ? detail.recognitionIds.map(String).filter(Boolean) : [];
      if (detail.outcome === 'audio_persisted') {
        for (const recognitionId of recognitionIds) this.acknowledgeDiarization(recognitionId);
        return;
      }
      if (detail.outcome === 'fallback_required') {
        this.releaseDiarizationFallback(recognitionIds, String(detail.reason || 'speaker_unavailable'));
      }
    },

    handleSpeakerCaptureState(event) {
      const state = String(event?.detail?.state || '');
      if (state === 'unsupported' || state === 'unavailable') {
        this.speakerCaptureAvailable = false;
        this.releaseAllDiarizationFallback(state);
      } else if (state === 'microphone-ready' || state === 'recording') {
        this.speakerCaptureAvailable = true;
      }
    },

    acknowledgeDiarization(recognitionId) {
      const pending = this.pendingDiarization.get(recognitionId);
      if (!pending) return;
      root.clearTimeout(pending.timer);
      this.pendingDiarization.delete(recognitionId);
    },

    releaseDiarizationFallback(recognitionIds, reason) {
      for (const recognitionId of recognitionIds) {
        const pending = this.pendingDiarization.get(recognitionId);
        if (!pending) continue;
        this.acknowledgeDiarization(recognitionId);
        this.queueSegment(pending.text, pending.wake, pending.capturedAt, pending.clientSegmentId);
      }
      if (recognitionIds.length && reason === 'offline') this.updateSyncCopy();
    },

    releaseAllDiarizationFallback(reason) {
      this.releaseDiarizationFallback([...this.pendingDiarization.keys()], reason);
    },

    dispatchCommand(command, transcript, wakePhrase) {
      this.armedUntil = 0;
      this.emit('jarvis:ambient-command', { command, transcript, wakePhrase: wakePhrase || null });
      if (typeof this.options.onWakeCommand !== 'function') return;
      try {
        const result = this.options.onWakeCommand({ command, transcript, wakePhrase: wakePhrase || null });
        if (result && typeof result.catch === 'function') result.catch((error) => this.reportError(error, 'Jarvis could not accept the wake command', false));
      } catch (error) {
        this.reportError(error, 'Jarvis could not accept the wake command', false);
      }
    },

    handleVisibility() {
      if (document.visibilityState === 'hidden') this.stopRecognition('hidden');
      else if (this.settings.enabled) this.startRecognition(false);
    },

    monitorSpeechSynthesis() {
      const speaking = Boolean(root.speechSynthesis && root.speechSynthesis.speaking);
      if (speaking !== this.assistantSpeaking) this.setAssistantSpeaking(speaking);
    },

    setAssistantSpeaking(speaking) {
      if (this.assistantSpeaking === Boolean(speaking)) return;
      this.assistantSpeaking = Boolean(speaking);
      if (this.assistantSpeaking) this.stopRecognition('paused');
      if (this.assistantSpeaking && this.settings.enabled) this.setState('paused', `${this.settings.assistantName} is speaking; listening will resume automatically`);
      else if (this.settings.enabled) root.setTimeout(() => this.startRecognition(false), 450);
    },

    suspend(reason) {
      this.externallySuspended = true;
      this.stopRecognition('paused');
      this.setState('paused', reason || 'Listening is temporarily paused');
    },

    resume() {
      this.externallySuspended = false;
      if (this.settings.enabled) this.startRecognition(false);
      else this.setState('paused');
    },

    refreshState() {
      if (!this.supported) this.setState('unsupported');
      else if (!this.settings.enabled) this.setState('paused');
      else if (this.externallySuspended) this.setState('paused', 'Listening is temporarily paused');
      else if (document.visibilityState === 'hidden') this.setState('hidden');
      else if (root.navigator.onLine === false) this.setState('offline');
      else if (!this.assistantSpeaking) this.setState(this.recognitionRunning ? 'listening' : 'reconnecting');
    },
  };

  /**
   * @description Listening mixin for the ambient client: SpeechRecognition lifecycle, wake and
   * armed-window command dispatch, diarization handoff holds, and assistant-speaking
   * suppression. jarvis-ambient.js merges clientMethods onto AmbientClient.prototype at load.
   */
  root.JarvisAmbientRecognition = Object.freeze({ clientMethods: Object.freeze(clientMethods) });
}(typeof window !== 'undefined' ? window : globalThis));
