/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added renderer UI logic: settings form, connect, send, and reply rendering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rebuilt as the OSHAL Node surface: Jarvis orb + voice (lifted from src/api/jarvis.html), chat over the remote-client IPC, worker activity log, identity sign-in, and local-account login buttons.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis mode UI: orb-row button + settings (open-on-launch checkbox, cockpit path) that open the swarm-hosted cockpit window
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Orb fallback polish (operator feedback): replies render as markdown (not raw text), TTS speaks a short sanitized summary (never URLs, ids, code, or tables), most-natural installed voice is the default
 */

'use strict';

// Wrapped in an IIFE so top-level `const`s are function-scoped. `window.oshal` is
// exposed by the preload as a NON-CONFIGURABLE global property; a global-scope
// `const oshal` would throw "Identifier 'oshal' has already been declared" at
// instantiation (restricted global property), so the whole script must not run at
// global lexical scope.
(function () {

const oshal = window.oshal;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CONFIG_FIELDS = [
  'controlPlaneUrl', 'sharedSecret', 'authHeaderName', 'targetAgentId',
  'clientName', 'headscaleLoginServer', 'headscaleAuthKey', 'cockpitPath',
  'cockpitBaseUrl', 'wakeAssistantName',
];

let busy = false;
let wakeStatus = null;

/* ===================== Orb (lifted from jarvis.html) ===================== */
const cvs = $('orb'), cctx = cvs.getContext('2d');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let W = 0, H = 0, DPR = Math.min(devicePixelRatio || 1, 2);
function sizeOrb() { const r = cvs.getBoundingClientRect(); W = r.width; H = r.height; cvs.width = W * DPR; cvs.height = H * DPR; cctx.setTransform(DPR, 0, 0, DPR, 0, 0); }
addEventListener('resize', sizeOrb);

let mode = 'idle', level = 0, targetLevel = 0, freq = null, t = 0; const BARS = 72;
const TC = { acc: '#34d3a6', bright: '#7cf0c8', glow: '52,211,166', core: '#0b1020' };
let orbStyle = (() => { try { return localStorage.getItem('oshalOrb') || 'halo'; } catch (e) { return 'halo'; } })();

function palette() {
  if (mode === 'speaking') return [TC.acc, TC.bright, '#ffffff'];
  if (mode === 'listening' || mode === 'thinking') return [TC.acc, TC.bright, TC.bright];
  return [TC.acc, TC.acc, TC.bright];
}
function bgGlow(cx, cy, R, baseR, amp) {
  const g = cctx.createRadialGradient(cx, cy, baseR * 0.5, cx, cy, R);
  g.addColorStop(0, 'rgba(' + TC.glow + ',' + (0.16 + 0.22 * amp) + ')'); g.addColorStop(1, 'rgba(' + TC.glow + ',0)');
  cctx.fillStyle = g; cctx.beginPath(); cctx.arc(cx, cy, R, 0, 7); cctx.fill();
}
function coreSphere(cx, cy, baseR, c1, c3, amp) {
  const core = cctx.createRadialGradient(cx - baseR * 0.3, cy - baseR * 0.3, baseR * 0.1, cx, cy, baseR);
  core.addColorStop(0, '#ffffff'); core.addColorStop(0.35, c3); core.addColorStop(0.75, c1); core.addColorStop(1, TC.core);
  cctx.fillStyle = core; cctx.beginPath(); cctx.arc(cx, cy, baseR, 0, 7); cctx.fill();
  cctx.fillStyle = 'rgba(255,255,255,' + (0.10 + 0.22 * amp) + ')'; cctx.beginPath(); cctx.arc(cx - baseR * 0.25, cy - baseR * 0.28, baseR * 0.32, 0, 7); cctx.fill();
}
function drawHalo(cx, cy, R, amp, baseR, c1, c2, c3) {
  bgGlow(cx, cy, R, baseR, amp);
  for (let i = 0; i < BARS; i++) {
    const a = (i / BARS) * Math.PI * 2; const h = Math.max(0.04, (mode === 'listening' && freq) ? freq[i % freq.length] / 255 : 0.5 + 0.5 * Math.sin(t * 3 + i * 0.5) * (0.4 + 0.6 * amp));
    const inner = baseR * 1.12, outer = inner + h * R * 0.34 * (0.5 + amp);
    const x1 = cx + Math.cos(a) * inner, y1 = cy + Math.sin(a) * inner, x2 = cx + Math.cos(a) * outer, y2 = cy + Math.sin(a) * outer;
    const g = cctx.createLinearGradient(x1, y1, x2, y2); g.addColorStop(0, c2); g.addColorStop(1, c3);
    cctx.strokeStyle = g; cctx.lineWidth = Math.max(2, R * 0.018); cctx.lineCap = 'round'; cctx.globalAlpha = 0.85;
    cctx.beginPath(); cctx.moveTo(x1, y1); cctx.lineTo(x2, y2); cctx.stroke();
  }
  cctx.globalAlpha = 1;
  for (let k = 0; k < 2; k++) {
    cctx.save(); cctx.strokeStyle = 'rgba(' + TC.glow + ',' + (0.12 + 0.10 * amp) + ')'; cctx.lineWidth = 1.2; cctx.beginPath();
    const rr = baseR * (1.3 + k * 0.22);
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2 + t * (k ? -0.3 : 0.4); const wob = 1 + 0.05 * Math.sin(a * 6 + t * 2) * amp; cctx.lineTo(cx + Math.cos(a) * rr * wob, cy + Math.sin(a) * rr * wob); }
    cctx.stroke(); cctx.restore();
  }
  coreSphere(cx, cy, baseR, c1, c3, amp);
}
function drawPulse(cx, cy, R, amp, baseR, c1, c2, c3) {
  bgGlow(cx, cy, R, baseR, amp);
  for (let k = 0; k < 4; k++) { const phase = ((t * 0.45) + k / 4) % 1; const rr = baseR * (0.7 + phase * 1.7); cctx.globalAlpha = (1 - phase) * 0.55; cctx.strokeStyle = c3; cctx.lineWidth = Math.max(2, R * 0.022 * (0.6 + amp)); cctx.beginPath(); cctx.arc(cx, cy, rr, 0, 7); cctx.stroke(); }
  cctx.globalAlpha = 1; coreSphere(cx, cy, baseR * 0.82, c1, c3, amp);
}
function drawWave(cx, cy, R, amp, baseR, c1, c2, c3) {
  bgGlow(cx, cy, R, baseR, amp);
  const w = R * 1.7, n = 100; cctx.lineWidth = Math.max(2, R * 0.02); cctx.lineCap = 'round'; cctx.lineJoin = 'round';
  const g = cctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0); g.addColorStop(0, c1); g.addColorStop(0.5, c3); g.addColorStop(1, c1);
  for (let pass = 0; pass < 2; pass++) {
    cctx.globalAlpha = pass ? 0.25 : 1; cctx.strokeStyle = g; cctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = cx - w / 2 + (i / n) * w; const f = (mode === 'listening' && freq) ? (freq[i % freq.length] / 255 - 0.45) : Math.sin(i * 0.28 + t * 4) * 0.5; const env = Math.sin((i / n) * Math.PI); const y = cy + (pass ? -1 : 1) * f * env * R * 0.66 * (0.3 + amp * 1.5); i ? cctx.lineTo(x, y) : cctx.moveTo(x, y); }
    cctx.stroke();
  }
  cctx.globalAlpha = 1; cctx.fillStyle = c3; cctx.beginPath(); cctx.arc(cx, cy, R * 0.05 * (1 + amp), 0, 7); cctx.fill();
}
function drawBars(cx, cy, R, amp, baseR, c1, c2, c3) {
  bgGlow(cx, cy, R, baseR, amp);
  const N = 64, ring = baseR * 0.62;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2; const h = Math.max(0.05, (mode === 'listening' && freq) ? freq[i % freq.length] / 255 : 0.5 + 0.5 * Math.sin(t * 4 + i * 0.4) * (0.4 + 0.7 * amp));
    const inner = ring, outer = ring + h * R * 0.5 * (0.4 + amp);
    const x1 = cx + Math.cos(a) * inner, y1 = cy + Math.sin(a) * inner, x2 = cx + Math.cos(a) * outer, y2 = cy + Math.sin(a) * outer;
    const g = cctx.createLinearGradient(x1, y1, x2, y2); g.addColorStop(0, c1); g.addColorStop(1, c3);
    cctx.strokeStyle = g; cctx.lineWidth = Math.max(2, R * 0.024); cctx.lineCap = 'round';
    cctx.beginPath(); cctx.moveTo(x1, y1); cctx.lineTo(x2, y2); cctx.stroke();
  }
  cctx.fillStyle = TC.core; cctx.beginPath(); cctx.arc(cx, cy, ring * 0.9, 0, 7); cctx.fill();
  cctx.globalAlpha = 0.45 + 0.45 * amp; cctx.fillStyle = c3; cctx.beginPath(); cctx.arc(cx, cy, ring * 0.28, 0, 7); cctx.fill(); cctx.globalAlpha = 1;
}
const ORB = { halo: drawHalo, pulse: drawPulse, wave: drawWave, bars: drawBars };
function draw() {
  cctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2, [c1, c2, c3] = palette();
  const amp = reduce ? Math.min(level, 0.3) : level, baseR = R * 0.40 + R * 0.10 * amp;
  (ORB[orbStyle] || drawHalo)(cx, cy, R, amp, baseR, c1, c2, c3);
}
function tick() {
  t += 0.016;
  if (mode === 'listening' && freq) { let s = 0; for (let i = 0; i < freq.length; i++) s += freq[i]; targetLevel = Math.min(1, (s / freq.length) / 110); }
  else if (mode === 'speaking') targetLevel = 0.45 + 0.35 * Math.abs(Math.sin(t * 7)) + 0.18 * Math.abs(Math.sin(t * 13.3));
  else if (mode === 'thinking') targetLevel = 0.22 + 0.06 * Math.sin(t * 5);
  else targetLevel = 0.16 + 0.05 * Math.sin(t * 1.6);
  level += (targetLevel - level) * 0.18; draw(); requestAnimationFrame(tick);
}

