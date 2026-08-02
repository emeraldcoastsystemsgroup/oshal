/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: projector controller. Loads a preset, runs the render loop, and wires both topologies at once — local mic (mimic push-to-talk / autonomous, push-to-talk or always-on) AND a paired room (registers, SSE-subscribes, so a phone remote can drive this screen). Handles TTS speak + lip-sync callbacks, expression, keyboard/fullscreen/cursor-hide.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Public browser demo: same-browser control/projector/remote pairing over BroadcastChannel, deterministic no-LLM autonomous replies, local preset handoff, and browser-only speech. Authenticated SSE/room behavior is unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Unattended-night survival. (a) SELF-HEALING ROOM LINK: register/subscribe/heartbeat became one state machine that re-registers on jittered, capped backoff whenever the room dies — the stream reports unknown_room or evicted, EventSource closes terminally (a non-2xx from /stream never auto-retries), 70s pass with no frame (a half-open socket delivers no FIN and no error), or the heartbeat answers {ok:false} / 401. Previously a failed register was swallowed by an empty catch, the heartbeat's result was discarded and its promise had no .catch (an unhandled rejection every failed beat), and es.onerror was a bare comment — so an api restart mid-party left the projector reconnect-looping against a dead room, deaf until a human walked over and reloaded it. A link badge, a reconnecting room label, and a fail-loud "signed out" overlay make the state readable from across the yard. (b) CLOSED THE SELF-HEARING LOOP: an explicit turn machine (idle/listening/thinking/speaking/cooldown) hard-stops the mic BEFORE any audio leaves the speakers, holds a 900ms deaf window for room reverb, rejects self-echo by bag-of-words overlap against the last spoken line, and single-flights the reply so a crowd of kids cannot spawn N LLM calls. The old guard sampled audio.speaking once at start time and lost the race: recognition ends before the reply returns, so the ear was already re-opened when playback began. (c) The ear now survives a quiet porch (no-speech is the normal idle cycle, not a fatal error) while a denied mic stops loudly; a stopped ear stays stopped (the restart timer is cancellable and re-checks mode at fire time); speech is queued so utterances cannot overlap and leave face.setSpeaking stuck on; a per-utterance watchdog un-wedges a stuck line; an audio gate recovers a suspended AudioContext; and a screen Wake Lock stops the OS blanking the projector.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | (a) THE THINK CAN NO LONGER WEDGE THE PROP. Every other long-lived operation here had a watchdog; the ONE call that spawns a claude-code CLI subprocess had none. S.inFlight and turn==='thinking' were cleared only inside the chat .then/.catch, api() had no AbortController, and the inline-bot route has no server-side timeout — so a single request that never settled left the prop permanently deaf, and startListen()'s early return refused the human holding the talk button too. Now: a 45s AbortController deadline, ONE endThink() that owns S.inFlight/the controller/the stale-reply token, an unconditional recovery timer that returns to the ear with a visible status, and startListen() aborting a wedged think instead of refusing (armEar still never schedules one automatically). (b) THE SHORT PROJECTOR URL IS REAL. The runbook's step 3 ({origin}/pumpkin/ with nothing after the slash — the only form worth typing on a projector device) promised the page reads roomLabel/mode/activePreset back from saved settings; it never fetched them, so following the runbook literally landed the projector in room 'main' while the cockpit pushed to 'front-porch'. loadStoredSettings() now fills ONLY the params the URL omitted, and gates the room/look/ear bring-up; rendering still starts immediately so a slow api never shows a black screen.
 */

