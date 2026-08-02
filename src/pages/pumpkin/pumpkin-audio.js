/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: the pumpkin voice pipeline. speak() posts to /api/voice/synthesize, decodes the base64 audio, plays it through a WebAudio AnalyserNode, and emits the real per-frame RMS amplitude as the lip-sync signal (the repo previously only analysed MIC input; driving the MOUTH from OUTPUT audio is new here). Falls back to browser speechSynthesis (onboundary pulses) when the server returns no bytes. Mic capture uses SpeechRecognition, falling back to MediaRecorder → /api/voice/transcribe.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add browserOnly callbacks for the public demo so guest speech never issues a predictably-blocked /api/voice mutation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Honor preset voiceId in browser fallback/demo speech. Match installed voices by name when possible and deterministically spread cloud-only voice names across the device's English voices instead of always using the computer default.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Unattended-night hardening — every change here closes a way the prop went silently, permanently dead. (a) onEnd is now GUARANTEED to fire exactly once on every path (a single idempotent end-gate, plus a duration-derived fallback timer because src.onended is not guaranteed and never arrives at all when the context is interrupted); previously a wedged utterance left _playing true forever, which pinned the mouth open AND made the caller's `speaking` check block listening for the rest of the night. (b) A suspended AudioContext no longer swallows the utterance: speak() awaits unlock() and routes to speechSynthesis (a more permissive autoplay policy) when the context is not actually running, and contextState() lets the projector show a tap-to-wake gate. (c) forceStop() gives the caller a way to un-wedge a stuck line. (d) startListening() stops any live recognizer first and no longer swallows a thrown rec.start() — the throw now reports recog_busy AND fires onEnd, because silently swallowing it left the caller's state machine believing the ear was open forever. Recognition error codes pass through raw so the caller can split "quiet porch" (no-speech) from "mic denied", `continuous` keeps one session alive across the silent gaps between trick-or-treaters, and stopListening() detaches the old recognizer's end/error handlers (keeping onresult, so a push-to-talk release still delivers its final transcript) to stop a torn-down recognizer re-arming a fresh one. (e) A small bounded cache of decoded audio makes the saved-line playlist replay instantly instead of paying a full synthesis round trip per tap. The /api/voice/synthesize and /api/voice/transcribe contracts are unchanged.
 */