function setStatus(s, err) { $('status').textContent = s; $('status').classList.toggle('err', !!err); }
function setMode(m) { mode = m; }

/* ===================== Markdown → safe HTML (reply bubble) ===================== */
// Escape-first mini renderer: bold/italic/code/links, headers, lists, tables, fences.
// Everything passes through esc() before any tag is emitted, so reply content can
// never inject markup. Bare URLs become a short "link" anchor — never shown raw.
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">link</a>');
}
function mdToHtml(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '', code = false, list = '', table = false;
  const closeAll = () => {
    if (list) { html += '</' + list + '>'; list = ''; }
    if (table) { html += '</table>'; table = false; }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { closeAll(); html += code ? '</pre>' : '<pre>'; code = !code; continue; }
    if (code) { html += esc(line) + '\n'; continue; }
    const t = line.trim();
    if (!t) { closeAll(); html += '<div class="md-gap"></div>'; continue; }
    if (/^\|.*\|$/.test(t)) {
      if (/^\|[\s:|-]+\|$/.test(t)) continue;
      if (!table) { closeAll(); html += '<table>'; table = true; }
      html += '<tr>' + t.slice(1, -1).split('|').map((c) => '<td>' + mdInline(c.trim()) + '</td>').join('') + '</tr>';
      continue;
    }
    if (table) { html += '</table>'; table = false; }
    const li = t.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const want = /^\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== want) { if (list) html += '</' + list + '>'; html += '<' + want + '>'; list = want; }
      html += '<li>' + mdInline(li[2]) + '</li>';
      continue;
    }
    if (list) { html += '</' + list + '>'; list = ''; }
    const h = t.match(/^#{1,4}\s+(.*)$/);
    if (h) { html += '<div class="md-h">' + mdInline(h[1]) + '</div>'; continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { html += '<hr>'; continue; }
    html += '<div>' + mdInline(t) + '</div>';
  }
  if (code) html += '</pre>';
  closeAll();
  return html;
}

