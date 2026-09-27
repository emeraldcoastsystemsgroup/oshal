/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Central assistant shell over the real Jarvis: the intent composer posts to /api/jarvis/ask on the shared browser thread, the ledger and workspace follow the actual job phases (sent, accepted, answered or failed), handoffs open real applications, the shelf lists the caller's Jarvis tasks, and the speaking core moves with the swarm voice route's playback amplitude (or labelled lifecycle pulses when only the browser engine is available). The scripted Vegas journey, fixture fares and prerecorded readback are gone.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Gap closure over existing contracts (ADR-164 D8, no backend change). The workspace renders the typed fields of the done /ask/result payload: the escaped answer, the owner-checked /api/jarvis/visuals image labelled by its kind, '/'-only handoff chips, the handed-off `dispatched` work tracked on GET /api/jarvis/tasks until it settles (files offered, delivered marked once through the route, the linked ticket cancellable through the owner-checked PUT /api/tickets/:ticketId/cancel with refusals shown), a `packageToolProposal` as an approval card pointing at the Jarvis page where approval happens, and `brainFallback` as "Answered by <provider>". Lifecycle is running / ready / partial / failed / setup-needed (job code NO_HOSTED_BRAIN or the 503 ai_disabled refusal) / stopped waiting, never "cancelled". The ledger is "Request progress": observed phases only, never tool activity. A per-request generation token plus an AbortController through LIVE.ask end the wait on Stop, New and Home and release the composer; a late completion of an older request can never reopen or overwrite the workspace. Push-to-talk dictation records with MediaRecorder, posts field `audio` to /api/voice/transcribe and fills the composer without sending, with honest not-set-up / denied / failed states; the microphone never drives the core. The readback control is offered on every terminal text (ready, partial, failed, setup-needed), and the composer keeps its draft and focus across repaints.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Hand-off links accept only same-origin paths (a protocol-relative '//host' target is shown by name, never linked), and a transcription failure the route reports with HTTP 200 no longer quotes that success status
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Integration review: hand-off links go through the shared LIVE.localHref guard (isLocalPath is gone), so a tab-split or backslash target that the browser would resolve off this origin is shown by name, never linked. Reaching the ask poll limit (code 'poll_limit') is a "Still running" state that says this page stopped checking and the job may still finish, never FAILED. The page no longer marks handed-off results delivered: the Jarvis page stays the one surface that announces and marks them. Request progress is honest about a stop before the swarm answered the send (never "Not accepted") and counts checks as checks without an outcome.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, esc = S.esc;
  const root = document.getElementById('nexus-root');
  const btn = (label, action, cls = 'secondary', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
  const link = (label, href, cls = 'secondary') => `<a class="${cls}" href="${esc(href)}">${label}</a>`;
  let snapshot, shell, thread;
  const freshObs = () => ({ sentAt: null, rolled: false, jobId: '', refused: 0, polls: 0 });
  const state = { name: LIVE.prefs.get('nexus:name', 'Jarvis'), phase: 'idle', resume: '', busy: false, draft: '', query: '', view: 'summary', jobId: '', result: null, error: '', code: '', obs: freshObs(), work: [], workNote: '', motion: !matchMedia('(prefers-reduced-motion: reduce)').matches };
  const voice = { active: false, level: 0, mode: '', controller: null, text: '' };
  const mic = { state: 'idle', recorder: null, stream: null, chunks: [], note: '', kind: '' };
  let animation, observer, noticeTimer, activeModal = null, previousFocus;
  /* Stale-completion guard: every wait belongs to one generation; Stop, New and Home move the generation on and abort the wait. */
  let generation = 0, pending = null;
  const TERMINAL = { ready: true, partial: true, failed: true, setup: true, unsettled: true };
  const PHASES = {
    running: { mode: 'WORKING', label: 'BRINGING IT TOGETHER', sr: 'Request running' },
    ready: { mode: 'LIVE ANSWER', label: 'HERE WHEN YOU NEED ME', sr: 'Answer ready' },
    partial: { mode: 'ANSWER READY · WORK CONTINUING', label: 'BACKGROUND WORK CONTINUING', sr: 'Answer ready, background work still running' },
    failed: { mode: 'FAILED', label: 'THAT DID NOT WORK', sr: 'Request failed' },
    setup: { mode: 'SETUP NEEDED', label: 'SETUP NEEDED', sr: 'Setup needed before Jarvis can answer' },
    stopped: { mode: 'STOPPED WAITING', label: 'STOPPED WAITING', sr: 'Stopped waiting' },
    unsettled: { mode: 'STILL RUNNING · STOPPED CHECKING', label: 'STILL RUNNING · CHECK JARVIS LATER', sr: 'Still running; this page stopped checking' }
  };
  const UNSETTLED_TEXT = 'This page stopped checking for the answer. The job may still finish: its answer is saved to this conversation, so check Jarvis later.';
  const RESUME_LABELS = { stopped: 'Back to the stopped request', unsettled: 'Back to the request still running' };
  const TASK_POLL_MS = 3000, TASK_POLL_LIMIT = 200;
  const VISUAL_KINDS = ['weather', 'priority-email', 'table', 'chart', 'summary', 'timeline', 'diagram', 'gallery', 'map', 'gauge', 'checklist', 'agenda', 'comparison', 'profile', 'image'];
  const VISUAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  root.innerHTML = '<div class="nexus"><main class="nexus-main"><section class="welcome"><div class="eyebrow">CONNECTING TO YOUR SWARM</div><h1>One moment.</h1></section></main></div>';
  LIVE.ready.then(boot).catch(err => { root.innerHTML = `<div class="nexus"><main class="nexus-main"><section class="welcome"><h1>The assistant could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></section></main></div>`; });

  async function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="nexus"><main class="nexus-main"><section class="welcome"><h1>Sign in to talk to your swarm.</h1><p>${link('Sign in', '/login', 'primary')}</p></section></main></div>`; return; }
    shell = S.createShell({ snapshot, layoutId: 'nexus', hooks: {} });
    thread = shell.createThread(LIVE.sessionId(), state.name);
    bind(); render();
    const loadingThread = thread;
    await thread.load();
    // A history read that lands after the user already asked (or started over) must not replace the newer workspace.
    if (thread !== loadingThread || state.busy || state.resume || state.phase !== 'idle') return;
    const last = lastExchange();
    if (last) { state.query = last.user; state.result = { status: 'done', answer: last.answer.text, handoffs: last.answer.handoffs || [], files: last.answer.files || [], dispatched: [] }; state.resume = 'ready'; }
    render();
  }
  function lastExchange() {
    const turns = thread.turns; for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'jarvis' && !turns[i].pending && !turns[i].error) { const user = turns.slice(0, i).reverse().find(t => t.role === 'user'); return { user: user ? user.text : '', answer: turns[i] }; } }
    return null;
  }
  const firstName = () => snapshot.me.name.split(/[\s.@_-]+/)[0] || snapshot.me.name;
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'; };
  const tasks = () => snapshot.work.filter(w => w.kind === 'task');
  function notify(text) { clearTimeout(noticeTimer); const n = document.getElementById('notice'); if (n) { n.textContent = text; noticeTimer = setTimeout(() => { const m = document.getElementById('notice'); if (m) m.textContent = ''; }, 4500); } }

  /* ── voice ───────────────────────────────────────────────────── */
  const shownPhase = () => state.phase === 'idle' ? state.resume : state.phase;
  /** Terminal text the readback may speak: the answer when one arrived, the refusal or setup sentence otherwise. */
  function readbackText() {
    const p = shownPhase(); if (!TERMINAL[p]) return '';
    if (p === 'unsettled') return UNSETTLED_TEXT;
    return p === 'failed' || p === 'setup' ? state.error : (state.result && state.result.answer) || '';
  }
  function speakAnswer() {
    const text = readbackText();
    if (!text) { notify('There is no answer to speak yet.'); return; }
    stopVoice();
    voice.text = text; voice.active = true; voice.level = 0; voice.mode = 'starting'; paintVoice();
    voice.controller = LIVE.speak(text, {
      onStart: mode => { voice.mode = mode; paintVoice(); },
      onLevel: level => { voice.level = level; },
      onEnd: () => { voice.active = false; voice.level = 0; voice.controller = null; paintVoice(); }
    });
  }
  function stopVoice() { if (voice.controller) voice.controller.stop(); voice.active = false; voice.level = 0; voice.controller = null; paintVoice(); }
  function voiceStatus() { return !voice.active ? 'SWARM VOICE · PRESS PLAY TO HEAR THE ANSWER' : voice.mode === 'amplitude' ? 'SWARM VOICE · CORE FOLLOWS PLAYBACK AMPLITUDE' : voice.mode === 'lifecycle' ? 'BROWSER VOICE · LIFECYCLE ANIMATION ONLY' : voice.mode === 'unavailable' ? 'NO VOICE ENGINE AVAILABLE · SHOWING TEXT' : 'STARTING VOICE…'; }
  function paintVoice() { const box = root.querySelector('.readback'); if (!box) return; box.dataset.state = voice.active ? 'playing' : 'idle'; const s = box.querySelector('.readback-status'); if (s) s.textContent = voiceStatus(); const b = box.querySelector('.readback-button'); if (b) { b.textContent = voice.active ? '■ Stop' : '▶ Speak the answer'; b.setAttribute('aria-pressed', String(voice.active)); } }
  function voiceControls() {
    const text = readbackText(); if (!text) return '';
    const source = state.result && state.result.status === 'done' ? 'The text Jarvis returned for this request.' : 'The message this page shows for the request’s outcome.';
    return `<div class="readback" data-state="${voice.active ? 'playing' : 'idle'}" data-reduced="${!state.motion}"><div class="readback-controls">${btn(voice.active ? '■ Stop' : '▶ Speak the answer', 'readback', 'readback-button', `aria-pressed="${voice.active}"`)}<span class="voice-bars" aria-hidden="true">${[.32, .65, 1, .55, .85, .44, .72].map(h => `<i style="--bar-height:${h}"></i>`).join('')}</span></div><div class="readback-status" role="status" aria-live="polite">${esc(voiceStatus())}</div><details><summary>Transcript</summary><p>${esc(text)}</p><small>${source} Speech uses the swarm voice route, falling back to your browser’s engine.</small></details></div>`;
  }

  /* ── voice input (push-to-talk dictation; never a visualization signal, ADR-164 D8) ── */
  const micSupported = () => Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' && typeof window.MediaRecorder === 'function');
  function micNote(kind, note) { mic.kind = kind; mic.note = note; paintComposerVoice(); }
  function releaseMic() { if (mic.stream) { try { mic.stream.getTracks().forEach(t => t.stop()); } catch (_) { /* already released */ } } mic.stream = null; }
  async function startRecording() {
    if (mic.state !== 'idle' || state.busy) return;
    try { mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      return micNote(denied ? 'denied' : 'failed', denied ? 'Microphone access was denied. Keep typing, or allow the microphone for this page in your browser.' : 'The microphone could not start. Keep typing.');
    }
    try { mic.recorder = new MediaRecorder(mic.stream); }
    catch (_) { releaseMic(); return micNote('failed', 'This browser could not record audio. Keep typing.'); }
    mic.chunks = [];
    mic.recorder.ondataavailable = e => { if (e.data && e.data.size) mic.chunks.push(e.data); };
    mic.recorder.onstop = () => { finishRecording(); };
    mic.recorder.start(); mic.state = 'recording';
    micNote('recording', 'Recording. Press Stop when you are done; the words land in the box for you to check before sending.');
  }
  function stopRecording() { if (mic.state === 'recording' && mic.recorder) { mic.state = 'transcribing'; try { mic.recorder.stop(); } catch (_) { finishRecording(); } } }
  const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav' };
  async function finishRecording() {
    // The route validates the exact base MIME type, so the codec suffix a recorder reports (audio/webm;codecs=opus) is dropped.
    const type = String((mic.recorder && mic.recorder.mimeType) || '').split(';')[0].trim() || 'audio/webm';
    const blob = new Blob(mic.chunks, { type }); releaseMic(); mic.recorder = null; mic.chunks = [];
    if (!blob.size) { mic.state = 'idle'; return micNote('empty', 'No audio was captured. Try again, or keep typing.'); }
    mic.state = 'transcribing'; micNote('transcribing', 'Transcribing on the swarm…');
    const r = await LIVE.transcribe(blob, { filename: `speech.${AUDIO_EXT[type] || 'webm'}` });
    mic.state = 'idle';
    if (r.outcome === 'text') { fillDraft(r.text); return micNote('ready', 'Transcribed. Check the words, then send when you are ready.'); }
    micNote(r.outcome === 'unconfigured' ? 'unconfigured' : r.outcome === 'empty' ? 'empty' : 'failed', transcribeMessage(r));
  }
  function transcribeMessage(r) {
    if (r.outcome === 'unconfigured') return r.fallback === 'browser' ? 'Server transcription is not set up here: this deployment is set to in-browser recognition, which this page does not use. Keep typing.' : 'Server transcription is not set up on this deployment. Keep typing.';
    if (r.outcome === 'empty') return 'No words were recognised in that recording. Try again, or keep typing.';
    return r.status === 401 ? 'Transcription failed: your session has expired. Sign in again, or keep typing.' : `Transcription failed${r.status && r.status !== 200 ? ` (HTTP ${r.status})` : ''}. Keep typing.`;
  }
  function fillDraft(text) {
    state.draft = state.draft.trim() ? `${state.draft.trim()} ${text}` : text;
    const input = document.getElementById('intent-input');
    if (input) { input.value = state.draft; input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* not a text control */ } }
  }
  function micButton() {
    if (!micSupported()) return '';
    const recording = mic.state === 'recording', busy = mic.state === 'transcribing';
    return btn(recording ? '■ Stop' : busy ? '… Transcribing' : '● Talk', 'mic', 'mic-button', `aria-pressed="${recording}" aria-label="${recording ? 'Stop recording and transcribe' : 'Push to talk: dictate your request'}"${busy || (state.busy && !recording) ? ' disabled' : ''}`);
  }
  const micStatus = () => `<p class="mic-status" role="status" aria-live="polite" data-kind="${esc(mic.kind)}">${esc(mic.note)}</p>`;
  function paintComposerVoice() {
    root.querySelectorAll('.mic-button').forEach(b => { b.outerHTML = micButton(); });
    root.querySelectorAll('.mic-status').forEach(p => { p.outerHTML = micStatus(); });
  }

  /* ── views ───────────────────────────────────────────────────── */
  function composer(compact = false) {
    return `<div class="composer-wrap"><form id="intent-form" class="composer"><label class="sr-only" for="intent-input">Ask your assistant</label><textarea id="intent-input" rows="2" maxlength="1200" placeholder="Tell me what you have in mind…"${state.busy ? ' disabled' : ''}>${esc(state.draft)}</textarea><div class="composer-controls"><div class="context-label"><span>Personal space</span><span>${snapshot.apps.length} applications · ${shell.openWork().length} open</span></div><div class="composer-actions">${micButton()}<button class="send-button" type="submit" aria-label="Send to Jarvis"${state.busy ? ' disabled' : ''}>↑</button></div></div></form>${micStatus()}<p class="composer-note">${compact ? 'Ask a follow-up. It continues the same thread.' : 'Your intent, not a list of apps. Answered by your own Jarvis with the swarm’s tools.'}</p></div>`;
  }
  function rail() {
    return `<aside class="rail"><a href="/portal" class="rail-logo" aria-label="All experiences">${esc(state.name.slice(0, 1).toLowerCase())}</a><nav class="rail-nav" aria-label="Assistant navigation">${btn('<span class="rail-symbol" aria-hidden="true">◎</span>Assistant', 'home', `rail-button${state.phase === 'idle' ? ' active' : ''}`)}${btn('<span class="rail-symbol" aria-hidden="true">＋</span>New', 'new', 'rail-button')}${btn('<span class="rail-symbol" aria-hidden="true">◇</span>Shelf', 'saved', 'rail-button')}${btn('<span class="rail-symbol" aria-hidden="true">⠿</span>Swarm', 'swarm', 'rail-button')}</nav><div class="rail-bottom">${btn('⌘', 'settings', 'icon-button', 'aria-label="Preferences"')}<span class="profile" aria-label="${esc(snapshot.me.name)}">${esc(snapshot.me.initials)}</span></div></aside>`;
  }
  function suggestions() {
    const latest = snapshot.work[0];
    return `<div class="suggestions">${btn('What needs my attention today?', 'prompt', 'suggestion', 'data-prompt="What needs my attention today across my swarm? List what is waiting on me first."')}${latest ? btn(`Tell me about “${esc(latest.title.slice(0, 40))}${latest.title.length > 40 ? '…' : ''}”`, 'prompt', 'suggestion', `data-prompt="${esc(`Tell me about ${latest.kind === 'task' ? 'the task' : 'the ticket'} “${latest.title}” and what I should do next.`)}"`) : ''}${btn('What can my swarm do for me?', 'prompt', 'suggestion', 'data-prompt="Which applications do I have and what can each of them do for me? Keep it short."')}${state.resume ? btn(RESUME_LABELS[state.resume] || 'Resume the last answer', 'result', 'suggestion') : ''}</div>`;
  }
  function welcome() {
    return `<section class="welcome"><div class="presence"><canvas id="core-canvas" role="img" aria-label="Luminous particle core: the assistant’s presence, moving with its voice"></canvas></div><div class="orb-caption">YOUR WORLD. CONNECTED.</div>${voiceControls()}<div class="eyebrow">${greeting()}, ${esc(firstName().toUpperCase())} / ${snapshot.apps.length} APPS · ${shell.openWork().length} OPEN · ${snapshot.botsOnline} ASSISTANTS ONLINE</div><h1>A little ambition.<br><em>A whole swarm behind you.</em></h1><p>Tell me what you want to do. I’ll bring the right tools to you.</p>${composer()}${suggestions()}<div class="welcome-bottom">${snapshot.suites.slice(0, 3).map(s => `<div class="connected-item"><strong><span class="status-dot"></span>${esc(s.name)}</strong><small>${s.count} application${s.count === 1 ? '' : 's'}</small></div>`).join('')}</div></section>`;
  }
  /* ── request progress: what this page observed, never the tools Jarvis used ── */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const stage = () => state.obs.jobId ? (state.obs.polls ? 2 : 1) : 0;
  const settledItem = w => w.status === 'done' || w.status === 'error';
  const WORK_LABELS = { pending: 'Queued', queued: 'Queued', running: 'Working', summarizing: 'Reading the results', done: 'Finished', error: 'Did not finish' };
  const workLabel = w => w.status === 'unlisted' ? 'Not on your task list yet' : WORK_LABELS[w.status] || w.status;
  function progressRow(name, detail, mark) {
    const symbol = { done: '✓', now: '◌', failed: '×', pending: '·' }[mark];
    return `<div class="ledger-step${mark === 'pending' ? ' pending' : ''}" data-mark="${mark}"><span class="step-state" aria-hidden="true">${symbol}</span><div><strong>${esc(name)}${mark === 'now' ? ' · now' : ''}</strong><small>${esc(detail)}</small></div></div>`;
  }
  function askRows(p) {
    const o = state.obs, running = p === 'running';
    const sent = o.sentAt ? `Left this page at ${LIVE.clockTime(o.sentAt)} on your own thread${o.rolled ? ' (the earlier thread was unavailable under this sign-in, so a fresh one was used)' : ''}.` : 'Not sent.';
    const accepted = o.jobId ? `Job ${o.jobId.slice(0, 8)} accepted.` : o.refused ? `Refused with HTTP ${o.refused}.` : running ? 'Waiting for the swarm to accept it.'
      : p === 'stopped' ? 'This page stopped waiting before the swarm’s reply to the send arrived.' : 'Not accepted.';
    const polled = o.polls ? `Checked ${plural(o.polls, 'time')} without an outcome.` : o.jobId ? 'The first check already had the outcome.' : 'Not started.';
    return [progressRow('Sent to Jarvis', sent, o.sentAt ? 'done' : 'pending'),
      progressRow('Accepted by the swarm', accepted, o.jobId ? 'done' : o.refused ? 'failed' : running ? 'now' : 'pending'),
      progressRow('Checking for the answer', polled, running && o.jobId ? 'now' : o.jobId ? 'done' : 'pending')];
  }
  function outcomeRow(p) {
    const r = state.result || {}, visual = trustedVisual(r.visual);
    if (p === 'ready' || p === 'partial') return progressRow('Answer assembled', `Answer received${visual ? `, with a visual (${visualKindLabel(visual.kind)})` : ''}${state.work.length ? `, and ${plural(state.work.length, 'background item')} handed off` : ''}.`, 'done');
    if (p === 'failed') return progressRow('Request failed', state.error, 'failed');
    if (p === 'setup') return progressRow('Setup needed', state.error, 'failed');
    if (p === 'stopped') return progressRow('Stopped waiting', 'This page stopped checking. Nothing was cancelled on the swarm.', 'failed');
    if (p === 'unsettled') return progressRow('Still running', 'This page stopped checking; the job may still finish. Check Jarvis later.', 'pending');
    return progressRow('Answer assembled', 'Tool-using answers can take a minute.', 'pending');
  }
  function ledger() {
    const p = shownPhase(), r = state.result || {}, handoffs = (r.handoffs || []).filter(h => h && h.name), used = r.brainFallback && r.brainFallback.providerUsed;
    const rows = askRows(p).concat(outcomeRow(p), state.work.map(w => progressRow(`Background work · ${w.title}`, workLabel(w) + (w.cancel === 'cancelled' ? ' · cancel accepted' : ''), settledItem(w) ? (w.status === 'error' ? 'failed' : 'done') : 'now')));
    if (handoffs.length) rows.push(progressRow('Handoffs', `${plural(handoffs.length, 'application handoff')}: ${handoffs.map(h => h.name).join(', ')}.`, 'done'));
    if (used) rows.push(progressRow('Provider', `Answered by ${used} (fallback).`, 'done'));
    return `<div class="action-ledger" aria-label="Request progress"><div class="ledger-head"><strong>Request progress</strong><small>What this page observed about your request. It is not a record of the tools Jarvis used.</small></div>${rows.join('')}</div>`;
  }
  function assistantReply() {
    const p = state.phase;
    if (p === 'stopped') return '<p>Stopped waiting. Nothing was cancelled on the swarm; if it finishes, the answer is saved to this conversation, which the Jarvis page shows.</p>';
    if (p === 'failed' || p === 'setup') return `<p class="tone-warn">${esc(state.error)}</p>`;
    if (p === 'unsettled') return `<p>Still running. ${esc(UNSETTLED_TEXT)}</p>`;
    if (p !== 'ready' && p !== 'partial') return `<p>${stage() === 0 ? 'Sending your request on your own Jarvis thread.' : 'The swarm accepted it and is working. You can watch the workspace take shape.'}</p>`;
    return S.answerHtml(state.result.answer);
  }
  function handoffApps() {
    const chips = (state.result && state.result.handoffs) || [];
    const named = snapshot.apps.filter(a => state.result && state.result.answer && new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(state.result.answer));
    return { chips, named: named.filter(a => !chips.some(c => c && typeof c.deepLink === 'string' && c.deepLink.includes(`app=${a.id}`))).slice(0, 6) };
  }
  /* ── typed result cards: only the fields the done /ask/result payload and GET /api/jarvis/tasks already return ── */
  function trustedVisual(v) {
    if (!v || v.type !== 'image' || v.mimeType !== 'image/svg+xml' || !VISUAL_KINDS.includes(v.kind) || typeof v.artifactId !== 'string' || !VISUAL_ID.test(v.artifactId)) return null;
    if (v.url !== `/api/jarvis/visuals/${v.artifactId}` || typeof v.alt !== 'string' || !v.alt.trim()) return null;
    const dim = n => Number.isInteger(n) && n > 0 && n <= 16384 ? n : 0;
    return { url: v.url, alt: v.alt.trim().slice(0, 420), kind: v.kind, width: dim(v.width), height: dim(v.height) };
  }
  const visualKindLabel = kind => { const k = String(kind).replace(/-/g, ' '); return k.charAt(0).toUpperCase() + k.slice(1); };
  function visualCard(v) {
    const t = trustedVisual(v); if (!t) return '';
    return `<figure class="result-visual" data-kind="${esc(t.kind)}"><img src="${esc(t.url)}" alt="${esc(t.alt)}"${t.width ? ` width="${t.width}" height="${t.height}"` : ''} decoding="async"><figcaption><span class="source-label">VISUAL · ${esc(visualKindLabel(t.kind).toUpperCase())}</span> An image the swarm rendered for this answer. The text answer stays the answer of record.</figcaption></figure>`;
  }
  function providerNote(r) {
    const m = r.brainFallback; if (!m || typeof m.providerUsed !== 'string' || !m.providerUsed) return '';
    const failed = [m.failedEndpoint && m.failedEndpoint.host, m.failedEndpoint && m.failedEndpoint.model].filter(Boolean).join(' / ') || 'your selected endpoint';
    return `<p class="result-note provider-note" data-part="provider">Answered by ${esc(m.providerUsed)}. ${esc(failed)} was unavailable${m.failure ? ` (${esc(m.failure)})` : ''}, so a fallback answered.</p>`;
  }
  function proposalCard(p) {
    if (!p || typeof p.label !== 'string' || typeof p.app !== 'string' || typeof p.toolName !== 'string') return '';
    const ask = p.mode === 'ask', expires = LIVE.parseDate(p.expiresAt), app = shell.byId(p.app);
    const how = ask ? 'Nothing has run. Approval happens on the Jarvis page: it lists this tool’s inputs with an Approve button when the request is asked there. This page cannot approve or run application tools.'
      : 'Nothing has run here. The Jarvis page runs read tools like this when the request is asked there; this page does not run application tools.';
    return `<div class="result-card approval-card" data-part="proposal" data-mode="${ask ? 'ask' : 'auto'}"><span class="source-label">${ask ? 'APPROVAL NEEDED' : 'READ TOOL PROPOSED'}</span><h3>${esc(p.label)}</h3><p>${esc(app ? app.name : p.app)} · tool <code>${esc(p.toolName)}</code>${expires ? ` · offer expires ${esc(LIVE.clockTime(expires))}` : ''}</p><p>${how}</p><div class="work-actions">${link('Open the Jarvis page ↗', '/api/jarvis/', 'secondary')}</div></div>`;
  }
  function workItem(w) {
    const settled = settledItem(w), requesting = w.cancel === 'requesting';
    const cancel = settled || w.cancel === 'cancelled' ? '' : w.ticketId ? btn(requesting ? 'Cancelling…' : 'Cancel this work', 'cancel-work', 'secondary', `data-job="${esc(w.workJobId)}"${requesting ? ' disabled' : ''}`) : '<small>No ticket is linked to this item yet, so it cannot be cancelled from here.</small>';
    const detail = w.error ? `<small class="tone-warn">${esc(w.error)}</small>` : settled && w.result ? `<small>${esc(w.result.slice(0, 220))}${w.result.length > 220 ? '…' : ''}</small>` : '';
    return `<div class="work-item" data-work="${esc(w.workJobId)}" data-status="${esc(w.status)}"><strong>${esc(w.title)}</strong><small>${esc(workLabel(w))}</small>${detail}${w.files.map(f => S.fileLink(f)).filter(Boolean).join('')}${cancel}${w.cancelNote ? `<small role="status">${esc(w.cancelNote)}</small>` : ''}</div>`;
  }
  function workCard() {
    if (!state.work.length) return '';
    const done = state.work.filter(settledItem).length;
    return `<div class="result-card work-card" data-part="work"><div class="section-head"><h3>Background work</h3><span>${done} of ${state.work.length} finished · read from your Jarvis task list</span></div>${state.work.map(workItem).join('')}${state.workNote ? `<p class="result-note">${esc(state.workNote)}</p>` : ''}</div>`;
  }
  function overviewBody() {
    const r = state.result, { chips, named } = handoffApps(), routed = chips.map(c => ({ name: c && c.name, href: c ? LIVE.localHref(c.deepLink) : '' })).filter(c => c.href);
    return `<div class="section-head"><h3>The answer</h3>${btn('Speak it', 'readback', 'quiet')}</div>${S.answerHtml(r.answer)}${providerNote(r)}${visualCard(r.visual)}${proposalCard(r.packageToolProposal)}${workCard()}${routed.length ? `<h3>Open where the work lives</h3><div class="work-actions">${routed.map(c => link(`Open ${esc(c.name)} ↗`, c.href, 'primary')).join('')}</div>` : ''}${named.length ? `<h3>Applications mentioned</h3><div class="work-actions">${named.map(a => a.navigable ? link(`${esc(a.name)} ↗`, a.href, 'secondary') : `<span class="secondary">${esc(a.name)}</span>`).join('')}</div>` : ''}${(r.files || []).length ? `<h3>Files</h3>${r.files.map(f => `<p>${S.fileLink(f) || esc(f.name || 'file')}</p>`).join('')}` : ''}<div class="work-actions">${link('Continue in Jarvis ↗', '/api/jarvis/', 'secondary')}${btn('View sources', 'sources-tab', 'quiet')}</div>`;
  }
  function shelfBody() {
    const list = tasks().slice(0, 12);
    return `<div class="eyebrow">YOUR JARVIS SHELF</div><h2 style="font-size:26px;font-weight:400;margin-top:10px">What the swarm has done for you.</h2><p class="workspace-subtitle">${list.length ? `${tasks().length} tasks recorded, newest first.` : 'No tasks yet. Hand something off and it appears here.'}</p>${list.map(t => `<div class="shortlist-item"><strong>${esc(t.title)}</strong><small>${esc(t.status.label)} · ${esc(LIVE.relativeTime(t.at))}${t.typeLabel === 'swarm task' ? ' · swarm task' : ''}</small>${t.result ? `<small>${esc(t.result.slice(0, 140))}${t.result.length > 140 ? '…' : ''}</small>` : t.error ? `<small>${esc(t.error.slice(0, 140))}</small>` : ''}${link('Open ↗', t.href, 'quiet')}</div>`).join('')}`;
  }
  function sourcesBody() {
    const r = state.result || {};
    return `<div class="eyebrow">WHAT THIS ANSWER USES</div><h2 style="font-size:25px;font-weight:400;margin-top:12px">A clear trail back to the source.</h2><div class="source-row"><span class="source-label">LIVE / YOUR THREAD</span><h3>Conversation</h3><p>Thread <code>${esc(thread.sessionId)}</code>, the same one the cockpit’s Jarvis page uses. ${state.jobId ? `Job <code>${esc(state.jobId)}</code>.` : ''} ${r.taskId ? `Task <code>${esc(r.taskId)}</code>.` : ''}</p></div><div class="source-row"><span class="source-label">LIVE / ACCOUNTABLE ASSISTANT</span><h3>Execution</h3><p>The answer was produced by the Jarvis bot with the swarm’s tools under your identity. Per-tool activity is not part of the result contract this page reads, so it is not shown; the Jarvis page keeps the full conversation.</p></div><div class="source-row"><span class="source-label">${(r.handoffs || []).length ? 'LIVE / HANDOFFS' : 'NONE'}</span><h3>Application handoffs</h3><p>${(r.handoffs || []).length ? r.handoffs.map(h => esc(h.name)).join(', ') : 'No application handoff was returned for this request.'}</p></div><div class="source-row"><h3>Control stays with you</h3><p>Opening an application is separate from saving, sending, booking or scheduling anything inside it. Nothing here performs those actions.</p></div>`;
  }
  function appsBody() {
    const { chips, named } = handoffApps();
    const rows = chips.filter(Boolean).map(c => ({ name: c.name, href: LIVE.localHref(c.deepLink), note: 'Suggested by Jarvis for this request' })).concat(named.map(a => ({ name: a.name, href: a.navigable ? a.href : '', note: `${shell.suiteOf(a.suite).name} · mentioned in the answer` })));
    return `<div class="eyebrow">APPLICATIONS FOR THIS REQUEST</div><h2 style="font-size:25px;font-weight:400;margin-top:12px">${rows.length ? 'Where this can continue.' : 'No application was singled out.'}</h2>${rows.map(r => `<div class="source-row"><h3>${esc(r.name)}</h3><p>${esc(r.note)}</p>${r.href ? link('Open ↗', r.href, 'primary') : '<span class="secondary">Not available in your workspace</span>'}</div>`).join('') || '<p class="workspace-subtitle">Ask something that points at an application, or browse your swarm from the rail.</p>'}`;
  }
  function terminalBody(p) {
    if (p === 'setup') return `<div class="eyebrow">SETUP NEEDED</div><h2>Jarvis needs setup before it can answer.</h2><p>${esc(state.error)}</p><div class="work-actions">${link('Open the cockpit ↗', '/cockpit/', 'secondary')}${btn('Ask again', 'retry', 'quiet')}</div>`;
    if (p === 'failed') return `<div class="eyebrow">FAILED</div><h2>That did not work.</h2><p>${esc(state.error)}</p>${btn('Ask again', 'retry', 'quiet')}`;
    if (p === 'unsettled') return `<div class="eyebrow">STILL RUNNING · THIS PAGE STOPPED CHECKING</div><h2>Still running.</h2><p>${esc(UNSETTLED_TEXT)}</p><div class="work-actions">${link('Check the Jarvis page ↗', '/api/jarvis/', 'secondary')}</div>`;
    return `<div class="eyebrow">STOPPED WAITING</div><h2>You stopped waiting.</h2><p>This page stopped checking for the answer. Nothing was cancelled on the swarm: if it finishes, the answer is saved to this conversation, which the Jarvis page shows.</p>${btn('Ask again', 'retry', 'quiet')}`;
  }
  function loadingBody() {
    const s = stage();
    return `<div class="eyebrow">WORKSPACE TAKING SHAPE</div><h2 id="run-stage">${['Sending your request.', 'The swarm is working.', 'Still working on it.'][s]}</h2><p>The workspace forms around the answer: applications to open, files that were produced, and the trail back to the source.</p><div class="run-progress" role="progressbar" aria-label="Request stages" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${s + 1}"><span style="width:${(s + 1) / 3 * 100}%"></span></div><div class="loading-lines" aria-hidden="true"><span></span><span></span><span></span></div>${btn('Stop waiting', 'stop', 'quiet')}`;
  }
  function workspace() {
    const p = state.phase, answered = p === 'ready' || p === 'partial';
    const tabs = [['summary', 'Overview'], ['apps', 'Applications'], ['shelf', 'Shelf'], ['sources', 'Sources']];
    const body = () => state.view === 'shelf' ? shelfBody() : state.view === 'sources' ? sourcesBody() : state.view === 'apps' ? appsBody() : overviewBody();
    const top = `<div class="workspace-top"><div class="workspace-title"><span class="tiny-orb" aria-hidden="true"></span><strong>${esc(state.query.slice(0, 80) || 'Your request')}</strong></div><span class="mode-indicator" data-phase="${p}">${PHASES[p] ? PHASES[p].mode : ''}</span></div>`;
    const inner = answered ? `<div class="workspace-tabs" role="tablist" aria-label="Answer workspace">${tabs.map(([id, label]) => btn(label, 'tab', '', `id="tab-${id}" data-tab="${id}" role="tab" aria-selected="${state.view === id}" aria-controls="workspace-content"`)).join('')}</div><div class="workspace-body" id="workspace-content" role="tabpanel" aria-labelledby="tab-${state.view}">${body()}</div>`
      : `<div class="loading-body" data-phase="${p}"><span class="tiny-orb" style="width:28px;height:28px" aria-hidden="true"></span>${p === 'running' ? loadingBody() : terminalBody(p)}</div>`;
    return `<section class="workspace" aria-label="Workspace assembled for your request">${top}${inner}</section>`;
  }
  function mission() {
    const meta = PHASES[state.phase] || PHASES.running;
    return `<div class="mission"><aside class="mission-left"><div class="mission-presence"><canvas id="core-canvas" role="img" aria-label="Particle core reflecting the assistant’s activity"></canvas></div><div class="mission-label">${meta.label}</div>${voiceControls()}<div class="request-bubble">${esc(state.query)}</div><div class="assistant-message"><div class="message-id"><span class="tiny-orb" aria-hidden="true"></span>${esc(state.name.toUpperCase())}</div>${assistantReply()}</div>${ledger()}${composer(true)}<div class="mission-actions">${state.phase === 'running' ? btn('Stop waiting', 'stop', 'quiet') : btn('Start a new conversation', 'new', 'quiet')}${btn('Preferences', 'settings', 'quiet')}</div></aside>${workspace()}</div>`;
  }
  function pageHtml() {
    const sr = PHASES[state.phase] ? PHASES[state.phase].sr : '';
    return `<div class="nexus"><div class="study-bar"><a href="/cockpit/">← Cockpit</a>${S.pickerMarkup('nexus')}<span>CENTRAL ASSISTANT · LIVE</span><span>${esc(snapshot.me.name)} · ${snapshot.botsOnline}/${snapshot.bots.length} assistants online</span>${S.skinPicker()}</div><div class="nexus-shell">${rail()}<main class="nexus-main"><header class="topline"><div class="assistant-brand"><strong>${esc(state.name.toUpperCase())}</strong><span>Your swarm, in conversation.</span></div><div class="top-options"><span><span class="status-dot"></span>Personal workspace · ${esc(snapshot.me.name)}</span>${btn(state.motion ? 'Motion on' : 'Motion off', 'motion', 'small-button', `aria-pressed="${state.motion}"`)}${btn('Preferences', 'settings', 'small-button')}</div></header>${state.phase === 'idle' ? welcome() : mission()}<footer class="privacy-line"><span>Answers come from your own Jarvis. Opening an application never saves, sends, books or schedules anything.</span>${btn('What is live here', 'sources', 'quiet')}</footer></main></div><div id="modal-host"></div><div id="notice" class="notice" role="status" aria-live="polite"></div><span class="sr-only" role="status" aria-live="polite">${sr}</span></div>`;
  }
  function render() {
    document.title = `${state.name} / Your swarm, in conversation`;
    cancelAnimationFrame(animation); if (observer) observer.disconnect();
    // Repaints must not throw away what the person is typing or where the caret is.
    const active = document.activeElement, typing = Boolean(active && active.id === 'intent-input'), caret = typing ? [active.selectionStart, active.selectionEnd] : null;
    root.innerHTML = pageHtml();
    if (typing) { const input = document.getElementById('intent-input'); if (input && !input.disabled) { input.focus(); try { input.setSelectionRange(caret[0], caret[1]); } catch (_) { /* not a text control */ } } }
    attachOrb(); paintVoice();
  }
  /** Repaint only the live parts (ledger, background work, mode) so a follow-up being typed keeps its focus. */
  function paintProgress() {
    const ledgerEl = root.querySelector('.action-ledger'); if (ledgerEl) ledgerEl.outerHTML = ledger();
    const workEl = root.querySelector('[data-part="work"]'); if (workEl) workEl.outerHTML = workCard();
    const mode = root.querySelector('.mode-indicator'); if (mode && PHASES[state.phase]) { mode.textContent = PHASES[state.phase].mode; mode.dataset.phase = state.phase; }
    const heading = root.querySelector('#run-stage'); if (heading) heading.textContent = ['Sending your request.', 'The swarm is working.', 'Still working on it.'][stage()];
  }

  /* ── particle core (presentation only; energy follows the voice) ── */
  function attachOrb() {
    cancelAnimationFrame(animation); if (observer) observer.disconnect();
    const canvas = document.getElementById('core-canvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); let w = 0, h = 0, lastTime = 0, spread = 0, energy = 0;
    const size = () => { const box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); w = box.width; h = box.height; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size(); observer = new ResizeObserver(() => { size(); if (!state.motion) draw(0); }); observer.observe(canvas);
    function draw(time) {
      if (!canvas.isConnected) return;
      const dt = lastTime ? Math.min(64, time - lastTime) : 16; lastTime = time;
      const speaking = state.motion && voice.active, working = state.motion && state.phase === 'running';
      const target = state.motion ? (voice.active ? voice.level : working ? 0.18 : 0) : 0;
      spread += ((speaking ? .7 + target * .3 : working ? .25 : 0) - spread) * (1 - Math.exp(-dt / (speaking ? 260 : 470)));
      energy += (target - energy) * (1 - Math.exp(-dt / (target > energy ? 45 : 160)));
      if (!state.motion) { spread = 0; energy = 0; }
      ctx.clearRect(0, 0, w, h);
      const t = state.motion ? time * .00011 : 0, beat = state.motion ? time * .001 : 0, r = Math.min(w * .28, h * .33);
      const cx = w / 2 + Math.sin(beat * 1.4) * r * .07 * spread, cy = h * .51 + Math.cos(beat * 1.1) * r * .045 * spread;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * (1.85 + energy * .25));
      glow.addColorStop(0, '#85e4cf18'); glow.addColorStop(.52, '#2697a42b'); glow.addColorStop(1, '#14546900');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = '#739fa933'; ctx.lineWidth = .7;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.ellipse(0, 0, r * (1.2 + i * .12 + spread * .09), r * (.25 + i * .11 + energy * .035), -.25 + i * .65 + spread * .08 * Math.sin(beat), 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
      const dots = [];
      for (let i = 0; i < 1050; i++) {
        const seed = (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1, scatter = Math.abs(seed);
        const y = 1 - 2 * (i + .5) / 1050, rr = Math.sqrt(1 - y * y), angle = i * 2.39996323 + t, ridge = 1 + .11 * Math.sin(angle * 3 + y * 9 + t * 2);
        const x = Math.cos(angle) * rr, z = Math.sin(angle) * rr, yy = y * .92 + .08 * Math.sin(angle * 2 + t);
        const vy = yy * Math.cos(.22) - z * Math.sin(.22), vz = yy * Math.sin(.22) + z * Math.cos(.22), s = 1 + vz * .14;
        const release = spread * (.06 + .37 * scatter * scatter) + energy * .18, flutter = energy * .022 * r, drift = spread * r * .045 * Math.sin(beat * 1.8 + i * .17);
        const px = cx + x * r * (ridge + release) * s + drift + Math.sin(beat * 24 + i * 2.3) * flutter;
        const py = cy + vy * r * (ridge + release) * s + spread * r * .04 * Math.cos(beat * 1.4 + i * .13) + Math.cos(beat * 28 + i * 1.7) * flutter;
        dots.push({ x: px, y: py, z: vz, size: (.5 + (vz + 1) * .55) * (1 + scatter * spread * .9 + energy * .25), tailX: x * energy * r * .04, tailY: vy * energy * r * .04 });
      }
      dots.sort((a, b) => a.z - b.z);
      for (const p of dots) {
        const alpha = .15 + (p.z + 1) * .33, color = p.z > .4 ? '178,244,218' : '78,159,181';
        if (energy > .08 && p.z > 0) { ctx.strokeStyle = `rgba(${color},${alpha * .25})`; ctx.lineWidth = p.size * .6; ctx.beginPath(); ctx.moveTo(p.x - p.tailX, p.y - p.tailY); ctx.lineTo(p.x, p.y); ctx.stroke(); }
        ctx.fillStyle = `rgba(${color},${alpha})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = 0; i < 4; i++) { const a = t * .8 + i * Math.PI / 2, x = cx + Math.cos(a) * r * (1.45 + spread * .1), y = cy + Math.sin(a) * r * (.43 + spread * .1); ctx.fillStyle = i === 1 ? '#d7bd8f' : '#a5e4d3'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 9; ctx.beginPath(); ctx.arc(x, y, 2 + energy, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; }
      canvas.dataset.scatter = spread.toFixed(3); canvas.dataset.energy = energy.toFixed(3);
      if (state.motion && !document.hidden) animation = requestAnimationFrame(draw);
    }
    draw(state.motion ? performance.now() : 0);
  }

  /* ── the real ask ────────────────────────────────────────────── */
  /** End the current wait: the generation moves on (so nothing older may touch the page) and the in-flight poll is aborted. */
  function endWait() {
    generation++;
    if (pending) { pending.abort(); pending = null; }
    state.busy = false;
  }
  async function run(query) {
    const text = String(query || '').trim(); if (!text || state.busy) return;
    stopVoice(); endWait();
    const gen = generation, controller = new AbortController(); pending = controller;
    Object.assign(state, { query: text, draft: '', phase: 'running', resume: '', busy: true, view: 'summary', result: null, error: '', code: '', jobId: '', work: [], workNote: '', obs: Object.assign(freshObs(), { sentAt: new Date() }) });
    render();
    const result = await LIVE.ask(text, { signal: controller.signal, onPhase: p => { if (gen === generation) observe(p); } });
    // A stopped, restarted or superseded request never reopens or overwrites the workspace.
    if (gen !== generation || !result || result.status === 'aborted') return;
    pending = null; state.busy = false;
    settle(result);
  }
  function observe(p) {
    const o = state.obs;
    if (p.phase === 'rolled') { o.rolled = true; thread.sessionId = p.sessionId; }
    if (p.phase === 'accepted') { o.jobId = p.jobId; state.jobId = p.jobId; }
    if (p.phase === 'waiting') o.polls = p.poll;
    if (state.phase === 'running') paintProgress();
  }
  /** Map the terminal ask result to the lifecycle: ready, partial (handed-off work continuing), still running (the page's poll limit, never a failure), setup-needed or failed. */
  function settle(result) {
    state.result = result; state.jobId = result.jobId || state.jobId;
    if (result.status === 'done') {
      state.work = (result.dispatched || []).map(d => ({ workJobId: d.workJobId, title: d.title, status: 'unlisted', ticketId: '', files: [], result: '', error: '', cancel: '', cancelNote: '' }));
      state.phase = state.work.length ? 'partial' : 'ready';
    } else if (result.code === 'poll_limit') {
      state.phase = 'unsettled'; state.code = result.code; state.error = UNSETTLED_TEXT;
    } else {
      const setup = result.code === 'NO_HOSTED_BRAIN' || (result.httpStatus === 503 && result.code === 'ai_disabled');
      state.phase = setup ? 'setup' : 'failed'; state.code = result.code || '';
      state.error = String(result.error || 'No answer arrived.');
      if (!state.obs.jobId && result.httpStatus) state.obs.refused = result.httpStatus;
    }
    state.resume = state.phase;
    render();
    if (state.phase === 'partial') track(generation);
    if ((state.phase === 'ready' || state.phase === 'partial') && LIVE.prefs.get('nexus:autoSpeak', false)) speakAnswer();
  }

  /* ── background work: the handed-off items, read from GET /api/jarvis/tasks until they settle ── */
  const pause = ms => new Promise(done => setTimeout(done, ms));
  function applyTasks(rows) {
    state.work.forEach(w => {
      const row = rows.find(t => t && t.id === w.workJobId); if (!row) return;
      Object.assign(w, { status: String(row.status || 'queued'), ticketId: row.ticketId ? String(row.ticketId) : '', files: Array.isArray(row.files) ? row.files : [], result: String(row.result || ''), error: String(row.error || '') });
    });
  }
  /** Follow the handed-off items on the task list until each settles. Nothing is marked delivered here: the Jarvis page announces and marks results. */
  async function track(gen) {
    for (let i = 0; i < TASK_POLL_LIMIT; i++) {
      if (i) await pause(TASK_POLL_MS);
      if (gen !== generation) return;
      const r = await LIVE.packages.jarvis.tasks();
      if (gen !== generation) return;
      if (r.ok && r.body && Array.isArray(r.body.tasks)) { applyTasks(r.body.tasks); state.workNote = ''; }
      else state.workNote = `Your task list did not answer${r.status ? ` (HTTP ${r.status})` : ''}; checking again.`;
      if (state.work.every(settledItem)) return workSettled();
      if (state.phase === 'partial') paintProgress();
    }
    state.workNote = 'This page stopped checking after ten minutes. The item stays on your Jarvis shelf with its live status.';
    if (state.phase === 'partial') paintProgress();
  }
  function workSettled() {
    if (state.resume === 'partial') state.resume = 'ready';
    if (state.phase === 'partial') { state.phase = 'ready'; render(); }
  }
  async function cancelWork(id) {
    const w = state.work.find(item => item.workJobId === id);
    if (!w || !w.ticketId || w.cancel === 'requesting' || settledItem(w)) return;
    const gen = generation; w.cancel = 'requesting'; w.cancelNote = ''; paintProgress();
    const r = await LIVE.packages.jarvis.cancelWork(w.ticketId);
    if (gen !== generation) return;
    if (r.ok && r.body && r.body.status === 'cancelled') { w.cancel = 'cancelled'; w.cancelNote = 'Cancel accepted: the ticket behind this work is now cancelled.'; }
    else { w.cancel = 'refused'; w.cancelNote = cancelRefusal(r); }
    paintProgress();
  }
  function cancelRefusal(r) {
    if (r.status === 404) return 'Cancel refused: the ticket was not found for your account, so nothing was cancelled.';
    if (r.status === 401) return 'Cancel refused: your session has expired. Sign in again.';
    if (r.status === 0) return 'The swarm could not be reached; nothing was cancelled.';
    return `Cancel refused (HTTP ${r.status})${r.body && r.body.error ? `: ${String(r.body.error)}` : ''}. Nothing was cancelled.`;
  }
  function stopWaiting() { if (state.phase !== 'running') return; endWait(); state.phase = 'stopped'; state.resume = 'stopped'; render(); }
  function goHome() {
    stopVoice();
    if (state.phase === 'running') { endWait(); state.resume = 'stopped'; } else if (state.phase !== 'idle') state.resume = state.phase;
    state.phase = 'idle'; render();
  }
  function newChat() {
    stopVoice(); endWait();
    thread = shell.createThread(LIVE.rollSession(), state.name); thread.loaded = true;
    Object.assign(state, { phase: 'idle', resume: '', query: '', result: null, error: '', code: '', jobId: '', work: [], workNote: '', obs: freshObs() });
    render(); notify('Started a fresh thread. Your earlier conversations stay on the Jarvis page.');
  }

  /* ── dialogs ─────────────────────────────────────────────────── */
  function close() { const d = document.getElementById('nexus-dialog'); if (d) d.close(); document.getElementById('modal-host').replaceChildren(); activeModal = null; if (previousFocus && previousFocus.isConnected) previousFocus.focus(); }
  function modal(kind) {
    previousFocus = document.activeElement; activeModal = kind; let title = '', body = '';
    if (kind === 'settings') { title = 'Preferences on this device'; body = `<p>These choices are remembered in this browser only. Renaming the assistant changes the label on this page, not the bot that answers.</p><form id="settings-form"><label class="field">Assistant display name<input id="assistant-name" value="${esc(state.name)}" maxlength="16" required></label><label class="field"><input id="auto-speak" type="checkbox" ${LIVE.prefs.get('nexus:autoSpeak', false) ? 'checked' : ''}> Speak each new answer automatically</label><div class="dialog-buttons"><button type="submit" class="primary">Save on this device</button></div></form>`; }
    else if (kind === 'sources') { title = 'What is live in this view'; body = `<div class="source-row"><span class="source-label">LIVE</span><h3>Your swarm</h3><p>${snapshot.apps.length} installed applications in ${snapshot.suites.length} suites, ${snapshot.botsOnline} of ${snapshot.bots.length} assistants online, ${shell.openWork().length} open work items, all read in your session.</p></div><div class="source-row"><span class="source-label">LIVE</span><h3>Conversation</h3><p>Requests post to your Jarvis thread and are answered by the accountable Jarvis bot with its real tools. Handoffs and files come back with the answer; nothing is scripted.</p></div><div class="source-row"><span class="source-label">LIVE</span><h3>Voice</h3><p>Playback uses the swarm voice route; the core follows playback amplitude when the browser exposes it and is labelled as lifecycle animation otherwise. The microphone opens only while a Talk recording you started is running: the clip goes to the swarm’s transcription route and the words land in the composer for you to send. It never drives the core.</p></div>`; }
    else if (kind === 'saved') { title = 'Your Jarvis shelf'; body = shelfBody(); }
    else if (kind === 'swarm') { title = 'One conversation. The whole swarm.'; body = `<p>${snapshot.apps.length} applications across ${snapshot.suites.length} suites can be reached from this conversation.</p>${snapshot.suites.map(s => `<div class="source-row"><h3>${esc(s.name)} · ${s.count}</h3><p>${esc(s.apps.slice(0, 6).map(a => a.name).join(', ') || 'Nothing installed')}</p></div>`).join('')}<div class="dialog-buttons" style="display:flex;gap:8px;flex-wrap:wrap">${link('Explore in Orbit ↗', '/orbit', 'primary')}${link('Open the cockpit ↗', '/cockpit/', 'primary')}</div>`; }
    if (!title) return;
    document.getElementById('modal-host').innerHTML = `<dialog id="nexus-dialog" class="nexus-dialog" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${btn('×', 'close', 'icon-button', 'aria-label="Close panel"')}</div>${body}</dialog>`;
    const d = document.getElementById('nexus-dialog'); d.showModal(); d.addEventListener('cancel', e => { e.preventDefault(); close(); }); d.addEventListener('click', e => { if (e.target === d) close(); });
  }

  /* ── events ──────────────────────────────────────────────────── */
  function bind() {
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action;
      if (a === 'home') return goHome();
      if (a === 'new') return newChat();
      if (a === 'mic') return mic.state === 'recording' ? stopRecording() : startRecording();
      if (a === 'cancel-work') return cancelWork(b.dataset.job);
      if (a === 'close') return close();
      if (a === 'readback') { if (voice.active) stopVoice(); else speakAnswer(); return; }
      if (a === 'motion') { state.motion = !state.motion; render(); return; }
      if (a === 'stop') return stopWaiting();
      if (a === 'retry') return run(state.query);
      if (a === 'result') { if (state.resume) { state.phase = state.resume; render(); } return; }
      if (a === 'prompt') return run(b.dataset.prompt);
      if (a === 'tab' || a === 'sources-tab') { state.view = a === 'tab' ? b.dataset.tab : 'sources'; render(); if (a === 'tab') { const tab = document.getElementById('tab-' + state.view); if (tab) tab.focus(); } return; }
      if (['settings', 'sources', 'saved', 'swarm'].includes(a)) return modal(a);
    });
    root.addEventListener('change', e => {
      if (e.target.dataset.role === 'experience-picker') { const exp = S.experienceFor(e.target.value); if (exp) location.href = exp.href; }
      if (e.target.id === 'universal-skin-picker' && window.OSHAL_STYLE_SWITCHER) window.OSHAL_STYLE_SWITCHER.applySkin(e.target.value);
    });
    root.addEventListener('submit', e => {
      e.preventDefault();
      if (e.target.id === 'settings-form') { const name = document.getElementById('assistant-name').value.trim(); if (!name || name.length > 16) return; state.name = name; LIVE.prefs.set('nexus:name', name); LIVE.prefs.set('nexus:autoSpeak', document.getElementById('auto-speak').checked); close(); render(); notify('Preferences saved on this device.'); }
      if (e.target.id === 'intent-form') { const q = document.getElementById('intent-input').value.trim(); if (q) run(q); }
    });
    root.addEventListener('input', e => { if (e.target.id === 'intent-input') state.draft = e.target.value; });
    // An owner-checked visual the image route refuses (or that expired) says so instead of showing a broken image.
    root.addEventListener('error', e => { const fig = e.target && e.target.closest ? e.target.closest('.result-visual') : null; if (fig) fig.innerHTML = '<figcaption><span class="source-label">VISUAL</span> The visual could not be loaded. The text answer above is unaffected.</figcaption>'; }, true);
    window.addEventListener('pagehide', () => { if (mic.recorder && mic.state === 'recording') { mic.recorder.onstop = null; try { mic.recorder.stop(); } catch (_) { /* already stopped */ } } releaseMic(); });
    root.addEventListener('keydown', e => {
      if (e.target.id === 'intent-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
      if (e.target.getAttribute('role') === 'tab' && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) { const tabs = ['summary', 'apps', 'shelf', 'sources'], i = tabs.indexOf(state.view); state.view = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[3] : tabs[(i + (e.key === 'ArrowRight' ? 1 : 3)) % 4]; e.preventDefault(); render(); const tab = document.getElementById('tab-' + state.view); if (tab) tab.focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(animation); else attachOrb(); });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => { if (e.matches) { state.motion = false; render(); } });
  }
})();