/* global window, document, navigator */
(function () {
  'use strict';

  const BUFFER_CACHE_MAX = 24;
  const SPEECH_END_SLACK_MS = 1500;
  const SYNTH_RESUME_NUDGE_MS = 10000;

  function b64ToArrayBuffer(b64) {
    const bin = window.atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /** The prop's voice + mic. All callbacks are optional. */
  class PumpkinAudio {
    constructor(apiBase) {
      this.apiBase = apiBase || '';
      this.ctx = null;
      this.recog = null;
      this.recorder = null;
      this.chunks = [];
      this.listening = false;
      this._playing = false;
      this._active = null;       // the live BufferSource / utterance, so forceStop can kill it
      this._done = null;         // the current utterance's idempotent end-gate
      this._endTimer = null;
      this._nudge = null;
      this._buffers = new Map(); // decoded audio, keyed by voice+rate+line
    }

    /**
     * Create/resume the AudioContext from a user gesture (autoplay policy).
     * @description Returns a promise now: speak() must be able to WAIT for the resume before deciding
     *   whether WebAudio is usable, otherwise it starts a BufferSource into a suspended context and
     *   the utterance is silent, never ends, and wedges the prop.
     * @returns {Promise<void>} resolves once the resume attempt has settled
     */
    unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') {
          return Promise.resolve(this.ctx.resume()).then(() => undefined, () => undefined);
        }
      } catch (e) { /* no audio context available */ }
      return Promise.resolve();
    }

    /**
     * The real state of the output path.
     * @description The projector shows a tap-to-wake overlay on anything other than 'running'; without
     *   this the only symptom of a blocked context is a pumpkin that mouths nothing forever.
     * @returns {string} 'running' | 'suspended' | 'closed' | 'unavailable'
     */
    contextState() { return (this.ctx && this.ctx.state) || 'unavailable'; }

    get speaking() { return this._playing; }

    /**
     * Build the one-shot completion for the current utterance.
     * @description cb.onEnd drives the caller's whole turn machine (mouth closed, ear re-armed, deaf
     *   window opened). Firing it twice double-advances that machine; firing it zero times freezes the
     *   prop. This gate guarantees exactly once, whichever of src.onended / the fallback timer /
     *   forceStop gets there first.
     * @param {{onLevel?:Function,onEnd?:Function}} cb
     * @returns {Function} idempotent completion callback
     */
    _endGate(cb) {
      let fired = false;
      return () => {
        if (fired) return;
        fired = true;
        this._playing = false;
        this._active = null;
        this._done = null;
        this._clearSpeechTimers();
        if (cb.onLevel) cb.onLevel(0);
        if (cb.onEnd) cb.onEnd();
      };
    }

    _clearSpeechTimers() {
      if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
      if (this._nudge && typeof clearInterval === 'function') clearInterval(this._nudge);
      this._nudge = null;
    }

    /**
     * Abandon whatever is speaking right now and settle the turn.
     * @description The projector arms a per-utterance watchdog; when playback wedges (a decode that
     *   never ends, a synthesis engine that stops calling back) this is how the prop gets its voice
     *   back instead of staying mute for the rest of the night.
     * @returns {void}
     */
    forceStop() {
      try { if (this._active && typeof this._active.stop === 'function') this._active.stop(); }
      catch (e) { /* already stopped */ }
      try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }
      catch (e) { /* speech synthesis unavailable */ }
      const done = this._done;
      if (done) { done(); return; }
      this._playing = false;
      this._active = null;
      this._clearSpeechTimers();
    }

    _cacheKey(line, voice) {
      const v = voice || {};
      return String(v.voiceId || '') + '|' + String(v.rate || 1) + '|' + line;
    }

    /** Remember decoded audio (LRU-ish, bounded) so a replayed saved line needs no synthesis call. */
    _remember(key, buf) {
      if (this._buffers.has(key)) this._buffers.delete(key);
      this._buffers.set(key, buf);
      while (this._buffers.size > BUFFER_CACHE_MAX) {
        this._buffers.delete(this._buffers.keys().next().value);
      }
    }

    /**
     * Speak `text` in the given voice, driving `onLevel(0..1)` with the live speech amplitude.
     * @param {string} text
     * @param {{voiceId?:string, rate?:number}} voice
     * @param {{onLevel?:Function, onStart?:Function, onEnd?:Function, browserOnly?:boolean}} cb
     */
    async speak(text, voice, cb) {
      cb = cb || {};
      const line = String(text || '').trim();
      if (!line) { if (cb.onEnd) cb.onEnd(); return; }
      await this.unlock();
      // A suspended/absent context plays nothing and never fires onended. speechSynthesis has a more
      // permissive autoplay policy, so it is the honest path rather than a silent wedge.
      if (cb.browserOnly === true || this.contextState() !== 'running') {
        this._speakBrowser(line, voice, cb);
        return;
      }
      const key = this._cacheKey(line, voice);
      const cached = this._buffers.get(key);
      if (cached) { this._playBuffer(cached, voice, cb); return; }
      try {
        const r = await fetch(this.apiBase + '/api/voice/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ text: line, voice: (voice && voice.voiceId) || undefined }),
        });
        const j = await r.json().catch(() => ({}));
        const data = j && j.data;
        if (data && data.audioData && this.ctx) {
          const decoded = await this._decode(b64ToArrayBuffer(data.audioData));
          if (decoded) { this._remember(key, decoded); this._playBuffer(decoded, voice, cb); return; }
        }
      } catch (e) { /* fall through to browser TTS */ }
      this._speakBrowser(line, voice, cb);
    }

    /** Decode synthesized bytes; null (not a throw) when the codec is unusable, so speak() can fall back. */
    async _decode(arrayBuf) {
      try { return await this.ctx.decodeAudioData(arrayBuf.slice(0)); }
      catch (e) { return null; }
    }

    /** Play a decoded buffer through an AnalyserNode, emitting RMS as the lip-sync level. */
    _playBuffer(audioBuf, voice, cb) {
      const src = this.ctx.createBufferSource();
      src.buffer = audioBuf;
      const rate = voice && voice.rate ? Math.max(0.5, Math.min(2, voice.rate)) : 1;
      if (voice && voice.rate) src.playbackRate.value = rate;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      const buf = new Uint8Array(analyser.fftSize);
      src.connect(analyser);
      analyser.connect(this.ctx.destination);
      this._playing = true;
      this._active = src;
      const done = this._endGate(cb);
      this._done = done;
      if (cb.onStart) cb.onStart();
      const tick = () => {
        if (!this._playing) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (cb.onLevel) cb.onLevel(Math.min(1, rms * 3.2));
        if (window.requestAnimationFrame) window.requestAnimationFrame(tick);
      };
      src.onended = done;
      // src.onended is not guaranteed on every engine and never arrives when the context is
      // interrupted mid-play (a phone call, a display sleep). The duration is known, so the utterance
      // always has a deadline.
      this._endTimer = setTimeout(done, ((audioBuf.duration || 0) * 1000) / rate + SPEECH_END_SLACK_MS);
      src.start();
      tick();
    }

    /** Browser speechSynthesis fallback — pulse the mouth on word boundaries. */
    _speakBrowser(text, voice, cb) {
      if (!('speechSynthesis' in window) || !text) { if (cb.onEnd) cb.onEnd(); return; }
      const u = new window.SpeechSynthesisUtterance(text);
      if (voice && voice.rate) u.rate = Math.max(0.5, Math.min(2, voice.rate));
      this._chooseBrowserVoice(u, voice);
      this._playing = true;
      this._active = u;
      const done = this._endGate(cb);
      this._done = done;
      if (cb.onStart) cb.onStart();
      let decay = null;
      u.onboundary = () => {
        if (cb.onLevel) cb.onLevel(0.55 + 0.35 * Math.abs(Math.sin(Date.now() / 90)));
        if (decay) clearTimeout(decay);
        decay = setTimeout(() => { if (cb.onLevel) cb.onLevel(0.12); }, 90);
      };
      u.onend = done;
      u.onerror = done;
      // Chrome silently pauses long utterances; without the nudge the line stops mid-sentence and
      // onend never arrives, which used to leave the prop stuck "speaking" forever.
      if (typeof setInterval === 'function') {
        this._nudge = setInterval(() => {
          try { if (this._playing && window.speechSynthesis.paused) window.speechSynthesis.resume(); }
          catch (e) { /* engine gone */ }
        }, SYNTH_RESUME_NUDGE_MS);
      }
      window.speechSynthesis.speak(u);
    }

    /** Pick the closest installed voice for a preset voiceId (cloud names rarely exist locally). */
    _chooseBrowserVoice(u, voice) {
      const voiceId = String((voice && voice.voiceId) || '').trim();
      const installed = typeof window.speechSynthesis.getVoices === 'function'
        ? window.speechSynthesis.getVoices()
        : [];
      if (!voiceId || !installed.length) { u.pitch = 0.7; return; }
      const wanted = voiceId.toLowerCase();
      const exact = installed.find((candidate) =>
        String(candidate.name || '').toLowerCase() === wanted ||
        String(candidate.voiceURI || '').toLowerCase() === wanted
      );
      const compatible = installed.filter((candidate) => /^en(?:-|_)/i.test(candidate.lang || ''));
      const choices = compatible.length ? compatible : installed;
      let hash = 0;
      for (let i = 0; i < voiceId.length; i++) hash = ((hash * 31) + voiceId.charCodeAt(i)) >>> 0;
      u.voice = exact || choices[hash % choices.length];
      // Gemini voice names do not normally exist in a browser catalog. A small, deterministic pitch
      // offset keeps those presets audibly distinct even when several names map onto the same voice.
      if (!exact) u.pitch = 0.72 + ((hash % 47) / 100);
    }

    /**
     * Begin listening. Prefers live SpeechRecognition; falls back to record → server transcribe.
     * @param {{onInterim?:Function,onFinal?:Function,onError?:Function,onEnd?:Function,browserOnly?:boolean,continuous?:boolean}} cb
     * @returns {void}
     */
    startListening(cb) {
      cb = cb || {};
      this.stopListening();          // a second live recognizer collides and throws InvalidStateError
      this.unlock();
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) { this._startRecognition(SR, cb); return; }
      if (cb.browserOnly === true) {
        if (cb.onError) cb.onError('browser_speech_unavailable');
        if (cb.onEnd) cb.onEnd();
        return;
      }
      this._recordThenTranscribe(cb);
    }

    /** Wire one SpeechRecognition session. A thrown start() must not become a silent deadlock. */
    _startRecognition(SR, cb) {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      // continuous keeps the session alive across the quiet gaps between trick-or-treaters instead of
      // ending after every utterance and relying on a restart that used to never happen.
      rec.continuous = cb.continuous === true;
      rec.onresult = (ev) => {
        let interim = '', final = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
        }
        if (interim && cb.onInterim) cb.onInterim(interim);
        if (final && cb.onFinal) cb.onFinal(final.trim());
      };
      // Pass the raw code through: the caller has to tell 'no-speech' (a quiet porch, recoverable)
      // apart from 'not-allowed' (a denied mic, terminal) and cannot if we flatten them.
      rec.onerror = (e) => { this.listening = false; if (cb.onError) cb.onError((e && e.error) || 'recog_error'); };
      rec.onend = () => { this.listening = false; this.recog = null; if (cb.onEnd) cb.onEnd(); };
      this.recog = rec; this.listening = true;
      try { rec.start(); }
      catch (e) {
        this.recog = null; this.listening = false;
        if (cb.onError) cb.onError('recog_busy');
        if (cb.onEnd) cb.onEnd();
      }
    }

    /** MediaRecorder capture → POST /api/voice/transcribe on stop (no browser SpeechRecognition). */
    async _recordThenTranscribe(cb) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new window.MediaRecorder(stream);
        this.chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
          const fd = new FormData();
          fd.append('audio', blob, 'clip.webm');
          try {
            const r = await fetch(this.apiBase + '/api/voice/transcribe', { method: 'POST', credentials: 'include', body: fd });
            const j = await r.json().catch(() => ({}));
            const txt = (j && j.data && j.data.text) || '';
            if (txt && cb.onFinal) cb.onFinal(String(txt).trim());
          } catch (e) { if (cb.onError) cb.onError('transcribe_failed'); }
          if (cb.onEnd) cb.onEnd();
        };
        this.recorder = rec; this.listening = true;
        rec.start();
      } catch (e) {
        this.listening = false;
        if (cb.onError) cb.onError('mic_denied');
        if (cb.onEnd) cb.onEnd();
      }
    }

    /**
     * Stop listening (ends recognition or finalizes the recording).
     * @description onend/onerror are detached before stopping so a torn-down recognizer cannot fire the
     *   caller's "session ended, re-arm the ear" path and race a recognizer we are about to create.
     *   onresult stays attached on purpose: releasing push-to-talk must still deliver its final line.
     * @returns {void}
     */
    stopListening() {
      this.listening = false;
      if (this.recog) {
        const rec = this.recog;
        this.recog = null;
        rec.onend = null;
        rec.onerror = null;
        try { rec.stop(); } catch (e) { /* noop */ }
      }
      if (this.recorder && this.recorder.state !== 'inactive') { try { this.recorder.stop(); } catch (e) { /* noop */ } }
      this.recorder = null;
    }
  }

  window.PumpkinAudio = PumpkinAudio;
})();