/* ===================== Voice out (TTS) ===================== */
let voice = null, voiceList = [], voiceIdx = 0;
function shortVoice(v) { return v ? (v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*Online.*$/i, '').replace(/\(.*?\)/g, '').trim() || v.name) : 'Default'; }
function updateVoiceBtn() { if ($('voiceBtn')) $('voiceBtn').textContent = '🔊 ' + shortVoice(voice); }
function voiceScore(v) {
  const n = v.name;
  return (/natural/i.test(n) ? 100 : 0) + (/neural/i.test(n) ? 90 : 0)
    + (/aria|jenny|sonia|libby|emma/i.test(n) ? 50 : 0) + (/zira|hazel|susan/i.test(n) ? 30 : 0)
    + (/guy|ryan|david|mark/i.test(n) ? 15 : 0) + (v.localService ? 5 : 0);
}
function buildVoiceList() {
  if (!('speechSynthesis' in window)) { if ($('voiceBtn')) $('voiceBtn').style.display = 'none'; return; }
  const vs = speechSynthesis.getVoices(); if (!vs.length) return;
  const en = vs.filter((v) => /^en/i.test(v.lang));
  // Most natural voice first, so the default is the best this machine has.
  voiceList = (en.length ? en : vs).slice().sort((a, b) => voiceScore(b) - voiceScore(a));
  let i = voiceList.findIndex((v) => v.name === localStorage.getItem('oshalVoice')); if (i < 0) i = 0;
  voiceIdx = i; voice = voiceList[i] || null; updateVoiceBtn();
}
// What gets SPOKEN is not what gets SHOWN: strip code, tables, URLs and machine ids,
// then cap to a couple of sentences — nobody wants a UUID read out character by character.
function speechText(src) {
  let s = String(src || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`]*`/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, '');
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{4,}\b/gi, '');
  s = s.replace(/\b(?=[^\s]*\d)[A-Za-z0-9_/+=-]{16,}\b/g, '');
  s = s.replace(/[#*_~|>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 360) {
    const cut = s.slice(0, 360);
    const p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = p > 120 ? cut.slice(0, p + 1) : cut + '…';
  }
  return s;
}
function speak(text) {
  $('ai').innerHTML = mdToHtml(text);
  $('ai').classList.add('md');
  const spoken = ('speechSynthesis' in window) ? speechText(text) : '';
  if (!spoken) { setMode('idle'); setStatus('Tap the orb — your turn'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(spoken); if (voice) u.voice = voice; u.rate = 1.02;
  u.onstart = () => { setMode('speaking'); setStatus('Speaking…'); };
  u.onboundary = () => { level = Math.min(1, level + 0.25); };
  u.onend = () => { setMode('idle'); setStatus('Tap the orb — your turn'); };
  speechSynthesis.speak(u);
}

/* ===================== Mic analyser + STT ===================== */
let audioCtx, analyser, micStream;
async function startAnalyser() {
  if (analyser) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; src.connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
    (function pull() { if (analyser) { analyser.getByteFrequencyData(freq); requestAnimationFrame(pull); } })();
    return true;
  } catch (e) { return false; }
}
function releaseAnalyser() {
  try { if (micStream) micStream.getTracks().forEach((track) => track.stop()); } catch (e) {}
  try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch (e) {}
  micStream = null; analyser = null; audioCtx = null; freq = null;
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, wantListening = false, finalBuf = '';
if (SR) {
  rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalBuf += r[0].transcript + ' '; else interim += r[0].transcript; }
    $('you').innerHTML = '<b>You:</b> ' + esc((finalBuf + interim).trim()) + '<span style="opacity:.5"> ▍</span>';
  };
  rec.onerror = (e) => {
    if ((e.error === 'no-speech' || e.error === 'aborted') && wantListening) return;
    const blocked = e.error === 'not-allowed' || e.error === 'service-not-allowed';
    wantListening = false; listening = false; $('mic').classList.remove('live'); $('miclabel').textContent = 'Tap to talk'; if (mode === 'listening') setMode('idle');
    releaseAnalyser(); void oshal.setBackgroundMicOwner(false);
    setStatus(blocked ? 'Microphone blocked — allow access or use Type' : 'Didn’t catch that — try again', true);
  };
  rec.onend = () => { if (wantListening) { try { rec.start(); } catch (e) {} return; } listening = false; $('mic').classList.remove('live'); $('miclabel').textContent = 'Tap to talk'; if (mode === 'listening') setMode('idle'); };
}
async function startListening() {
  if (!SR) { $('typer').classList.add('show'); setStatus('Voice input isn’t supported here — type below'); return; }
  await oshal.setBackgroundMicOwner(true);
  speechSynthesis && speechSynthesis.cancel();
  finalBuf = ''; const ok = await startAnalyser();
  if (!ok) { await oshal.setBackgroundMicOwner(false); setStatus('Microphone blocked - allow access or use Type', true); return; }
  setStatus(ok ? 'Recording… tap Stop & send when done' : 'Recording… tap Stop & send');
  setMode('listening'); listening = true; wantListening = true; $('miclabel').textContent = 'Stop & send'; $('mic').classList.add('live');
  try { rec.start(); } catch (e) {}
}
function stopListening(send) {
  wantListening = false; listening = false;
  try { rec && rec.stop(); } catch (e) {}
  $('miclabel').textContent = 'Tap to talk'; $('mic').classList.remove('live');
  const text = finalBuf.trim();
  releaseAnalyser();
  void oshal.setBackgroundMicOwner(false);
  if (send && text) handleInput(text);
  else { if (mode === 'listening') setMode('idle'); if (send) setStatus('Didn’t catch anything — tap to try again', true); }
}
function toggleMic() { if (busy) return; listening ? stopListening(true) : startListening(); }

