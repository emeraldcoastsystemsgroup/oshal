/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Browser front end for the local server: a plain classic script with no build step, no framework, and no module graph, so the page is served straight from public/ and the whole client is auditable in one file. It exports nothing — it is loaded for its side effects on a page it fully owns. Two decisions are safety-driven. (1) Every rendered fragment is written through `textContent`, never `innerHTML`: the text being displayed is model output derived from screenshots of untrusted pages, so it must be impossible for it to become live DOM in this origin. (2) Take control is gated behind a confirmation dialog showing the exact goal, because it is the one action that moves the real cursor — it must be a deliberate choice, never a stray click. Speech recognition lives here rather than on the server because the browser owns the microphone permission prompt; only recognized TEXT is posted, audio never leaves the page, and replies stay text-only so the bot cannot talk over the user.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const conversation = $('conversation');
const prompt = $('prompt');
const history = [];
let busy = null;
let controlActive = false;
let proactiveEnabled = true;
let listening = false;
let recognition = null;
let voiceFlushTimer = null;
let voiceSegments = [];
let interimTranscript = '';
let lastVoiceSent = '';
let latestRecommendation = null;
let pendingControlGoal = '';

function setStatus(text, mode = 'ready') {
  $('statusText').textContent = text;
  $('statusDot').className = `status-dot ${mode}`;
}

function setBusy(value, text) {
  busy = value;
  $('activity').classList.toggle('hidden', !value);
  if (text) $('activityText').textContent = text;
  for (const id of ['sendBtn', 'screenBtn', 'controlBtn']) $(id).disabled = Boolean(value);
  $('stopBtn').classList.toggle('hidden', !controlActive);
  if (value) setStatus(text || value, 'busy');
  else setStatus('Ready', 'ready');
}

function setProactive(enabled) {
  proactiveEnabled = Boolean(enabled);
  $('proactiveBtn').classList.toggle('active', proactiveEnabled);
  $('proactiveBtn').textContent = proactiveEnabled ? 'Proactive on' : 'Proactive off';
}

function appendCode(container, code) {
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  const head = document.createElement('div');
  head.className = 'code-head';
  const copy = document.createElement('button');
  copy.className = 'copy';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    await navigator.clipboard.writeText(code.trim());
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  };
  const pre = document.createElement('pre');
  const node = document.createElement('code');
  node.textContent = code.trim();
  pre.appendChild(node);
  head.appendChild(copy);
  wrap.append(head, pre);
  container.appendChild(wrap);
}

/**
 * @description Render assistant text, splitting fenced blocks out into copyable code panels.
 *
 * Splits on fences and alternates prose/code by index, then writes every piece with `textContent`. That is
 * the XSS boundary for this page: the text originates from a model reading arbitrary untrusted screens, so
 * markup inside it must render as characters and never as DOM. Only fences are interpreted — there is no
 * markdown renderer here on purpose.
 *
 * @param {HTMLElement} container Node to append into.
 * @param {string} text Assistant text, possibly containing fenced blocks.
 * @returns {void}
 */