/* global window, document, navigator, PumpkinFace, PumpkinAudio, EventSource */
(function () {
  'use strict';

  // Bundled fallback so the projector never blanks if the API is unreachable (matches 'inflatable').
  var FALLBACK = {
    name: 'inflatable', label: 'Inflatable', builtin: true,
    colors: { background: '#000000', bodyGlow: 'rgba(255,96,0,0.12)', feature: '#ffb020', featureHot: '#fff3c0', ambient: 'rgba(0,0,0,0.9)' },
    face: { eyeShape: 'triangle', mouthShape: 'jagged', toothCount: 4, eyeSpacing: 0.58, eyeSize: 0.5, mouthWidth: 0.72, browAngle: -0.15 },
    motion: { idleBob: 10, bobSpeed: 0.28, sway: 1.6, blinkPerMin: 9, gaze: 0.35, mouthReactivity: 1.1, flicker: 0.35 },
    glow: { blur: 44, intensity: 1.25 }, voice: { voiceId: 'Charon', rate: 0.95 }, defaultMode: 'mimic',
  };

  // ── Unattended-operation tuning ────────────────────────────────────────────
  // Every number here exists because a Halloween night runs six hours with nobody
  // watching the console. They are deliberately generous: a false re-register costs
  // one round trip, a missed one costs the rest of the night.
  var HEARTBEAT_MS = 30000;          // matches the server's 90s room TTL with 3x margin
  var STREAM_SILENCE_MS = 70000;     // 2 missed 25s server pings + slack ⇒ the socket is half-open
  var STREAM_OPEN_GRACE_MS = 20000;  // EventSource that never reaches OPEN is not coming up
  var LINK_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
  var LINK_JITTER = 0.2;             // ±20% so a fleet of screens never retries in lockstep
  var DEAF_AFTER_SPEECH_MS = 900;    // room reverb tail; the mic must not hear our own last syllable
  var EAR_RESTART_MS = 400;
  var EAR_FAULT_BACKOFF_MS = [1000, 2000, 3500, 5000];
  var EAR_MAX_CONSEC_FAULTS = 20;
  var SPEAK_QUEUE_MAX = 5;           // kids WILL spam the phone remote; drop oldest, never overlap
  var MIN_UTTERANCE_CHARS = 3;
  var SELF_ECHO_OVERLAP = 0.6;
  // Deadline on ONE autonomous reply. pumpkin-bot is a claude-code CLI spawn (3-10s typically), and
  // the inline-bot route has no server-side timeout at all — so a wedged bot holds the response open
  // forever. 45s is ~5x the slow case; past it the prop must be listening again, not still 'thinking…'.
  var THINK_DEADLINE_MS = 45000;

  // A denied/absent mic is terminal — retrying it forever just burns battery and hides the cause.
  var FATAL_MIC_ERRORS = ['not-allowed', 'service-not-allowed', 'audio-capture', 'browser_speech_unavailable', 'mic_denied'];
  // Chrome fires no-speech within seconds on a quiet porch. That is the NORMAL idle cycle between
  // trick-or-treaters, not a fault: it must never be counted toward giving up and never shown as an error.
  var QUIET_MIC_ERRORS = ['no-speech', 'aborted'];

  var qs = new URLSearchParams(window.location.search);
  var demoChannel = String(qs.get('channel') || 'pumpkin-preview').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'pumpkin-preview';
  var S = {
    preset: FALLBACK,
    mode: qs.get('mode') === 'autonomous' ? 'autonomous' : 'mimic',
    listenMode: qs.get('listen') === 'open' ? 'open' : 'ptt',
    roomLabel: qs.get('room') || 'Main',
    room: null, token: null,
    listening: false, es: null,
    demo: qs.get('demo') === '1', demoChannel: demoChannel, demoBus: null,
    // Turn machine — 'idle' | 'listening' | 'thinking' | 'speaking' | 'cooldown'.
    turn: 'idle', lastSpoken: '', deafUntil: 0, inFlight: false,
    // The thinking turn owns three things together: its abort controller, its deadline timer, and a
    // monotonic token so a reply that lands AFTER the turn ended is discarded instead of speaking
    // over whatever the prop is doing by then.
    thinkTimer: null, thinkAbort: null, thinkSeq: 0, thinkTurn: 0,
    storedPreset: '',
    micFatal: false, micFatalText: '', earTimer: null, earFaults: 0,
    speakQueue: [], speakTimer: null,
    // Link machine — 'offline' | 'connecting' | 'live' | 'degraded' | 'unauthorized' | 'demo'.
    link: 'offline', linkDetail: '', roomName: '',
    registering: false, backoff: 0, missedBeats: 0,
    retryTimer: null, silenceTimer: null, graceTimer: null, hbTimer: null,
    wakeLock: null,
  };

  var face, audio, els = {};
  var lastFrame = 0;

  function api(path, opts) {
    opts = opts || {}; opts.credentials = 'include';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var err = new Error(j.message || j.error || ('Request failed (' + r.status + ')')); err.status = r.status; throw err; }
        return j;
      });
    });
  }

  /** Same-browser event bus used only by the public demo; it never touches a server endpoint. */
  function createDemoBus(channel, onMessage) {
    var bc = null;
    var storageKey = 'oshal.pumpkin.demo.bus.' + channel;
    try { if ('BroadcastChannel' in window) bc = new window.BroadcastChannel(channel); } catch (e) { bc = null; }
    if (bc && onMessage) bc.onmessage = function (e) { onMessage(e.data); };
    if (!bc && onMessage) {
      window.addEventListener('storage', function (e) {
        if (e.key !== storageKey || !e.newValue) return;
        try { onMessage(JSON.parse(e.newValue).event); } catch (err) { /* malformed demo event */ }
      });
    }
    return {
      post: function (event) {
        if (bc) { bc.postMessage(event); return; }
        try { window.localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), event: event })); } catch (e) { /* storage disabled */ }
      },
    };
  }

  /** Deterministic in-character reply for the zero-cost public demo. */
  function demoReply(text) {
    var line = String(text || '').toLowerCase();
    if (/trick|treat|candy/.test(line)) return { say: 'A treat for the brave — but mind the shadows behind you!', expression: 'mischief', intensity: 0.78 };
    if (/name|who are you/.test(line)) return { say: 'I am the porch pumpkin, keeper of the candle and watcher of wandering goblins.', expression: 'happy', intensity: 0.68 };
    if (/scary|spooky|boo/.test(line)) return { say: 'Boo! The candle flickers, and the whole porch wakes up.', expression: 'spooky', intensity: 0.9 };
    var replies = [
      { say: 'The candle heard you. Step closer, little mortal.', expression: 'mischief', intensity: 0.68 },
      { say: 'Interesting... the porch remembers every Halloween whisper.', expression: 'surprised', intensity: 0.62 },
      { say: 'Heh heh heh... that earns you one glowing pumpkin grin.', expression: 'happy', intensity: 0.72 },
    ];
    var score = 0; for (var i = 0; i < line.length; i++) score += line.charCodeAt(i);
    return replies[score % replies.length];
  }

  function loadDemoPreset(name) {
    try {
      var active = JSON.parse(window.localStorage.getItem('oshal.pumpkin.demo.active') || 'null');
      if (active && active.preset && (!name || active.preset.name === name)) { applyPreset(active.preset); return true; }
      var saved = JSON.parse(window.localStorage.getItem('oshal.pumpkin.demo.presets.v1') || '[]');
      var found = Array.isArray(saved) && saved.find(function (p) { return p && p.name === name; });
      if (found) { applyPreset(found); return true; }
    } catch (e) { /* malformed/blocked local storage */ }
    return false;
  }

  // ── Stored defaults (what makes the SHORT projector URL work) ──────────────
  /**
   * Fill in whatever the URL did not say from the operator's saved defaults.
   * @description This is the runbook's step 3: `{origin}/pumpkin/` with nothing after the slash is
   *   the only form anybody wants to type on a projector device's on-screen keyboard, and pressing
   *   Launch in the cockpit is what writes roomLabel / mode / activePreset. Without this read the
   *   short form silently landed the projector in room 'main' while the cockpit and the phone
   *   pushed into 'front-porch' — a dark prop at 7pm caused by the documentation.
   *
   *   A query parameter that IS present always wins, so an explicit link is never overridden by a
   *   stale default, and a failed read is non-fatal: a projector must come up even when the settings
   *   call fails.
   * @returns {Promise} resolves once the effective room/mode/preset are settled
   */
  function loadStoredSettings() {
    if (S.demo) return Promise.resolve();
    var needRoom = !qs.get('room');
    var needMode = !qs.get('mode');
    var needPreset = !qs.get('preset');
    if (!needRoom && !needMode && !needPreset) return Promise.resolve();
    return api('/api/pumpkin/settings').then(function (j) {
      if (!j) return;
      if (needRoom && j.roomLabel) S.roomLabel = String(j.roomLabel);
      if (needMode && j.mode) S.mode = j.mode === 'autonomous' ? 'autonomous' : 'mimic';
      if (needPreset && j.activePreset) S.storedPreset = String(j.activePreset);
    }).catch(function () { /* keep the query/defaults — the projector still has to come up */ });
  }

  // ── Preset loading ─────────────────────────────────────────────────────────
  function loadPreset(name) {
    return api('/api/pumpkin/presets/' + encodeURIComponent(name)).then(function (j) {
      if (j && j.preset) applyPreset(j.preset);
    }).catch(function () { /* keep current */ });
  }
  function applyPreset(p) {
    S.preset = p; if (face) face.setPreset(p);
    if (els.preset) els.preset.textContent = p.label || p.name;
  }

  // ── Self-echo detection ────────────────────────────────────────────────────
  /**
   * Normalize a heard/spoken line to a comparable word bag.
   * @description Recognition punctuates and capitalizes differently from what we sent to TTS, so a
   *   raw string compare never catches the prop hearing itself. Reducing both sides to lowercase
   *   words is what makes the echo test survive that round trip.
   * @param {string} text
   * @returns {string} space-separated lowercase words
   */
  function normalizeHeard(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * True when `heard` is plausibly the projector's own last utterance coming back through the mic.
   * @description The deaf window covers the immediate tail; this covers late room reverb and a slow
   *   recognizer that finalizes seconds after playback ended. Substring OR 60% word overlap, because
   *   recognition drops and mangles words — an exact match would almost never fire.
   * @param {string} heard what the mic just transcribed
   * @param {string} spoken the last line this projector said out loud
   * @returns {boolean} true ⇒ drop the transcript, do not reply to ourselves
   */
  function isSelfEcho(heard, spoken) {
    var a = normalizeHeard(heard);
    var b = normalizeHeard(spoken);
    if (!a || !b) return false;
    if (b.indexOf(a) !== -1) return true;
    var wordsA = a.split(' ');
    var wordsB = b.split(' ');
    var bag = Object.create(null);
    var i;
    for (i = 0; i < wordsB.length; i++) bag[wordsB[i]] = true;
    var hits = 0;
    for (i = 0; i < wordsA.length; i++) { if (bag[wordsA[i]]) hits++; }
    return (hits / wordsA.length) >= SELF_ECHO_OVERLAP;
  }
  window.PumpkinSelfEcho = isSelfEcho;

  // ── Speaking (queued — utterances must never overlap) ───────────────────────
  /**
   * Queue a line for the prop to say.
   * @description Overlapping BufferSources used to clear _playing mid-utterance, which left
   *   face.setSpeaking(true) stuck on and (worse) re-opened the mic while audio was still playing.
   *   One utterance at a time, oldest dropped past the cap, is the fix.
   * @param {string} text
   * @param {string} [expression]
   * @param {number} [intensity]
   * @returns {void}
   */
  function speakLine(text, expression, intensity) {
    text = String(text == null ? '' : text).trim();
    if (!text) return;
    if (S.speakQueue.length >= SPEAK_QUEUE_MAX) S.speakQueue.shift();
    S.speakQueue.push({ text: text, expression: expression || 'neutral', intensity: intensity == null ? 0.6 : intensity });
    drainSpeech();
  }

  /** Start the next queued utterance if nothing is currently speaking. */
  function drainSpeech() {
    if (S.turn === 'speaking' || !S.speakQueue.length) return;
    beginUtterance(S.speakQueue.shift());
  }

  /** Watchdog budget for one line — generous, because it only fires when playback WEDGED. */
  function speakWatchdogMs(text) {
    var words = String(text || '').split(/\s+/).length;
    return Math.max(6000, words * 600) + 5000;
  }

  /**
   * Speak one queued line, owning the whole speaking turn.
   * @description Closes the ear BEFORE any sound leaves the speakers (the old code never stopped the
   *   mic at all), then on completion records the line, opens the deaf window, and re-arms the ear.
   * @param {{text:string, expression:string, intensity:number}} item
   * @returns {void}
   */
  function beginUtterance(item) {
    S.turn = 'speaking';
    stopListen();
    face.setExpression(item.expression, item.intensity);
    face.setSpeaking(true);
    setStatus('speaking…');
    var settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      if (S.speakTimer) { clearTimeout(S.speakTimer); S.speakTimer = null; }
      face.setSpeaking(false); face.setExpression('neutral', 0.3);
      S.lastSpoken = item.text;
      S.deafUntil = Date.now() + DEAF_AFTER_SPEECH_MS;
      S.turn = 'cooldown';
      setStatus(idleStatus());
      refreshAudioGate();
      if (S.speakQueue.length) { S.turn = 'idle'; drainSpeech(); return; }
      armEar(DEAF_AFTER_SPEECH_MS + EAR_RESTART_MS);
    }
    S.speakTimer = setTimeout(function () { audio.forceStop(); finish(); }, speakWatchdogMs(item.text));
    audio.speak(item.text, S.preset.voice, {
      browserOnly: S.demo,
      onLevel: function (v) { face.setLevel(v); },
      onEnd: finish,
    });
  }

  // ── Listening (local mic) ───────────────────────────────────────────────────
  function clearEarTimer() { if (S.earTimer) { clearTimeout(S.earTimer); S.earTimer = null; } }

  /**
   * Whether the always-on ear is allowed to (re)open right now.
   * @description Re-evaluated at fire time, not only at schedule time — the operator can flip mode or
   *   listen-mode during the 400ms restart window, and the old timer only re-checked listenMode, so it
   *   re-opened a mic the operator had just closed.
   * @returns {boolean}
   */
  function earShouldStayOpen() {
    return !S.micFatal && S.listenMode === 'open' && S.mode === 'autonomous'
      && !audio.speaking && S.turn !== 'speaking' && S.turn !== 'thinking';
  }

  /** Backoff between ear restarts — flat while the porch is merely quiet, backing off on real faults. */
  function earRestartDelay() {
    if (!S.earFaults) return EAR_RESTART_MS;
    return EAR_FAULT_BACKOFF_MS[Math.min(S.earFaults - 1, EAR_FAULT_BACKOFF_MS.length - 1)];
  }

  /** Schedule exactly one always-on ear restart; any previous pending restart is cancelled. */
  function armEar(delay) {
    clearEarTimer();
    if (!earShouldStayOpen()) { setStatus(idleStatus()); return; }
    S.earTimer = setTimeout(function () {
      S.earTimer = null;
      if (!earShouldStayOpen()) return;
      if (S.turn === 'cooldown') S.turn = 'idle';
      startListen();
    }, delay);
  }

  function isFatalMicError(code) { return FATAL_MIC_ERRORS.indexOf(code) !== -1; }
  function isQuietMicError(code) { return QUIET_MIC_ERRORS.indexOf(code) !== -1; }

  /**
   * Give up on the mic and make the reason STICKY.
   * @description Every other status writer routes through idleStatus(), so parking the message there
   *   is what stops the very next stopListen()/armEar() from overwriting the one line that explains
   *   why the prop stopped hearing anyone.
   * @param {string} text operator-readable cause
   * @returns {void}
   */
  function failMic(text) {
    S.micFatal = true; S.micFatalText = text;
    S.listening = false; clearEarTimer();
    setStatus(idleStatus());
  }

  /** Handle a recognition error, splitting "the porch is quiet" from "the mic is broken". */
  function onMicError(code) {
    document.body.classList.remove('listening');
    if (isFatalMicError(code)) {
      failMic(code === 'browser_speech_unavailable'
        ? 'Voice input unavailable here — type in the control tab'
        : 'mic blocked (' + code + ') — check the browser mic permission');
      return;
    }
    if (!isQuietMicError(code)) S.earFaults += 1;
    if (S.earFaults >= EAR_MAX_CONSEC_FAULTS) {
      failMic('mic gave up after ' + S.earFaults + ' failures — reload the projector');
      return;
    }
    if (!isQuietMicError(code)) setStatus('mic: ' + code);
  }

  function startListen() {
    if (S.listening || audio.speaking || S.turn === 'speaking') return;
    // 'thinking' is deliberately NOT an early return. armEar() already refuses to schedule an
    // automatic restart mid-think (earShouldStayOpen), so the only way to reach here in that state
    // is a deliberate gesture — SPACE or the Hold-to-talk button — and a human at the projector is
    // the last line of recovery when the reply never lands. Ending the turn first matters: without
    // it acceptTranscript would drop everything the operator then says.
    if (S.turn === 'thinking') endThink(true);
    clearEarTimer();
    // Reaching here while micFatal is set can only be a deliberate operator retry (armEar refuses to
    // schedule one), so clear the give-up counters and give the mic a genuinely fresh chance.
    if (S.micFatal) { S.micFatal = false; S.micFatalText = ''; S.earFaults = 0; }
    S.listening = true; S.turn = 'listening';
    setStatus('listening…'); document.body.classList.add('listening');
    audio.startListening({
      // continuous keeps one recognition session alive across the silent gaps between kids
      // instead of tearing down and rebuilding a recognizer after every single utterance.
      continuous: S.listenMode === 'open' && S.mode === 'autonomous',
      onInterim: function (t) { if (S.turn === 'listening') setStatus('… ' + t); },
      onFinal: function (t) { onTranscript(t); },
      onError: function (e) { onMicError(String(e || 'recog_error')); },
      browserOnly: S.demo,
      onEnd: function () {
        S.listening = false;
        document.body.classList.remove('listening');
        if (S.turn === 'listening') S.turn = 'idle';
        // Always-on: re-arm. The old guard read S.listening, which onError had already cleared,
        // so the ear died permanently at the first no-speech on a quiet porch.
        if (earShouldStayOpen()) { armEar(earRestartDelay()); return; }
        if (S.turn !== 'speaking' && S.turn !== 'thinking') setStatus(idleStatus());
      },
    });
  }

  function stopListen() {
    clearEarTimer();
    if (!S.listening) return;
    S.listening = false; audio.stopListening();
    document.body.classList.remove('listening');
    if (S.turn === 'listening') S.turn = 'idle';
    if (S.turn !== 'speaking' && S.turn !== 'thinking') setStatus(idleStatus());
  }

  /**
   * Gate every transcript before it can cost anything.
   * @description Five independent reasons to drop, because a single boolean check already failed here
   *   once: a reply in flight, a turn that is not listening-eligible, live playback, the post-speech
   *   deaf window, a self-echo, or a fragment too short to be a sentence.
   * @param {string} text
   * @returns {boolean} true ⇒ the utterance is a real guest speaking to the prop
   */
  function acceptTranscript(text) {
    if (!text) return false;
    if (S.inFlight || S.turn === 'thinking' || S.turn === 'speaking') return false;
    if (audio.speaking) return false;
    if (Date.now() < S.deafUntil) return false;
    if (normalizeHeard(text).length < MIN_UTTERANCE_CHARS) return false;
    if (isSelfEcho(text, S.lastSpoken)) return false;
    return true;
  }

  /** Frame-0 reaction so the face moves the instant we hear you, not 3-10s later when the LLM answers. */
  function acknowledge() {
    if (!face) return;
    face.setExpression('surprised', 0.55);
    face.setLevel(0);
  }

  function returnToEar() {
    S.turn = 'idle';
    setStatus(idleStatus());
    armEar(EAR_RESTART_MS);
  }

  /**
   * End the current thinking turn, whatever caused it to end.
   * @description The ONE place S.inFlight, the abort controller and the deadline timer are cleared,
   *   so the network reply, the deadline and a human override can never disagree about the turn
   *   state. Every re-entry point (earShouldStayOpen, acceptTranscript, startListen) reads
   *   S.inFlight / S.turn === 'thinking', which is why leaving them set on a request that never
   *   settled made the prop permanently deaf — including to the push-to-talk button.
   * @param {boolean} abortRequest true ⇒ also abort the in-flight fetch, so a late reply can never
   *   arrive and speak over whatever the prop is doing by then
   * @returns {void}
   */
  function endThink(abortRequest) {
    if (S.thinkTimer) { clearTimeout(S.thinkTimer); S.thinkTimer = null; }
    var ctrl = S.thinkAbort;
    S.thinkAbort = null;
    S.thinkTurn = 0;
    S.inFlight = false;
    if (abortRequest && ctrl) { try { ctrl.abort(); } catch (e) { /* already settled */ } }
  }

  /**
   * Arm the unconditional recovery deadline for one thinking turn.
   * @description Separate from the abort, and NOT redundant with it: the abort stops the REQUEST,
   *   while this is what guarantees the ear re-opens even where the abort does nothing — an older
   *   browser with no AbortController, or a fetch that ignores the signal. Whichever fires, the prop
   *   is listening again and the status says why.
   * @param {number} myTurn the turn token this deadline belongs to; a stale one is ignored
   * @returns {void}
   */
  function armThinkDeadline(myTurn) {
    S.thinkTimer = setTimeout(function () {
      S.thinkTimer = null;
      if (S.thinkTurn !== myTurn) return;
      endThink(true);
      returnToEar();
      setStatus('the pumpkin lost its train of thought — listening again');
    }, THINK_DEADLINE_MS);
  }

  function onTranscript(text) {
    text = String(text || '').trim();
    if (!acceptTranscript(text)) return;
    S.earFaults = 0;
    if (S.mode === 'mimic') { speakLine(text, 'neutral', 0.6); return; }
    if (S.demo) {
      var local = demoReply(text);
      speakLine(local.say, local.expression, local.intensity);
      return;
    }
    S.turn = 'thinking'; S.inFlight = true;
    stopListen();
    acknowledge();
    setStatus('thinking…');
    S.thinkSeq += 1;
    var myTurn = S.thinkSeq;
    S.thinkTurn = myTurn;
    var Ctrl = window.AbortController;
    var ctrl = typeof Ctrl === 'function' ? new Ctrl() : null;
    S.thinkAbort = ctrl;
    armThinkDeadline(myTurn);
    api('/api/pumpkin/chat', {
      method: 'POST',
      body: JSON.stringify({ text: text }),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (j) {
      if (S.thinkTurn !== myTurn) return;   // the deadline or a human already ended this turn
      endThink(false);
      var rep = j && j.reply;
      // An explicitly empty say is a legal reply — the prop declines to answer the television
      // rather than being forced into a canned line that would re-trigger the room.
      if (rep && typeof rep.say === 'string' && !rep.say.trim()) { returnToEar(); return; }
      if (rep && rep.say) speakLine(rep.say, rep.expression, rep.intensity);
      else speakLine('Heh... my thoughts drift on the wind. Say that again?', 'mischief', 0.5);
    }).catch(function () {
      if (S.thinkTurn !== myTurn) return;   // an aborted request must not also speak the error line
      endThink(false);
      speakLine('The candle sputters... try me again.', 'spooky', 0.5);
    });
  }

  // ── Paired room (a phone remote can drive THIS screen) ──────────────────────
  function setupPaired() {
    if (S.demo) {
      S.demoBus = createDemoBus(S.demoChannel, onStreamEvent);
      S.roomName = 'Browser demo';
      setLink('demo');
      return;
    }
    linkStart();
  }

  /** Jittered, capped backoff. Jitter matters when several screens lose the api at the same instant. */
  function backoffDelay() {
    var base = LINK_BACKOFF_MS[Math.min(S.backoff, LINK_BACKOFF_MS.length - 1)];
    return Math.round(base * ((1 - LINK_JITTER) + (Math.random() * LINK_JITTER * 2)));
  }

  /**
   * Bring the room link up and keep it up for the whole night.
   * @description The single heartbeat interval is armed HERE and nowhere else — arming it inside the
   *   register callback (as the original did) stacks one more interval on every re-register.
   * @returns {void}
   */
  function linkStart() {
    setLink('connecting');
    linkRegister();
    if (!S.hbTimer) S.hbTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Claim (or re-claim) the room. register() is idempotent per label and returns the SAME token. */
  function linkRegister() {
    if (S.registering) return;
    S.registering = true;
    if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = null; }
    api('/api/pumpkin/rooms/register', { method: 'POST', body: JSON.stringify({ label: S.roomLabel }) }).then(function (j) {
      S.registering = false;
      if (!j || !j.room) { linkRetry('no_room'); return; }
      S.room = j.room;
      // Keep the previous token if a re-register somehow omits one: a null-token window would make
      // every remote push fail with invalid_room_or_token for no reason.
      S.token = j.token || S.token;
      S.roomName = j.label || j.room;
      S.missedBeats = 0; S.backoff = 0;
      setLink('live');
      linkSubscribe();
    }).catch(function (err) {
      S.registering = false;
      linkRetry(err && err.status === 401 ? 'unauthorized' : 'register_failed');
    });
  }

  /** Schedule the next register attempt. Retries FOREVER — a Halloween night outlasts any deploy. */
  function linkRetry(reason) {
    if (reason === 'unauthorized') setLink('unauthorized', reason);
    else setLink('connecting', reason);
    var delay = backoffDelay();
    S.backoff = Math.min(S.backoff + 1, LINK_BACKOFF_MS.length - 1);
    if (S.retryTimer) clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(function () { S.retryTimer = null; linkRegister(); }, delay);
  }

  function linkCloseStream() {
    if (S.silenceTimer) { clearTimeout(S.silenceTimer); S.silenceTimer = null; }
    if (S.graceTimer) { clearTimeout(S.graceTimer); S.graceTimer = null; }
    if (S.es) { try { S.es.close(); } catch (e) { /* already closed */ } S.es = null; }
  }

  /**
   * Tear the room down and re-claim it from scratch.
   * @description The recovery path for every "the room is gone" signal. Closing our EventSource first
   *   matters twice: it stops the browser's own blind auto-retry fighting this machine, and the FIN it
   *   sends is what finally lets the server drop a listener wedged on a half-open socket.
   * @param {string} reason short machine-ish reason, shown on the badge (never a token)
   * @returns {void}
   */
  function reregister(reason) {
    if (S.demo) return;
    linkCloseStream();
    S.room = null;
    linkRetry(reason);
  }

  function linkSubscribe() {
    linkCloseStream();
    try {
      var es = new EventSource('/api/pumpkin/stream?room=' + encodeURIComponent(S.room));
      es.onopen = function () {
        if (S.graceTimer) { clearTimeout(S.graceTimer); S.graceTimer = null; }
        S.backoff = 0; setLink('live'); armStreamWatchdog();
      };
      es.onmessage = function (m) {
        armStreamWatchdog();
        var evt = null;
        try { evt = JSON.parse(m.data); } catch (e) { evt = null; }
        if (evt) onStreamEvent(evt);
      };
      es.onerror = function () { onStreamError(es); };
      S.es = es;
      armStreamWatchdog();
      armOpenGrace();
    } catch (e) { linkRetry('sse_unavailable'); }
  }

  /**
   * Deadline on the silent socket.
   * @description A half-open TCP connection delivers no frames, no FIN and no error — EventSource sits
   *   there believing it is connected. The server pings every 25s, so 70s of true silence is proof the
   *   link is dead even though nothing reported it.
   * @returns {void}
   */
  function armStreamWatchdog() {
    if (S.silenceTimer) clearTimeout(S.silenceTimer);
    S.silenceTimer = setTimeout(function () { S.silenceTimer = null; reregister('silent'); }, STREAM_SILENCE_MS);
  }

  /** An EventSource that never reaches OPEN is not coming up; re-register rather than wait forever. */
  function armOpenGrace() {
    if (S.graceTimer) clearTimeout(S.graceTimer);
    S.graceTimer = setTimeout(function () {
      S.graceTimer = null;
      if (S.es && S.es.readyState !== 1) reregister('stream_never_opened');
    }, STREAM_OPEN_GRACE_MS);
  }

  function onStreamError(es) {
    if (S.es !== es) return;
    // readyState 2 (CLOSED) is TERMINAL: the server answered non-2xx (409 unknown_room / 401) and
    // EventSource will never retry on its own. Anything else is a transient drop the browser retries
    // — but the silence watchdog still owns the deadline, so it can never retry forever in silence.
    if (es.readyState === 2) { reregister('stream_closed'); return; }
    setLink('degraded', 'stream');
  }

  /**
   * One heartbeat. Its RESULT is the point — the original discarded it and had no .catch at all.
   * @description {ok:false} means the server no longer knows this room (api restart, eviction), which
   *   is exactly the "the pumpkin went deaf mid-party" case: the projector must re-register, not keep
   *   beating into nothing. Three consecutive network failures are treated the same way.
   * @returns {void}
   */
  function beat() {
    if (S.demo || !S.room) return;
    api('/api/pumpkin/rooms/heartbeat', { method: 'POST', body: JSON.stringify({ room: S.room }) }).then(function (j) {
      if (j && j.ok === false) { reregister('room_gone'); return; }
      S.missedBeats = 0;
      if (S.link !== 'live' && S.es && S.es.readyState === 1) setLink('live');
    }).catch(function (err) {
      if (err && err.status === 401) { reregister('unauthorized'); return; }
      S.missedBeats += 1;
      setLink('degraded', 'beat ' + S.missedBeats);
      if (S.missedBeats >= 3) reregister('beats_lost');
    });
  }

  function onStreamEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'ping') return;                                  // liveness only; consumed here
    if (evt.type === 'evicted') { reregister('evicted'); return; }    // terminal: the room is gone
    if (evt.type === 'error') { reregister(String(evt.error || 'server_error')); return; }
    if (evt.type === 'speak') speakLine(evt.say, evt.expression, evt.intensity);
    else if (evt.type === 'preset') {
      if (evt.preset) applyPreset(evt.preset);
      else loadPreset(evt.name);
    }
    else if (evt.type === 'mode') setMode(evt.mode);
  }

  // ── Modes + status ──────────────────────────────────────────────────────────
  function setMode(m) {
    var next = m === 'autonomous' ? 'autonomous' : 'mimic';
    S.mode = next;
    clearEarTimer();
    if (S.mode !== 'autonomous' && S.listenMode === 'open') stopListen();
    else if (S.listenMode === 'open' && S.mode === 'autonomous') armEar(EAR_RESTART_MS);
    updateModeUi(); setStatus(idleStatus());
  }
  function idleStatus() {
    if (S.micFatal && S.micFatalText) return S.micFatalText;
    if (S.link !== 'live' && S.link !== 'demo') return linkStatusText();
    var trig = S.listenMode === 'open' && S.mode === 'autonomous' ? 'always-on' : 'hold SPACE to talk';
    var status = S.mode === 'mimic' ? 'Mimic · ' + trig : 'Autonomous · ' + trig;
    return S.demo ? status + ' · browser demo' : status;
  }
  function setStatus(s) { if (els.status) els.status.textContent = s; }
  function updateModeUi() {
    if (els.mimic) els.mimic.classList.toggle('on', S.mode === 'mimic');
    if (els.auto) els.auto.classList.toggle('on', S.mode === 'autonomous');
    if (els.listen) els.listen.textContent = S.listenMode === 'open' ? 'Always-on' : 'Push-to-talk';
  }

  // ── Link readout (must be legible from the yard, not from a console) ────────
  function linkLabel() {
    if (S.link === 'live') return 'linked';
    if (S.link === 'demo') return 'browser demo';
    if (S.link === 'unauthorized') return 'signed out';
    if (S.link === 'connecting') return S.linkDetail ? 'reconnecting · ' + S.linkDetail : 'connecting…';
    if (S.link === 'degraded') return S.linkDetail ? 'unstable · ' + S.linkDetail : 'unstable';
    return 'offline';
  }
  function linkStatusText() {
    if (S.link === 'unauthorized') return 'Signed out — sign in on the projector device';
    if (S.link === 'connecting') return 'Reconnecting to the room…';
    if (S.link === 'degraded') return 'Room link unstable — retrying';
    return 'Room link offline';
  }
  function renderRoomName() {
    if (!els.room) return;
    var name = S.roomName || S.roomLabel || '—';
    els.room.textContent = (S.link === 'live' || S.link === 'demo') ? name : name + ' · reconnecting';
  }

  /**
   * Publish the link state to every human-visible surface.
   * @description The whole failure class this fixes was SILENT. A badge dot, the room label, the status
   *   line and (when the session dies) a full-screen overlay all move together so an operator standing
   *   in the yard can tell "recovering" from "needs me" without opening devtools.
   * @param {string} state connecting|live|degraded|unauthorized|demo|offline
   * @param {string} [detail] short reason — never a token or a URL
   * @returns {void}
   */
  function setLink(state, detail) {
    S.link = state;
    S.linkDetail = detail || '';
    if (els.linkText) els.linkText.textContent = linkLabel();
    if (els.link) els.link.className = 'link ' + state;
    document.body.classList.toggle('link-bad', state !== 'live' && state !== 'demo');
    if (state === 'unauthorized') showReauth(); else hideReauth();
    renderRoomName();
    if (S.turn !== 'speaking' && S.turn !== 'thinking') setStatus(idleStatus());
  }

  function showReauth() {
    if (!els.reauth) return;
    if (els.reauthUrl) els.reauthUrl.textContent = window.location.origin + window.location.pathname;
    els.reauth.hidden = false;
  }
  function hideReauth() { if (els.reauth) els.reauth.hidden = true; }

  // ── Audio gate + wake lock (the two silent ways a projector "dies") ─────────
  /**
   * Show the tap-to-wake overlay whenever the AudioContext is not actually running.
   * @description A suspended context plays nothing, fires no onended, and used to leave the prop
   *   permanently mute AND permanently deaf. Autoplay policy only lifts on a real gesture, so the
   *   honest fix is to ask for one rather than pretend the pumpkin is speaking.
   * @returns {void}
   */
  function refreshAudioGate() {
    if (!els.audiogate) return;
    var state = audio.contextState();
    // 'unavailable' means this browser has no WebAudio at all — the speechSynthesis fallback still
    // speaks, so blocking the projector behind a gate that can never clear would be worse than useless.
    els.audiogate.hidden = state === 'running' || state === 'unavailable';
  }
  function dismissAudioGate() {
    if (audio.contextState() === 'running') { refreshAudioGate(); return; }
    audio.unlock();
    setTimeout(refreshAudioGate, 250);
  }

  /** Hold the screen awake. Chromium-only; an OS power policy can still win, hence the runbook. */
  function requestWakeLock() {
    if (!navigator || !navigator.wakeLock || document.visibilityState === 'hidden') return;
    try {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        S.wakeLock = sentinel;
        sentinel.addEventListener('release', function () { S.wakeLock = null; });
      }).catch(function () { S.wakeLock = null; });
    } catch (e) { S.wakeLock = null; }
  }

  // ── Controls + input ────────────────────────────────────────────────────────
  function setupControls() {
    els.mimic.onclick = function () { setMode('mimic'); };
    els.auto.onclick = function () { setMode('autonomous'); };
    els.listen.onclick = function () {
      S.listenMode = S.listenMode === 'open' ? 'ptt' : 'open';
      updateModeUi(); setStatus(idleStatus());
      if (S.listenMode === 'open' && S.mode === 'autonomous') startListen(); else stopListen();
    };
    els.talk.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { els.talk.setPointerCapture(e.pointerId); } catch (err) { /* pointer capture unavailable */ }
      audio.unlock(); startListen();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
      els.talk.addEventListener(type, function (e) { e.preventDefault(); if (S.listenMode === 'ptt') stopListen(); });
    });
    els.full.onclick = toggleFullscreen;

    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      if (e.code === 'Space') { e.preventDefault(); audio.unlock(); startListen(); }
      else if (e.key === 'm' || e.key === 'M') setMode(S.mode === 'mimic' ? 'autonomous' : 'mimic');
      else if (e.key === 'l' || e.key === 'L') els.listen.onclick();
      else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('chrome-hidden');
    });
    document.addEventListener('keyup', function (e) { if (e.code === 'Space' && S.listenMode === 'ptt') stopListen(); });

    // Any gesture anywhere is enough to lift the autoplay block — do not make them find a button.
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
      document.addEventListener(type, dismissAudioGate);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      requestWakeLock();                     // the sentinel is auto-released whenever the page hides
      refreshAudioGate();
    });

    // Auto-hide the chrome + cursor on a still projector.
    var hideT;
    function poke() { document.body.classList.remove('idle'); clearTimeout(hideT); hideT = setTimeout(function () { document.body.classList.add('idle'); }, 4000); }
    document.addEventListener('mousemove', poke); document.addEventListener('touchstart', poke); poke();
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) { (document.documentElement.requestFullscreen || function () {}).call(document.documentElement); }
    else if (document.exitFullscreen) document.exitFullscreen();
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  // One hoisted frame callback: the old loop(prev) built a NEW closure every frame,
  // roughly 1.3 million allocations over a six-hour night.
  function frame(now) {
    var dt = Math.min(0.06, (now - lastFrame) / 1000) || 0.016;
    lastFrame = now;
    face.render(dt);
    window.requestAnimationFrame(frame);
  }
  function init() {
    els = {
      canvas: document.getElementById('stage'), status: document.getElementById('status'),
      preset: document.getElementById('presetName'), room: document.getElementById('roomName'),
      mimic: document.getElementById('btnMimic'), auto: document.getElementById('btnAuto'),
      listen: document.getElementById('btnListen'), talk: document.getElementById('btnTalk'),
      full: document.getElementById('btnFull'),
      link: document.getElementById('link'), linkText: document.getElementById('linkText'),
      audiogate: document.getElementById('audiogate'),
      reauth: document.getElementById('reauth'), reauthUrl: document.getElementById('reauthUrl'),
    };
    face = new PumpkinFace(els.canvas, S.preset);
    audio = new PumpkinAudio('');
    setupControls(); updateModeUi(); setStatus(idleStatus());
    // Rendering starts BEFORE the stored-defaults read: a slow api must never show a black screen
    // on a projector. Only the room, the look and the ear wait for the effective settings.
    lastFrame = window.performance.now();
    window.requestAnimationFrame(frame);
    loadStoredSettings().then(startSession);
  }

  /** Bring up the look, the paired room and the ear once the effective room/mode/preset are known. */
  function startSession() {
    updateModeUi(); setStatus(idleStatus());
    var startName = qs.get('preset') || S.storedPreset || S.preset.name;
    if (!S.demo || !loadDemoPreset(startName)) loadPreset(startName);
    setupPaired();
    audio.unlock(); refreshAudioGate(); requestWakeLock();
    if (S.listenMode === 'open' && S.mode === 'autonomous') startListen();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