/* ===================== Chat over the swarm (IPC) ===================== */
async function handleInput(text) {
  if (busy || !text) return;
  $('you').innerHTML = '<b>You:</b> ' + esc(text);
  $('ai').className = 'ai'; $('ai').textContent = '';
  busy = true; setMode('thinking'); setStatus('Thinking…');
  try {
    await oshal.sendChat(text);
  } catch (e) {
    busy = false; setMode('idle'); setStatus(String(e && e.message ? e.message : e), true);
  }
}
function applyReply(reply) {
  busy = false;
  if (reply && reply.success && reply.text) speak(reply.text);
  else { setMode('idle'); setStatus((reply && reply.error) || 'The bot returned an empty reply.', true); }
}

/* ===================== Worker activity log ===================== */
function applyWorkerEvent(ev) {
  const log = $('worklog');
  if (log.querySelector('.muted')) log.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'work-row ' + ev.phase;
  const tag = ev.phase === 'claimed' ? '▶ running' : ev.phase === 'completed' ? '✓ done' : '✕ failed';
  row.innerHTML = '<span class="work-intent">' + esc(ev.intent) + '</span><span class="work-tag">' + tag + '</span>'
    + (ev.text ? '<div class="work-out">' + esc(ev.text.slice(0, 600)) + '</div>' : '')
    + (ev.error ? '<div class="work-err">' + esc(ev.error) + '</div>' : '');
  log.prepend(row);
}

