/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Central assistant shell over the real Jarvis: the intent composer posts to /api/jarvis/ask on the shared browser thread, the ledger and workspace follow the actual job phases (sent, accepted, answered or failed), handoffs open real applications, the shelf lists the caller's Jarvis tasks, and the speaking core moves with the swarm voice route's playback amplitude (or labelled lifecycle pulses when only the browser engine is available). The scripted Vegas journey, fixture fares and prerecorded readback are gone.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, esc = S.esc;
  const root = document.getElementById('nexus-root');
  const btn = (label, action, cls = 'secondary', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
  const link = (label, href, cls = 'secondary') => `<a class="${cls}" href="${esc(href)}">${label}</a>`;
  let snapshot, shell, thread;
  const state = { name: LIVE.prefs.get('nexus:name', 'Jarvis'), phase: 'idle', step: 0, query: '', view: 'summary', jobId: '', result: null, error: '', stopped: false, motion: !matchMedia('(prefers-reduced-motion: reduce)').matches };
  const voice = { active: false, level: 0, mode: '', controller: null, text: '' };
  let animation, observer, noticeTimer, activeModal = null, previousFocus;

  root.innerHTML = '<div class="nexus"><main class="nexus-main"><section class="welcome"><div class="eyebrow">CONNECTING TO YOUR SWARM</div><h1>One moment.</h1></section></main></div>';
  LIVE.ready.then(boot).catch(err => { root.innerHTML = `<div class="nexus"><main class="nexus-main"><section class="welcome"><h1>The assistant could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></section></main></div>`; });

  async function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="nexus"><main class="nexus-main"><section class="welcome"><h1>Sign in to talk to your swarm.</h1><p>${link('Sign in', '/login', 'primary')}</p></section></main></div>`; return; }
    shell = S.createShell({ snapshot, layoutId: 'nexus', hooks: {} });
    thread = shell.createThread(LIVE.sessionId(), state.name);
    bind(); render();
    await thread.load();
    const last = lastExchange();
    if (last) { state.query = last.user; state.result = { status: 'done', answer: last.answer.text, handoffs: last.answer.handoffs || [], files: last.answer.files || [] }; }
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
  function speakAnswer() {
    const text = state.result && state.result.answer ? state.result.answer : '';
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
    if (!state.result || state.result.status !== 'done' || !state.result.answer) return '';
    return `<div class="readback" data-state="${voice.active ? 'playing' : 'idle'}" data-reduced="${!state.motion}"><div class="readback-controls">${btn(voice.active ? '■ Stop' : '▶ Speak the answer', 'readback', 'readback-button', `aria-pressed="${voice.active}"`)}<span class="voice-bars" aria-hidden="true">${[.32, .65, 1, .55, .85, .44, .72].map(h => `<i style="--bar-height:${h}"></i>`).join('')}</span></div><div class="readback-status" role="status" aria-live="polite">${esc(voiceStatus())}</div><details><summary>Transcript</summary><p>${esc(state.result.answer)}</p><small>The text Jarvis returned for this request. Speech uses the swarm voice route, falling back to your browser’s engine.</small></details></div>`;
  }

  /* ── views ───────────────────────────────────────────────────── */
  function composer(compact = false) {
    return `<div class="composer-wrap"><form id="intent-form" class="composer"><label class="sr-only" for="intent-input">Ask your assistant</label><textarea id="intent-input" rows="2" maxlength="1200" placeholder="Tell me what you have in mind…"${thread.busy ? ' disabled' : ''}>${compact ? '' : esc(state.query && state.phase === 'idle' ? '' : '')}</textarea><div class="composer-controls"><div class="context-label"><span>Personal space</span><span>${snapshot.apps.length} applications · ${shell.openWork().length} open</span></div><div class="composer-actions"><button class="send-button" type="submit" aria-label="Send to Jarvis"${thread.busy ? ' disabled' : ''}>↑</button></div></div></form><p class="composer-note">${compact ? 'Ask a follow-up. It continues the same thread.' : 'Your intent, not a list of apps. Answered by your own Jarvis with the swarm’s tools.'}</p></div>`;
  }
  function rail() {
    return `<aside class="rail"><a href="/portal" class="rail-logo" aria-label="All experiences">${esc(state.name.slice(0, 1).toLowerCase())}</a><nav class="rail-nav" aria-label="Assistant navigation">${btn('<span class="rail-symbol" aria-hidden="true">◎</span>Assistant', 'home', `rail-button${state.phase === 'idle' ? ' active' : ''}`)}${btn('<span class="rail-symbol" aria-hidden="true">＋</span>New', 'new', 'rail-button')}${btn('<span class="rail-symbol" aria-hidden="true">◇</span>Shelf', 'saved', 'rail-button')}${btn('<span class="rail-symbol" aria-hidden="true">⠿</span>Swarm', 'swarm', 'rail-button')}</nav><div class="rail-bottom">${btn('⌘', 'settings', 'icon-button', 'aria-label="Preferences"')}<span class="profile" aria-label="${esc(snapshot.me.name)}">${esc(snapshot.me.initials)}</span></div></aside>`;
  }
  function suggestions() {
    const latest = snapshot.work[0];
    return `<div class="suggestions">${btn('What needs my attention today?', 'prompt', 'suggestion', 'data-prompt="What needs my attention today across my swarm? List what is waiting on me first."')}${latest ? btn(`Tell me about “${esc(latest.title.slice(0, 40))}${latest.title.length > 40 ? '…' : ''}”`, 'prompt', 'suggestion', `data-prompt="${esc(`Tell me about ${latest.kind === 'task' ? 'the task' : 'the ticket'} “${latest.title}” and what I should do next.`)}"`) : ''}${btn('What can my swarm do for me?', 'prompt', 'suggestion', 'data-prompt="Which applications do I have and what can each of them do for me? Keep it short."')}${state.result ? btn('Resume the last answer', 'result', 'suggestion') : ''}</div>`;
  }
  function welcome() {
    return `<section class="welcome"><div class="presence"><canvas id="core-canvas" role="img" aria-label="Luminous particle core: the assistant’s presence, moving with its voice"></canvas></div><div class="orb-caption">YOUR WORLD. CONNECTED.</div>${voiceControls()}<div class="eyebrow">${greeting()}, ${esc(firstName().toUpperCase())} / ${snapshot.apps.length} APPS · ${shell.openWork().length} OPEN · ${snapshot.botsOnline} ASSISTANTS ONLINE</div><h1>A little ambition.<br><em>A whole swarm behind you.</em></h1><p>Tell me what you want to do. I’ll bring the right tools to you.</p>${composer()}${suggestions()}<div class="welcome-bottom">${snapshot.suites.slice(0, 3).map(s => `<div class="connected-item"><strong><span class="status-dot"></span>${esc(s.name)}</strong><small>${s.count} application${s.count === 1 ? '' : 's'}</small></div>`).join('')}</div></section>`;
  }
  function ledger() {
    const steps = [['Sent to Jarvis', 'Your request left this page on your own thread.'], ['Accepted by the swarm', state.jobId ? `Job ${state.jobId.slice(0, 8)} is running with the swarm’s tools.` : 'Waiting for the swarm to accept it.'], ['Answer assembled', state.result && state.result.status === 'done' ? `${(state.result.handoffs || []).length} application handoff${(state.result.handoffs || []).length === 1 ? '' : 's'}${(state.result.files || []).length ? `, ${state.result.files.length} file${state.result.files.length === 1 ? '' : 's'}` : ''}.` : state.error ? state.error : 'Tool-using answers can take a minute.']];
    return `<div class="action-ledger" aria-label="Request progress">${steps.map(([name, description], i) => { const done = state.phase === 'ready' || state.step > i, working = state.phase === 'running' && state.step === i, failed = state.phase === 'cancelled' && state.step === i; return `<div class="ledger-step ${!done && !working ? 'pending' : ''}"><span class="step-state" aria-hidden="true">${done ? '✓' : failed ? '×' : working ? '◌' : '·'}</span><div><strong>${name}${working ? ' · now' : ''}</strong><small>${esc(description)}</small></div></div>`; }).join('')}</div>`;
  }
  function assistantReply() {
    if (state.phase === 'cancelled') return `<p>${esc(state.error || 'Stopped waiting. If the swarm was already working, the result still lands on your shelf.')}</p>`;
    if (state.phase !== 'ready') return `<p>${state.step === 0 ? 'Sending your request on your own Jarvis thread.' : 'The swarm accepted it and is working. You can watch the workspace take shape.'}</p>`;
    return S.answerHtml(state.result.answer);
  }
  function handoffApps() {
    const chips = (state.result && state.result.handoffs) || [];
    const named = snapshot.apps.filter(a => state.result && state.result.answer && new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(state.result.answer));
    return { chips, named: named.filter(a => !chips.some(c => c.deepLink && c.deepLink.includes(`app=${a.id}`))).slice(0, 6) };
  }
  function overviewBody() {
    const { chips, named } = handoffApps();
    return `<div class="section-head"><h3>The answer</h3>${btn('Speak it', 'readback', 'quiet')}</div>${S.answerHtml(state.result.answer)}${chips.length ? `<h3>Open where the work lives</h3><div class="work-actions">${chips.map(c => c.deepLink && c.deepLink.startsWith('/') ? link(`Open ${esc(c.name)} ↗`, c.deepLink, 'primary') : '').join('')}</div>` : ''}${named.length ? `<h3>Applications mentioned</h3><div class="work-actions">${named.map(a => a.navigable ? link(`${esc(a.name)} ↗`, a.href, 'secondary') : `<span class="secondary">${esc(a.name)}</span>`).join('')}</div>` : ''}${(state.result.files || []).length ? `<h3>Files</h3>${state.result.files.map(f => `<p>${S.fileLink(f) || esc(f.name || 'file')}</p>`).join('')}` : ''}<div class="work-actions">${link('Continue in Jarvis ↗', '/api/jarvis/', 'secondary')}${btn('View sources', 'sources-tab', 'quiet')}</div>`;
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
    const rows = chips.map(c => ({ name: c.name, href: c.deepLink, note: 'Suggested by Jarvis for this request' })).concat(named.map(a => ({ name: a.name, href: a.navigable ? a.href : '', note: `${shell.suiteOf(a.suite).name} · mentioned in the answer` })));
    return `<div class="eyebrow">APPLICATIONS FOR THIS REQUEST</div><h2 style="font-size:25px;font-weight:400;margin-top:12px">${rows.length ? 'Where this can continue.' : 'No application was singled out.'}</h2>${rows.map(r => `<div class="source-row"><h3>${esc(r.name)}</h3><p>${esc(r.note)}</p>${r.href ? link('Open ↗', r.href, 'primary') : '<span class="secondary">Not available in your workspace</span>'}</div>`).join('') || '<p class="workspace-subtitle">Ask something that points at an application, or browse your swarm from the rail.</p>'}`;
  }
  function workspace() {
    const ready = state.phase === 'ready';
    const tabs = [['summary', 'Overview'], ['apps', 'Applications'], ['shelf', 'Shelf'], ['sources', 'Sources']];
    const body = () => state.view === 'shelf' ? shelfBody() : state.view === 'sources' ? sourcesBody() : state.view === 'apps' ? appsBody() : overviewBody();
    return `<section class="workspace" aria-label="Workspace assembled for your request"><div class="workspace-top"><div class="workspace-title"><span class="tiny-orb" aria-hidden="true"></span><strong>${esc(state.query.slice(0, 80) || 'Your request')}</strong></div><span class="mode-indicator">${ready ? 'LIVE ANSWER' : state.phase === 'cancelled' ? 'STOPPED' : 'WORKING'}</span></div>${ready ? `<div class="workspace-tabs" role="tablist" aria-label="Answer workspace">${tabs.map(([id, label]) => btn(label, 'tab', '', `id="tab-${id}" data-tab="${id}" role="tab" aria-selected="${state.view === id}" aria-controls="workspace-content"`)).join('')}</div><div class="workspace-body" id="workspace-content" role="tabpanel" aria-labelledby="tab-${state.view}">${body()}</div>` : `<div class="loading-body"><span class="tiny-orb" style="width:28px;height:28px" aria-hidden="true"></span><div class="eyebrow">${state.phase === 'cancelled' ? 'STOPPED' : 'WORKSPACE TAKING SHAPE'}</div><h2>${state.phase === 'cancelled' ? (state.error && state.error !== 'stopped' ? 'That did not work.' : 'Nothing runs without you.') : ['Sending your request.', 'The swarm is working.', 'Putting the useful pieces together.'][Math.min(state.step, 2)]}</h2><p>${state.phase === 'cancelled' ? esc(state.error && state.error !== 'stopped' ? state.error : 'You stopped waiting. A request the swarm already accepted still finishes and lands on your shelf.') : 'The workspace forms around the answer: applications to open, files that were produced, and the trail back to the source.'}</p><div class="run-progress" role="progressbar" aria-label="Request stages" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${state.step}"><span style="width:${state.step / 3 * 100}%"></span></div><div class="loading-lines" aria-hidden="true"><span></span><span></span><span></span></div>${state.phase === 'cancelled' ? btn('Ask again', 'retry', 'quiet') : btn('Stop waiting', 'stop', 'quiet')}</div>`}</section>`;
  }
  function mission() {
    return `<div class="mission"><aside class="mission-left"><div class="mission-presence"><canvas id="core-canvas" role="img" aria-label="Particle core reflecting the assistant’s activity"></canvas></div><div class="mission-label">${state.phase === 'running' ? 'BRINGING IT TOGETHER' : state.phase === 'ready' ? 'HERE WHEN YOU NEED ME' : 'PAUSED'}</div>${voiceControls()}<div class="request-bubble">${esc(state.query)}</div><div class="assistant-message"><div class="message-id"><span class="tiny-orb" aria-hidden="true"></span>${esc(state.name.toUpperCase())}</div>${assistantReply()}</div>${ledger()}${composer(true)}<div class="mission-actions">${state.phase === 'running' ? btn('Stop waiting', 'stop', 'quiet') : btn('Start a new conversation', 'new', 'quiet')}${btn('Preferences', 'settings', 'quiet')}</div></aside>${workspace()}</div>`;
  }
  function render() {
    document.title = `${state.name} / Your swarm, in conversation`;
    cancelAnimationFrame(animation); if (observer) observer.disconnect();
    root.innerHTML = `<div class="nexus"><div class="study-bar"><a href="/cockpit/">← Cockpit</a>${S.pickerMarkup('nexus')}<span>CENTRAL ASSISTANT · LIVE</span><span>${esc(snapshot.me.name)} · ${snapshot.botsOnline}/${snapshot.bots.length} assistants online</span>${S.skinPicker()}</div><div class="nexus-shell">${rail()}<main class="nexus-main"><header class="topline"><div class="assistant-brand"><strong>${esc(state.name.toUpperCase())}</strong><span>Your swarm, in conversation.</span></div><div class="top-options"><span><span class="status-dot"></span>Personal workspace · ${esc(snapshot.me.name)}</span>${btn(state.motion ? 'Motion on' : 'Motion off', 'motion', 'small-button', `aria-pressed="${state.motion}"`)}${btn('Preferences', 'settings', 'small-button')}</div></header>${state.phase === 'idle' ? welcome() : mission()}<footer class="privacy-line"><span>Answers come from your own Jarvis. Opening an application never saves, sends, books or schedules anything.</span>${btn('What is live here', 'sources', 'quiet')}</footer></main></div><div id="modal-host"></div><div id="notice" class="notice" role="status" aria-live="polite"></div><span class="sr-only" role="status" aria-live="polite">${state.phase === 'running' ? `Request stage ${state.step + 1} of 3` : state.phase === 'ready' ? 'Answer ready' : state.phase === 'cancelled' ? 'Stopped' : ''}</span></div>`;
    attachOrb(); paintVoice();
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
  async function run(query) {
    const text = String(query || '').trim(); if (!text || thread.busy) return;
    stopVoice();
    state.query = text; state.phase = 'running'; state.step = 0; state.view = 'summary'; state.result = null; state.error = ''; state.jobId = ''; state.stopped = false;
    render();
    const result = await thread.send(text, () => {
      const pending = thread.turns[thread.turns.length - 1];
      if (pending && pending.pending && /accepted|Still working/.test(pending.text)) state.step = Math.max(state.step, 1);
      if (state.phase === 'running') { const el = root.querySelector('.action-ledger'); if (el) el.outerHTML = ledger(); }
    });
    if (state.stopped) return;
    if (result && result.status === 'done') { state.jobId = result.jobId || ''; state.result = result; state.phase = 'ready'; state.step = 3; render(); if (LIVE.prefs.get('nexus:autoSpeak', false)) speakAnswer(); }
    else { state.phase = 'cancelled'; state.step = Math.max(state.step, 1); state.error = result ? result.error : 'No answer arrived.'; state.jobId = result && result.jobId ? result.jobId : ''; render(); }
  }
  function stopWaiting() { state.stopped = true; state.phase = 'cancelled'; state.error = 'stopped'; render(); }
  function newChat() { stopVoice(); thread = shell.createThread(LIVE.rollSession(), state.name); thread.loaded = true; state.phase = 'idle'; state.step = 0; state.query = ''; state.result = null; state.error = ''; state.jobId = ''; render(); notify('Started a fresh thread. Your earlier conversations stay on the Jarvis page.'); }

  /* ── dialogs ─────────────────────────────────────────────────── */
  function close() { const d = document.getElementById('nexus-dialog'); if (d) d.close(); document.getElementById('modal-host').replaceChildren(); activeModal = null; if (previousFocus && previousFocus.isConnected) previousFocus.focus(); }
  function modal(kind) {
    previousFocus = document.activeElement; activeModal = kind; let title = '', body = '';
    if (kind === 'settings') { title = 'Preferences on this device'; body = `<p>These choices are remembered in this browser only. Renaming the assistant changes the label on this page, not the bot that answers.</p><form id="settings-form"><label class="field">Assistant display name<input id="assistant-name" value="${esc(state.name)}" maxlength="16" required></label><label class="field"><input id="auto-speak" type="checkbox" ${LIVE.prefs.get('nexus:autoSpeak', false) ? 'checked' : ''}> Speak each new answer automatically</label><div class="dialog-buttons"><button type="submit" class="primary">Save on this device</button></div></form>`; }
    else if (kind === 'sources') { title = 'What is live in this view'; body = `<div class="source-row"><span class="source-label">LIVE</span><h3>Your swarm</h3><p>${snapshot.apps.length} installed applications in ${snapshot.suites.length} suites, ${snapshot.botsOnline} of ${snapshot.bots.length} assistants online, ${shell.openWork().length} open work items, all read in your session.</p></div><div class="source-row"><span class="source-label">LIVE</span><h3>Conversation</h3><p>Requests post to your Jarvis thread and are answered by the accountable Jarvis bot with its real tools. Handoffs and files come back with the answer; nothing is scripted.</p></div><div class="source-row"><span class="source-label">LIVE</span><h3>Voice</h3><p>Playback uses the swarm voice route; the core follows playback amplitude when the browser exposes it and is labelled as lifecycle animation otherwise. No microphone is opened by this page.</p></div>`; }
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
      if (a === 'home') { stopVoice(); state.phase = 'idle'; render(); return; }
      if (a === 'new') return newChat();
      if (a === 'close') return close();
      if (a === 'readback') { if (voice.active) stopVoice(); else speakAnswer(); return; }
      if (a === 'motion') { state.motion = !state.motion; render(); return; }
      if (a === 'stop') return stopWaiting();
      if (a === 'retry') return run(state.query);
      if (a === 'result') { if (state.result) { state.phase = 'ready'; state.step = 3; render(); } return; }
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
    root.addEventListener('keydown', e => {
      if (e.target.id === 'intent-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
      if (e.target.getAttribute('role') === 'tab' && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) { const tabs = ['summary', 'apps', 'shelf', 'sources'], i = tabs.indexOf(state.view); state.view = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[3] : tabs[(i + (e.key === 'ArrowRight' ? 1 : 3)) % 4]; e.preventDefault(); render(); const tab = document.getElementById('tab-' + state.view); if (tab) tab.focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(animation); else attachOrb(); });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => { if (e.matches) { state.motion = false; render(); } });
  }
})();
