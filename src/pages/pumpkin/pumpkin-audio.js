/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: the pumpkin voice pipeline. speak() posts to /api/voice/synthesize, decodes the base64 audio, plays it through a WebAudio AnalyserNode, and emits the real per-frame RMS amplitude as the lip-sync signal (the repo previously only analysed MIC input; driving the MOUTH from OUTPUT audio is new here). Falls back to browser speechSynthesis (onboundary pulses) when the server returns no bytes. Mic capture uses SpeechRecognition, falling back to MediaRecorder → /api/voice/transcribe.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add browserOnly callbacks for the public demo so guest speech never issues a predictably-blocked /api/voice mutation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Honor preset voiceId in browser fallback/demo speech. Match installed voices by name when possible and deterministically spread cloud-only voice names across the device's English voices instead of always using the computer default.
 */

/* global window, document */
(function () {
  'use strict';

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
    }

    /** Resume the AudioContext from a user gesture (autoplay policy). Call on the first click/key. */
    unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { /* no audio context available */ }
    }

    get speaking() { return this._playing; }

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
      this.unlock();
      if (cb.browserOnly === true) {
        this._speakBrowser(line, voice, cb);
        return;
      }
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
          await this._playBuffer(b64ToArrayBuffer(data.audioData), voice, cb);
          return;
        }
      } catch (e) { /* fall through to browser TTS */ }
      this._speakBrowser(line, voice, cb);
    }

    /** Decode + play server audio through an AnalyserNode, emitting RMS as the lip-sync level. */
    async _playBuffer(arrayBuf, voice, cb) {
      let audioBuf;
      try { audioBuf = await this.ctx.decodeAudioData(arrayBuf.slice(0)); }
      catch (e) { this._speakBrowser('', voice, cb); return; }
      const src = this.ctx.createBufferSource();
      src.buffer = audioBuf;
      if (voice && voice.rate) src.playbackRate.value = Math.max(0.5, Math.min(2, voice.rate));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      const buf = new Uint8Array(analyser.fftSize);
      src.connect(analyser);
      analyser.connect(this.ctx.destination);
      this._playing = true;
      if (cb.onStart) cb.onStart();
      const tick = () => {
        if (!this._playing) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (cb.onLevel) cb.onLevel(Math.min(1, rms * 3.2));
        window.requestAnimationFrame(tick);
      };
      src.onended = () => { this._playing = false; if (cb.onLevel) cb.onLevel(0); if (cb.onEnd) cb.onEnd(); };
      src.start();
      tick();
    }

    /** Browser speechSynthesis fallback — pulse the mouth on word boundaries. */
    _speakBrowser(text, voice, cb) {
      if (!('speechSynthesis' in window) || !text) { if (cb.onEnd) cb.onEnd(); return; }
      const u = new window.SpeechSynthesisUtterance(text);
      if (voice && voice.rate) u.rate = Math.max(0.5, Math.min(2, voice.rate));
      const voiceId = String((voice && voice.voiceId) || '').trim();
      const installed = typeof window.speechSynthesis.getVoices === 'function'
        ? window.speechSynthesis.getVoices()
        : [];
      if (voiceId && installed.length) {
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
        // Gemini voice names do not normally exist in a browser catalog. A small,
        // deterministic pitch offset keeps those presets audibly distinct even when
        // several names map onto the same locally-installed voice.
        if (!exact) u.pitch = 0.72 + ((hash % 47) / 100);
      } else {
        u.pitch = 0.7;
      }
      this._playing = true;
      if (cb.onStart) cb.onStart();
      let decay = null;
      u.onboundary = () => {
        if (cb.onLevel) cb.onLevel(0.55 + 0.35 * Math.abs(Math.sin(Date.now() / 90)));
        if (decay) clearTimeout(decay);
        decay = setTimeout(() => { if (cb.onLevel) cb.onLevel(0.12); }, 90);
      };
      u.onend = () => { this._playing = false; if (cb.onLevel) cb.onLevel(0); if (cb.onEnd) cb.onEnd(); };
      window.speechSynthesis.speak(u);
    }

    /** Begin listening. Prefers live SpeechRecognition; falls back to record → server transcribe. */
    startListening(cb) {
      cb = cb || {};
      this.unlock();
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        const rec = new SR();
        rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
        rec.onresult = (ev) => {
          let interim = '', final = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
          }
          if (interim && cb.onInterim) cb.onInterim(interim);
          if (final && cb.onFinal) cb.onFinal(final.trim());
        };
        rec.onerror = (e) => { this.listening = false; if (cb.onError) cb.onError(e.error || 'recog_error'); };
        rec.onend = () => { this.listening = false; if (cb.onEnd) cb.onEnd(); };
        this.recog = rec; this.listening = true;
        try { rec.start(); } catch (e) { /* already started */ }
        return;
      }
      if (cb.browserOnly === true) {
        if (cb.onError) cb.onError('browser_speech_unavailable');
        if (cb.onEnd) cb.onEnd();
        return;
      }
      this._recordThenTranscribe(cb);
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
      } catch (e) { if (cb.onError) cb.onError('mic_denied'); }
    }

    /** Stop listening (ends recognition or finalizes the recording). */
    stopListening() {
      this.listening = false;
      if (this.recog) { try { this.recog.stop(); } catch (e) { /* noop */ } this.recog = null; }
      if (this.recorder && this.recorder.state !== 'inactive') { try { this.recorder.stop(); } catch (e) { /* noop */ } }
      this.recorder = null;
    }
  }

  window.PumpkinAudio = PumpkinAudio;
})();