/* ===================== Connection status ===================== */
function applyStatus(status) {
  const connected = Boolean(status && status.connected);
  $('statusDot').className = 'dot ' + (connected ? 'online' : 'offline');
  $('statusText').textContent = connected
    ? 'connected · ' + (status.agentId || 'bot')
    : (status && status.lastError ? 'disconnected · ' + status.lastError : 'disconnected');
}

function applyBackgroundWakeStatus(status) {
  if (!status) return;
  wakeStatus = status;
  const state = String(status.state || 'off');
  $('backgroundWakeEnabled').checked = Boolean(status.enabled);
  $('wakeState').textContent = state === 'listening'
    ? 'Background wake: ON - ' + (status.phrase || '')
    : state === 'paused' ? 'Background wake: PAUSED' : 'Background wake: ' + state.toUpperCase();
  $('wakeDetail').textContent = status.detail || '';
  $('wakeStateDot').className = 'wake-dot ' + state;
  $('wakePauseBtn').disabled = !status.enabled || state === 'unavailable' || state === 'error';
  $('wakePauseBtn').textContent = state === 'paused' ? 'Resume' : 'Pause';
}

async function changeBackgroundWake() {
  const enabled = $('backgroundWakeEnabled').checked;
  const name = $('wakeAssistantName').value.trim() || 'Jarvis';
  if (enabled) {
    setMsg('Requesting microphone permission...', '');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      $('backgroundWakeEnabled').checked = false;
      setMsg('Microphone permission was not granted. Background wake remains off.', 'err');
      return;
    }
  }
  const status = await oshal.setBackgroundWake(enabled, name);
  applyBackgroundWakeStatus(status);
  if (status.state === 'error' || status.state === 'unavailable') setMsg(status.detail, 'err');
  else setMsg(enabled ? 'Background wake word is on. You can close this window.' : 'Background wake word is off.', 'ok');
}