function renderText(container, text) {
  const chunks = String(text).split(/```(?:[a-zA-Z0-9_-]+)?\r?\n?/);
  chunks.forEach((chunk, index) => {
    if (!chunk) return;
    if (index % 2) appendCode(container, chunk);
    else {
      const part = document.createElement('div');
      part.className = 'text-part';
      part.textContent = chunk.trim();
      container.appendChild(part);
    }
  });
}

function addMessage(role, text, { remember = true } = {}) {
  const message = document.createElement('article');
  message.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'YOU' : 'CODER BOT';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderText(bubble, text);
  message.append(label, bubble);
  conversation.appendChild(message);
  message.scrollIntoView({ behavior: 'smooth', block: 'end' });
  if (remember) {
    history.push({ role, text: String(text) });
    if (history.length > 30) history.splice(0, history.length - 30);
  }
}

function upsertBotMessage(id, labelText, text) {
  let message = document.getElementById(id);
  if (!message) {
    message = document.createElement('article');
    message.id = id;
    message.className = 'message bot';
    const label = document.createElement('div');
    label.className = 'label';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    message.append(label, bubble);
    conversation.appendChild(message);
  }
  message.querySelector('.label').textContent = labelText;
  const bubble = message.querySelector('.bubble');
  bubble.replaceChildren();
  renderText(bubble, text);
  message.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function sendMessage(text = prompt.value) {
  const message = String(text || '').trim();
  if (!message || busy) return;
  prompt.value = '';
  addMessage('user', message);
  setBusy('answering', 'Writing a response…');
  const result = await post('/api/chat', { message, history: history.slice(-11, -1) });
  addMessage('bot', result.error ? `I couldn't answer that: ${result.error}` : result.text);
  setBusy(null);
}

async function readScreen() {
  if (busy) return;
  const question = prompt.value.trim();
  prompt.value = '';
  addMessage('user', question ? `Read this screen: ${question}` : 'Read this screen and guide me through it.');
  setBusy('screen', 'Switch to the target screen — capture in 3 seconds…');
  const result = await post('/api/screen', { question, delayMs: 3000 });
  addMessage('bot', result.error ? `I couldn't read that screen: ${result.error}` : result.text);
  setBusy(null);
}

async function startControl(goal) {
  controlActive = true;
  addMessage('user', `Take control: ${goal}`);
  setBusy('control', 'Reading the screen before the first action…');
  $('stopBtn').classList.remove('hidden');
  const result = await post('/api/operate', { goal });
  addMessage('bot', result.error ? `Screen control stopped: ${result.error}` : result.text);
  controlActive = false;
  setBusy(null);
}

function prepareControl() {
  const goal = prompt.value.trim();
  if (!goal || busy) {
    if (!goal) {
      prompt.focus();
      prompt.placeholder = 'Describe what Coder Bot should do before selecting Take control…';
    }
    return;
  }
  showControlDialog(goal);
}

/**
 * @description Show the confirmation dialog for a screen-control run.
 *
 * The consent gate. Screen control is the only feature that moves the user's real cursor, so both entry
 * points — the typed goal and a proactive recommendation's automation goal — are funnelled through here and
 * the exact goal is displayed verbatim before anything starts. Nothing is dispatched until the dialog
 * closes with `confirm`.
 *
 * @param {string} goal The goal to confirm.
 * @returns {void} No-op for an empty goal.
 */
function showControlDialog(goal) {
  pendingControlGoal = String(goal || '').trim();
  if (!pendingControlGoal) return;
  $('goalPreview').textContent = pendingControlGoal;
  $('controlDialog').showModal();
}

function doLatestWork() {
  if (!latestRecommendation?.canAutomate || !latestRecommendation.automationGoal) {
    addMessage('bot', 'The current recommendation does not contain a safe screen-automation step.');
    return;
  }
  showControlDialog(latestRecommendation.automationGoal);
}

function configureSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $('listenBtn').disabled = true;
    $('listenHint').textContent = 'Microphone recognition is unavailable in this browser. Use Chrome or Edge.';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const transcript = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) voiceSegments.push(transcript);
      else interim += `${transcript} `;
    }
    interimTranscript = interim.trim();
    if (interim) {
      $('listenHint').textContent = `Hearing: ${interim.trim()}`;
    }
    if (voiceSegments.length) $('listenHint').textContent = 'Live transcript buffered for the next five-second assessment…';
  };
  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') $('listenHint').textContent = `Microphone: ${event.error}`;
  };
  recognition.onend = () => {
    if (listening) {
      try { recognition.start(); } catch { /* already restarting */ }
    }
  };
}

function toggleListening() {
  if (!recognition) return;
  listening = !listening;
  $('listenBtn').classList.toggle('active', listening);
  $('listenLabel').textContent = listening ? 'Always listening' : 'Always listen';
  if (listening) {
    $('listenHint').textContent = 'Streaming microphone context in five-second assessment windows…';
    voiceFlushTimer = setInterval(flushVoiceContext, 5000);
    try { recognition.start(); } catch { /* already started */ }
  } else {
    if (voiceFlushTimer) clearInterval(voiceFlushTimer);
    voiceFlushTimer = null;
    flushVoiceContext();
    recognition.stop();
    $('listenHint').textContent = 'Chrome or Edge microphone input; replies remain text-only.';
  }
}

/**
 * @description Post the buffered five-second transcript to the server, skipping repeats.
 *
 * Recognized text only — the audio stream never leaves the browser. Batching on an interval instead of
 * posting per recognition event, and dropping a batch identical to the last one, is what keeps interim
 * results from turning into a stream of duplicate assessments.
 *
 * @returns {Promise<void>} Resolves after the post, or immediately when there is nothing new to send.
 */
