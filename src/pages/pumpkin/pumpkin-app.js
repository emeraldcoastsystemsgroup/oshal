/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: projector controller. Loads a preset, runs the render loop, and wires both topologies at once — local mic (mimic push-to-talk / autonomous, push-to-talk or always-on) AND a paired room (registers, SSE-subscribes, so a phone remote can drive this screen). Handles TTS speak + lip-sync callbacks, expression, keyboard/fullscreen/cursor-hide.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Public browser demo: same-browser control/projector/remote pairing over BroadcastChannel, deterministic no-LLM autonomous replies, local preset handoff, and browser-only speech. Authenticated SSE/room behavior is unchanged.
 */

/* global window, document, PumpkinFace, PumpkinAudio, EventSource */
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
  };

  var face, audio, els = {};

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

  // ── Speaking ───────────────────────────────────────────────────────────────
  function speakLine(text, expression, intensity) {
    if (!text) return;
    face.setExpression(expression || 'neutral', intensity == null ? 0.6 : intensity);
    face.setSpeaking(true);
    setStatus('speaking…');
    audio.speak(text, S.preset.voice, {
      browserOnly: S.demo,
      onLevel: function (v) { face.setLevel(v); },
      onEnd: function () { face.setSpeaking(false); face.setExpression('neutral', 0.3); setStatus(idleStatus()); },
    });
  }

  // ── Listening (local mic) ───────────────────────────────────────────────────
  function startListen() {
    if (S.listening || audio.speaking) return;
    S.listening = true; setStatus('listening…'); document.body.classList.add('listening');
    audio.startListening({
      onInterim: function (t) { setStatus('… ' + t); },
      onFinal: function (t) { onTranscript(t); },
      onError: function (e) { S.listening = false; setStatus(e === 'browser_speech_unavailable' ? 'Voice input unavailable here — type in the control tab' : 'mic: ' + e); },
      browserOnly: S.demo,
      onEnd: function () {
        document.body.classList.remove('listening');
        // Always-on autonomous: keep the ear open (unless we're now speaking).
        if (S.listening && S.listenMode === 'open' && S.mode === 'autonomous' && !audio.speaking) {
          setTimeout(function () { if (S.listenMode === 'open' && !audio.speaking) { S.listening = false; startListen(); } }, 400);
        } else { S.listening = false; setStatus(idleStatus()); }
      },
    });
  }
  function stopListen() {
    if (!S.listening) return;
    S.listening = false; audio.stopListening();
    document.body.classList.remove('listening'); setStatus(idleStatus());
  }
  function onTranscript(text) {
    text = (text || '').trim(); if (!text) return;
    if (S.mode === 'mimic') { speakLine(text, 'neutral', 0.6); return; }
    if (S.demo) {
      var local = demoReply(text);
      speakLine(local.say, local.expression, local.intensity);
      return;
    }
    setStatus('thinking…');
    api('/api/pumpkin/chat', { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (j) {
      var rep = j && j.reply;
      if (rep && rep.say) speakLine(rep.say, rep.expression, rep.intensity);
      else { speakLine('Heh... my thoughts drift on the wind. Say that again?', 'mischief', 0.5); }
    }).catch(function () { speakLine('The candle sputters... try me again.', 'spooky', 0.5); });
  }

  // ── Paired room (a phone remote can drive THIS screen) ──────────────────────
  function setupPaired() {
    if (S.demo) {
      S.demoBus = createDemoBus(S.demoChannel, onStreamEvent);
      if (els.room) els.room.textContent = 'Browser demo';
      return;
    }
    api('/api/pumpkin/rooms/register', { method: 'POST', body: JSON.stringify({ label: S.roomLabel }) }).then(function (j) {
      if (!j || !j.room) return;
      S.room = j.room; S.token = j.token;
      if (els.room) els.room.textContent = j.label || j.room;
      subscribe();
      setInterval(function () { api('/api/pumpkin/rooms/heartbeat', { method: 'POST', body: JSON.stringify({ room: S.room }) }); }, 30000);
    }).catch(function () { /* all-in-one still works */ });
  }
  function subscribe() {
    try {
      var es = new EventSource('/api/pumpkin/stream?room=' + encodeURIComponent(S.room));
      es.onmessage = function (m) { try { onStreamEvent(JSON.parse(m.data)); } catch (e) { /* ignore */ } };
      es.onerror = function () { /* EventSource auto-reconnects */ };
      S.es = es;
    } catch (e) { /* SSE unavailable */ }
  }
  function onStreamEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'speak') speakLine(evt.say, evt.expression, evt.intensity);
    else if (evt.type === 'preset') {
      if (evt.preset) applyPreset(evt.preset);
      else loadPreset(evt.name);
    }
    else if (evt.type === 'mode') setMode(evt.mode);
  }

  // ── Modes + status ──────────────────────────────────────────────────────────
  function setMode(m) {
    S.mode = m === 'autonomous' ? 'autonomous' : 'mimic';
    if (S.mode !== 'autonomous' && S.listenMode === 'open') stopListen();
    updateModeUi(); setStatus(idleStatus());
  }
  function idleStatus() {
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

  // ── Controls + input ────────────────────────────────────────────────────────
  function setupControls() {
    els.mimic.onclick = function () { setMode('mimic'); };
    els.auto.onclick = function () { setMode('autonomous'); };
    els.listen.onclick = function () { S.listenMode = S.listenMode === 'open' ? 'ptt' : 'open'; updateModeUi(); setStatus(idleStatus()); if (S.listenMode === 'open' && S.mode === 'autonomous') startListen(); else stopListen(); };
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
  function loop(prev) {
    return function (now) {
      var dt = Math.min(0.06, (now - prev) / 1000) || 0.016;
      face.render(dt);
      window.requestAnimationFrame(loop(now));
    };
  }
  function init() {
    els = {
      canvas: document.getElementById('stage'), status: document.getElementById('status'),
      preset: document.getElementById('presetName'), room: document.getElementById('roomName'),
      mimic: document.getElementById('btnMimic'), auto: document.getElementById('btnAuto'),
      listen: document.getElementById('btnListen'), talk: document.getElementById('btnTalk'),
      full: document.getElementById('btnFull'),
    };
    face = new PumpkinFace(els.canvas, S.preset);
    audio = new PumpkinAudio('');
    setupControls(); updateModeUi(); setStatus(idleStatus());
    var startName = qs.get('preset') || S.preset.name;
    if (!S.demo || !loadDemoPreset(startName)) loadPreset(startName);
    setupPaired();
    if (S.listenMode === 'open' && S.mode === 'autonomous') startListen();
    window.requestAnimationFrame(loop(window.performance.now()));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