async function toggleBackgroundWakePause() {
  const status = await oshal.setBackgroundWakePaused(!(wakeStatus && wakeStatus.state === 'paused'));
  applyBackgroundWakeStatus(status);
}

/* ===================== Config screen ===================== */
function showSettings(show) {
  $('settings').classList.toggle('hidden', !show);
  $('orbView').classList.toggle('hidden', show);
  if (show) { refreshAccounts(); }
}
async function loadConfig() {
  const cfg = await oshal.getConfig();
  CONFIG_FIELDS.forEach((k) => { if ($(k)) $(k).value = cfg[k] || ''; });
  $('workerEnabled').checked = cfg.workerEnabled !== false;
  $('allowSystemControl').checked = cfg.allowSystemControl === true;
  $('fullJarvisEnabled').checked = cfg.fullJarvisEnabled === true;
  $('backgroundWakeEnabled').checked = cfg.backgroundWakeEnabled === true;
  $('wakeAssistantName').value = cfg.wakeAssistantName || 'Jarvis';
  $('workerPill').textContent = cfg.workerEnabled !== false ? 'worker on' : 'worker off';
  $('workerPill').className = 'worker-pill ' + (cfg.workerEnabled !== false ? 'on' : 'off');
  if (cfg.userEmail) $('identityMsg').textContent = 'Signed in as ' + cfg.userEmail;
  else if (cfg.userSub) $('identityMsg').textContent = 'Identity: ' + cfg.userSub;
  $('signOutBtn').disabled = !cfg.userSub;
  applyBackgroundWakeStatus(await oshal.getBackgroundWakeStatus());
  if (!cfg.controlPlaneUrl || !cfg.sharedSecret) showSettings(true);
}
async function saveSettings() {
  const update = {};
  CONFIG_FIELDS.forEach((k) => { if ($(k)) update[k] = $(k).value.trim(); });
  update.workerEnabled = $('workerEnabled').checked;
  update.allowSystemControl = $('allowSystemControl').checked;
  update.fullJarvisEnabled = $('fullJarvisEnabled').checked;
  await oshal.saveConfig(update);
  $('workerPill').textContent = update.workerEnabled ? 'worker on' : 'worker off';
  $('workerPill').className = 'worker-pill ' + (update.workerEnabled ? 'on' : 'off');
  setMsg('Saved.', 'ok');
}
function setMsg(text, kind) { $('settingsMsg').textContent = text; $('settingsMsg').className = ('msg ' + (kind || '')).trim(); }
async function connectVpn() { setMsg('Connecting VPN…', ''); await saveSettings(); const res = await oshal.connectVpn(); setMsg(res.message, res.ok ? 'ok' : 'err'); }
async function connect() {
  await saveSettings(); setMsg('Connecting…', '');
  const status = await oshal.connect(); applyStatus(status);
  if (status.connected) { setMsg('Connected.', 'ok'); showSettings(false); setStatus('Connected — tap the orb to talk'); }
  else setMsg(status.lastError || 'Connect failed.', 'err');
}

/* ===================== Local accounts ===================== */
async function refreshAccounts() {
  const accounts = await oshal.authStatus();
  $('accounts').innerHTML = accounts.map((a) =>
    '<div class="account">'
    + '<span class="acct-dot ' + (a.authed ? 'on' : 'off') + '"></span>'
    + '<span class="acct-label">' + esc(a.label) + '</span>'
    + '<span class="acct-state">' + (a.authed ? 'signed in' : 'not signed in') + '</span>'
    + '<button class="ghost-btn small" data-login="' + esc(a.id) + '">' + (a.authed ? 'Re-login' : 'Log in') + '</button>'
    + '</div>').join('');
  $('accounts').querySelectorAll('[data-login]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Opening…';
      const res = await oshal.authLogin(b.getAttribute('data-login'));
      setMsg(res.ok ? ('Launched: ' + res.command + ' — finish in the terminal/browser, then reopen Config.') : (res.error || 'Login failed.'), res.ok ? 'ok' : 'err');
      setTimeout(refreshAccounts, 1500);
    };
  });
}
async function signIn() {
  setMsg('Opening sign-in…', '');
  const res = await oshal.signIn();
  if (res.ok) { $('identityMsg').textContent = 'Signed in as ' + (res.email || res.sub); $('signOutBtn').disabled = false; setMsg('Signed in.', 'ok'); }
  else setMsg(res.error || 'Sign-in cancelled.', 'err');
}
async function signOut() {
  setMsg('Signing out and stopping background listening...', '');
  const res = await oshal.signOut();
  if (res.ok) {
    $('identityMsg').textContent = 'Not signed in.';
    $('signOutBtn').disabled = true;
    applyBackgroundWakeStatus(await oshal.getBackgroundWakeStatus());
    setMsg('Signed out. Background listening is off.', 'ok');
  } else setMsg(res.error || 'Sign-out failed.', 'err');
}
async function openJarvis() {
  setStatus('Opening full Jarvis…');
  const res = await oshal.openJarvis();
  setStatus(res.ok ? 'Full Jarvis open — this window stays as the node console' : (res.error || 'Could not open the cockpit.'));
}