async function flushVoiceContext() {
  const text = [...voiceSegments, interimTranscript].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  voiceSegments = [];
  if (!text || text === lastVoiceSent) return;
  lastVoiceSent = text;
  await post('/api/context', { text, capturedAt: new Date().toISOString() });
  $('listenHint').textContent = 'Five-second transcript sent for assessment; still listening…';
}

/**
 * @description Subscribe to the server's SSE stream and reflect it in the UI.
 *
 * Server-sent events rather than polling because a control run has to be watchable action by action — the
 * user needs to see what it is about to do while Stop is still useful. Proactive and voice recommendations
 * are upserted into a single pinned message each, so a continuous assessment loop refreshes one card instead
 * of burying the conversation in an endless feed.
 *
 * @returns {void}
 */
function connectEvents() {
  const events = new EventSource('/api/events');
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'screen-countdown') setBusy('screen', `Switch screens — capture in ${Math.ceil(data.delayMs / 1000)} seconds…`);
    else if (data.type === 'screen-captured') setBusy('screen', 'Screenshot captured. You can return here while I read it…');
    else if (data.type === 'control-start') {
      controlActive = true;
      setBusy('control', 'Screen control active…');
    } else if (data.type === 'control-step') {
      setBusy('control', `${data.action}${data.reason ? ` — ${data.reason}` : ''}`);
    } else if (data.type === 'control-end' || data.type === 'control-aborted') {
      controlActive = false;
      $('stopBtn').classList.add('hidden');
    } else if (data.type === 'busy' && !data.busy && !controlActive) {
      setBusy(null);
    } else if (data.type === 'proactive-reading') {
      setStatus('Assessing screen change…', 'busy');
    } else if (data.type === 'proactive-suggestion') {
      latestRecommendation = data.result;
      upsertBotMessage('live-screen-recommendation', 'LIVE SCREEN RECOMMENDATION', data.result.text);
      $('doWorkBtn').disabled = !data.result.canAutomate;
      setStatus('Ready', 'ready');
    } else if (data.type === 'proactive-state') {
      setProactive(data.state.enabled);
      if (!data.state.running && !busy) setStatus('Ready', 'ready');
    } else if (data.type === 'proactive-error') {
      setStatus('Proactive check will retry', 'busy');
    } else if (data.type === 'voice-assessing') {
      setStatus('Assessing live transcript…', 'busy');
    } else if (data.type === 'voice-suggestion') {
      upsertBotMessage('live-voice-recommendation', 'LIVE VOICE GUIDANCE', data.text);
      setStatus('Ready', 'ready');
    } else if (data.type === 'voice-error') {
      setStatus('Voice assessment will retry', 'busy');
    }
  };
  events.onerror = () => setStatus('Reconnecting…', 'busy');
}

async function toggleProactive() {
  const result = await post('/api/proactive', { enabled: !proactiveEnabled });
  if (result.error) addMessage('bot', `I couldn't change proactive monitoring: ${result.error}`);
  else setProactive(result.enabled);
}

async function loadState() {
  try {
    const state = await fetch('/api/state').then((response) => response.json());
    if (state.proactive) setProactive(state.proactive.enabled);
  } catch {
    // EventSource reconnects independently.
  }
}

$('sendBtn').onclick = () => sendMessage();
$('screenBtn').onclick = readScreen;
$('controlBtn').onclick = prepareControl;
$('doWorkBtn').onclick = doLatestWork;
$('listenBtn').onclick = toggleListening;
$('proactiveBtn').onclick = toggleProactive;
$('stopBtn').onclick = () => post('/api/control', { action: 'abort' });
$('controlDialog').addEventListener('close', () => {
  if ($('controlDialog').returnValue !== 'confirm') return;
  const goal = pendingControlGoal;
  pendingControlGoal = '';
  if (goal === prompt.value.trim()) prompt.value = '';
  startControl(goal);
});
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

addMessage('bot', `I’m ready. Screen assessment runs continuously and starts the next screenshot as soon as the prior assessment finishes.

Click Always listen once to grant microphone permission. I’ll assess its rolling transcript every five seconds and combine it with the screen. When a recommendation is safely automatable, use Do this work.`, { remember: false });
configureSpeech();
connectEvents();
loadState();
setStatus('Ready', 'ready');
prompt.focus();