/* ===================== Wiring ===================== */
function init() {
  sizeOrb(); tick();

  // Voice setup
  if ('speechSynthesis' in window) { buildVoiceList(); speechSynthesis.onvoiceschanged = buildVoiceList; }
  $('voiceBtn').addEventListener('click', () => {
    if (!voiceList.length) return;
    voiceIdx = (voiceIdx + 1) % voiceList.length; voice = voiceList[voiceIdx];
    try { localStorage.setItem('oshalVoice', voice.name); } catch (_) {}
    updateVoiceBtn();
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance("This is how I'll sound."); if (voice) u.voice = voice; speechSynthesis.speak(u); } catch (_) {}
  });

  // Orb style cycle
  const ORB_STYLES = [['halo', 'Halo'], ['pulse', 'Pulse'], ['wave', 'Wave'], ['bars', 'Bars']];
  const orbLabel = () => { const s = ORB_STYLES.find((x) => x[0] === orbStyle) || ORB_STYLES[0]; $('orbBtn').textContent = '◎ ' + s[1]; };
  orbLabel();
  $('orbBtn').addEventListener('click', () => { const i = ORB_STYLES.findIndex((x) => x[0] === orbStyle); orbStyle = ORB_STYLES[(i + 1) % ORB_STYLES.length][0]; try { localStorage.setItem('oshalOrb', orbStyle); } catch (_) {} orbLabel(); });

  // Controls
  $('mic').addEventListener('click', toggleMic);
  cvs.addEventListener('click', toggleMic);
  $('mute').addEventListener('click', () => { speechSynthesis && speechSynthesis.cancel(); stopListening(false); setMode('idle'); setStatus('Stopped. Tap the orb to talk'); });
  $('typeToggle').addEventListener('click', () => { $('typer').classList.toggle('show'); $('typein').focus(); });
  $('typer').addEventListener('submit', (e) => { e.preventDefault(); const v = $('typein').value.trim(); if (v) { handleInput(v); $('typein').value = ''; } });

  // Config screen
  $('settingsToggle').addEventListener('click', () => showSettings($('settings').classList.contains('hidden')));
  $('closeSettings').addEventListener('click', () => showSettings(false));
  $('saveBtn').addEventListener('click', saveSettings);
  $('vpnBtn').addEventListener('click', connectVpn);
  $('connectBtn').addEventListener('click', connect);
  $('signInBtn').addEventListener('click', signIn);
  $('signOutBtn').addEventListener('click', signOut);
  $('backgroundWakeEnabled').addEventListener('change', changeBackgroundWake);
  $('wakePauseBtn').addEventListener('click', toggleBackgroundWakePause);
  $('connectionsBtn').addEventListener('click', () => oshal.openConnections());
  $('jarvisBtn').addEventListener('click', openJarvis);
  $('winMin') && $('winMin').addEventListener('click', () => oshal.minimizeWindow());
  $('winClose') && $('winClose').addEventListener('click', () => oshal.closeWindow());

  // IPC streams
  oshal.onStatus(applyStatus);
  oshal.onReply(applyReply);
  oshal.onWorkerEvent(applyWorkerEvent);
  oshal.onBackgroundWakeStatus(applyBackgroundWakeStatus);

  loadConfig();
}

window.addEventListener('DOMContentLoaded', init);

})();
