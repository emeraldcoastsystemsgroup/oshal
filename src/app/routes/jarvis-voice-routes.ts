/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: two thin Jarvis voice surfaces for the phone-as-mic model (ADR-047) — GET /api/jarvis/tv (Fire TV view) and GET /api/jarvis/remote (phone push-to-talk). Both reuse the existing Jarvis ask/history endpoints + the default per-user session.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Branded TV view + server-rendered scannable QR (qrcode) for the phone remote URL.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Rich Jarvis TV screen: animated CSS eye (blink/gaze/speaking glow), live conversation (/history), tasks (/tasks), services (/catalog), speaks new answers via the native OshalTTS bridge. Phone remote rewritten for reliable continuous dictation (tap-to-start / tap-to-send, interim transcript, auto-restart) instead of cutting off after one word.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Room/device targeting (ADR-068): each TV claims a ROOM (its own per-room session thread) via POST /api/jarvis/tv/register + heartbeat; the phone remote lists active rooms (GET /api/jarvis/tv/rooms) and sends /ask with the chosen room's sessionId, so only that screen shows + speaks the reply (no more multi-TV duplication). TV scan-to-talk QR carries ?room= so scanning a screen pre-selects it on the phone.
 */
import { Router, RequestHandler, Request, Response } from 'express';
import QRCode from 'qrcode';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'jarvis-voice' });

/** @description Absolute origin used to build the phone-remote URL encoded in the QR. */
function appOrigin(req: Request): string {
  return (process.env.APP_URL || `https://${req.hostname}`).replace(/\/$/, '');
}

/** @description The caller's user sub (the TV-token middleware injects req.oidc for paired TVs). */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

// ── TV room registry ───────────────────────────────────────────────────────────
// Lets the phone target ONE screen instead of every logged-in TV speaking at once.
// Each TV registers a room (→ its own per-room Jarvis session thread) and heartbeats;
// the phone lists active rooms and sends to the chosen room's sessionId. In-memory +
// TTL'd — a TV that stops heartbeating drops off the list (pairing-style volatility).
interface TvRoom { sub: string; room: string; sessionId: string; lastSeen: number; }
const ROOM_TTL_MS = 90 * 1000;
const tvRooms = new Map<string, TvRoom>(); // key: `${sub}|${sessionId}`

/** Slugify a room label into a safe session-id token (≤40 chars). */
function roomSlug(room: string): string {
  return String(room || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

/** The Jarvis session thread for a room. Empty/"main" → the default per-user thread (back-compat). */
function roomSessionId(sub: string, room: string): string {
  const slug = roomSlug(room);
  if (slug === '' || slug === 'main') return `jarvis-${sub}`;
  return `jarvis-${sub}-${slug}`;
}

/** Drop registrations that stopped heartbeating. */
function sweepRooms(): void {
  const now = Date.now();
  for (const [k, v] of tvRooms) if (now - v.lastSeen > ROOM_TTL_MS) tvRooms.delete(k);
}

/** Register/refresh a TV's room and return its resolved session thread. */
function registerRoom(sub: string, room: string): TvRoom {
  const sessionId = roomSessionId(sub, room);
  const label = (String(room || '').trim() || 'Main').slice(0, 40);
  const entry: TvRoom = { sub, room: label, sessionId, lastSeen: Date.now() };
  tvRooms.set(`${sub}|${sessionId}`, entry);
  return entry;
}

/** Active rooms for a user (most-recently-seen first deduped by session). */
function listRooms(sub: string): TvRoom[] {
  sweepRooms();
  const out: TvRoom[] = [];
  for (const v of tvRooms.values()) if (v.sub === sub) out.push(v);
  return out.sort((a, b) => a.room.localeCompare(b.room));
}

/**
 * @description Registers the two voice surfaces. Pure views over the existing Jarvis
 * ask/history/tasks/catalog endpoints, so the phone and the TV share the caller's default session.
 * @param requiresAuth the route auth guard.
 * @returns an Express Router.
 */
export function createJarvisVoiceRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();

  router.get('/api/jarvis/tv', requiresAuth, async (req: Request, res: Response) => {
    const sub = callerSub(req);
    const room = String((req.query as { room?: string }).room || '').trim();
    const slug = roomSlug(room);
    if (sub) registerRoom(sub, room || 'Main');
    const sessionId = sub ? roomSessionId(sub, room) : '';
    // The scan-to-talk QR carries ?room= so scanning THIS screen pre-selects it on the phone.
    const remoteUrl = `${appOrigin(req)}/api/jarvis/remote` + (slug ? `?room=${encodeURIComponent(slug)}` : '');
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(remoteUrl, { type: 'svg', margin: 1, color: { dark: '#0e0e16', light: '#ffffff' } });
    } catch (err) {
      logger.warn({ err }, 'QR render failed; TV view falls back to the URL text');
    }
    res.type('html').send(tvView(remoteUrl, qrSvg, room || 'Main', sessionId));
  });

  router.get('/api/jarvis/remote', requiresAuth, (_req: Request, res: Response) => res.type('html').send(REMOTE_VIEW));

  /** POST /api/jarvis/tv/register — a TV claims/heartbeats a room. Body: { room }. */
  router.post('/api/jarvis/tv/register', requiresAuth, (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const entry = registerRoom(sub, String((req.body as { room?: string })?.room || 'Main'));
    res.json({ room: entry.room, sessionId: entry.sessionId });
  });

  /** GET /api/jarvis/tv/rooms — the phone lists active TV rooms to target. */
  router.get('/api/jarvis/tv/rooms', requiresAuth, (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    res.json({ rooms: listRooms(sub).map((r) => ({ room: r.room, sessionId: r.sessionId })) });
  });

  return router;
}

/** The Fire TV "Jarvis" screen: animated eye, live conversation, tasks, services, scannable QR. */
function tvView(remoteUrl: string, qrSvg: string, roomLabel: string, sessionId: string): string {
  const qrBlock = qrSvg
    ? `<div class="qrbox">${qrSvg}</div>`
    : `<div class="qrbox" style="display:flex;align-items:center;justify-content:center;color:#0e0e16;font-size:12px;padding:10px;text-align:center">Open on your phone</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>OSHAL — Jarvis</title>
<style>:root{--bg:#0d0d14;--panel:#16161f;--panel2:#1c1c27;--line:#262633;--text:#e8e8f0;--muted:#8a8a9c;--accent:#7c6cff;--accent2:#22c79a}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;color:var(--text);font-family:system-ui,-apple-system,Segoe UI,sans-serif;
background:radial-gradient(900px 520px at 82% -16%,rgba(124,108,255,.10),transparent),var(--bg);
display:grid;grid-template-rows:auto 1fr;grid-template-columns:1fr clamp(240px,21vw,360px);
gap:18px 22px;padding:22px 28px;height:100vh}
.bar{grid-column:1/3;display:flex;align-items:center;gap:14px}
.eye{width:clamp(40px,3.2vw,58px);height:clamp(40px,3.2vw,58px);border-radius:50%;position:relative;overflow:hidden;flex:none;
background:radial-gradient(circle at 50% 42%,#23232f,#0b0b12);border:1px solid var(--line);box-shadow:0 0 16px -5px var(--accent)}
.gaze{position:absolute;inset:0;transition:transform .6s ease}
.iris{position:absolute;left:50%;top:50%;width:46%;height:46%;transform:translate(-50%,-50%);border-radius:50%;
background:radial-gradient(circle at 40% 34%,#b6abff,var(--accent) 52%,#2a2270 82%)}
.pupil{position:absolute;left:50%;top:50%;width:18%;height:18%;transform:translate(-50%,-50%);border-radius:50%;background:#05050b}
.glint{position:absolute;left:41%;top:35%;width:9%;height:9%;border-radius:50%;background:rgba(255,255,255,.9)}
.lid{position:absolute;left:-6%;right:-6%;height:62%;background:var(--bg);transition:transform .11s ease;z-index:2}
.lid.top{top:-62%}.lid.bottom{bottom:-62%}
.eye.blink .lid.top{transform:translateY(100%)}.eye.blink .lid.bottom{transform:translateY(-100%)}
.eye.speaking{animation:glow 1.1s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 14px -4px var(--accent)}50%{box-shadow:0 0 22px 1px var(--accent2)}}
.brandwrap{display:flex;flex-direction:column;line-height:1.18}
.brand{font-size:clamp(15px,1.1vw,20px);font-weight:700;letter-spacing:.2px}.brand span{color:var(--accent)}
.status{color:var(--muted);font-size:clamp(11px,.8vw,14px)}
.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:46vw}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:3px 11px;font-size:clamp(10px,.72vw,13px);color:var(--muted)}
/* conversation */
.convo{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:2px 12px 6px 2px}
.turn{display:flex;flex-direction:column;gap:4px;max-width:80%}
.turn.you{align-self:flex-end;align-items:flex-end}.turn.jar{align-self:flex-start}
.who{font-size:clamp(10px,.7vw,12px);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.bub{padding:11px 15px;border-radius:14px;font-size:clamp(16px,1.3vw,23px);line-height:1.45}
.turn.you .bub{background:var(--accent);color:#fff;border-bottom-right-radius:5px}
.turn.jar .bub{background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:5px}
.empty{color:var(--muted);font-size:clamp(15px,1.1vw,19px);margin:auto;text-align:center;max-width:62%;line-height:1.5}
/* rail */
.rail{display:flex;flex-direction:column;gap:14px;min-height:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 15px;display:flex;flex-direction:column;gap:9px;min-height:0}
.card h2{margin:0;font-size:clamp(11px,.72vw,13px);color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:700}
.card h2 span{color:var(--accent2);font-weight:600}
.taskscard{flex:1.7}.botscard{flex:1}
.list{overflow:auto;display:flex;flex-direction:column}
.row{display:flex;align-items:center;gap:9px;padding:7px 0;font-size:clamp(13px,.92vw,16px);border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.tdot{width:8px;height:8px;border-radius:50%;flex:none}.tdot.done{background:var(--accent2)}
.tdot.running{background:#f5b73d;animation:firing 1s ease-in-out infinite}.tdot.error{background:#ff5d73}.tdot.idle{background:#555}
@keyframes firing{0%,100%{box-shadow:0 0 0 0 rgba(245,183,61,.7)}50%{box-shadow:0 0 0 4px rgba(245,183,61,0)}}
.nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.none{color:var(--muted);font-size:clamp(12px,.82vw,14px);padding:5px 0}
.qrcard{align-items:center}.qrbox{background:#fff;border-radius:10px;padding:8px;width:clamp(96px,7vw,128px);height:clamp(96px,7vw,128px)}
.qrbox svg{width:100%;height:100%;display:block}.qrcard .u{color:var(--muted);font-size:clamp(9px,.62vw,11px);word-break:break-all;text-align:center}</style></head>
<body>
<div class="bar">
  <div class="eye" id="eye"><div class="gaze" id="gaze"><div class="iris"></div><div class="pupil"></div><div class="glint"></div></div><div class="lid top"></div><div class="lid bottom"></div></div>
  <div class="brandwrap"><div class="brand">OSHAL <span>Jarvis</span></div><div class="status" id="status">Connecting…</div></div>
  <div class="chips" id="chips"></div>
</div>
<script>var SESSION=${JSON.stringify(sessionId)},ROOM=${JSON.stringify(roomLabel)};</script>

<div class="convo" id="convo"><div class="empty">Ask me anything from your phone — our conversation shows up here, and I'll read my answers out loud.</div></div>

<div class="rail">
  <div class="card taskscard"><h2>Tasks <span id="taskcount"></span></h2><div class="list" id="tasks"><div class="none">No tasks yet.</div></div></div>
  <div class="card botscard"><h2>Bots <span id="botcount"></span></h2><div class="list" id="bots"><div class="none">Loading…</div></div></div>
  <div class="card qrcard"><h2>Talk to me · ${roomLabel}</h2>${qrBlock}<div class="u">${remoteUrl}</div></div>
</div>

<script>
var $=function(id){return document.getElementById(id);};
var eye=$('eye'),gaze=$('gaze'),convo=$('convo'),status=$('status');
/* eye life */
setInterval(function(){eye.classList.add('blink');setTimeout(function(){eye.classList.remove('blink');},150);},3800+Math.random()*2200);
setInterval(function(){gaze.style.transform='translate('+((Math.random()*2-1)*8).toFixed(1)+'%,'+((Math.random()*2-1)*6).toFixed(1)+'%)';},2200);
var curAudio=null;
function speak(t){eye.classList.add('speaking');
/* Prefer the server's neural voice (Gemini TTS); fall back to the device engine. */
fetch('/api/voice/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})})
.then(function(r){return r.json();}).then(function(j){var d=(j&&j.data)||{};if(!d.audioData)throw 0;
var fmt=d.format||'wav';var mime=fmt.indexOf('/')>=0?fmt:'audio/'+fmt;
if(curAudio){try{curAudio.pause();}catch(e){}}
curAudio=new Audio('data:'+mime+';base64,'+d.audioData);
curAudio.onended=function(){eye.classList.remove('speaking');};
curAudio.onerror=function(){nativeSpeak(t);};
curAudio.play().catch(function(){nativeSpeak(t);});}).catch(function(){nativeSpeak(t);});}
function nativeSpeak(t){var ms=Math.max(1600,Math.min(12000,t.split(/\\s+/).length*380));
setTimeout(function(){eye.classList.remove('speaking');},ms);
if(window.OshalTTS&&OshalTTS.speak){try{OshalTTS.speak(t);return;}catch(e){}}
if('speechSynthesis'in window){try{speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(t));}catch(e){}}}
/* conversation */
var primed=false,lastA='';
function renderConvo(turns){convo.innerHTML='';turns.slice(-10).forEach(function(t){
var who=t.role==='user'?'you':'jar';var wrap=document.createElement('div');wrap.className='turn '+who;
var lbl=document.createElement('div');lbl.className='who';lbl.textContent=who==='you'?'You':'Jarvis';
var bub=document.createElement('div');bub.className='bub';bub.textContent=t.text;
wrap.appendChild(lbl);wrap.appendChild(bub);convo.appendChild(wrap);});
convo.scrollTop=convo.scrollHeight;}
var HIST=SESSION?('/api/jarvis/history?sessionId='+encodeURIComponent(SESSION)):'/api/jarvis/history';
function pollHistory(){fetch(HIST,{headers:{Accept:'application/json'}}).then(function(r){if(!r.ok)throw 0;return r.json();})
.then(function(j){var turns=(j.turns||[]);if(turns.length)renderConvo(turns);
var jr=null,i;for(i=turns.length-1;i>=0;i--){if(turns[i].role==='jarvis'){jr=turns[i];break;}}
if(jr){if(primed&&jr.text!==lastA){speak(jr.text);}lastA=jr.text;}
primed=true;status.textContent='Listening on your phone — '+ROOM;}).catch(function(){status.textContent='Reconnecting…';});}
/* heartbeat so the phone can target THIS screen by room */
function heartbeat(){if(!ROOM)return;fetch('/api/jarvis/tv/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:ROOM})}).catch(function(){});}
heartbeat();setInterval(heartbeat,30000);
/* tasks (priority) */
function pollTasks(){fetch('/api/jarvis/tasks',{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(j){
var ts=(j.tasks||[]),el=$('tasks');$('taskcount').textContent=ts.length?('· '+ts.length):'';
if(!ts.length){el.innerHTML='<div class="none">No tasks yet.</div>';return;}
el.innerHTML='';ts.slice(0,12).forEach(function(t){var row=document.createElement('div');row.className='row';
var cls=t.status==='done'?'done':(t.status==='error'?'error':(t.status==='running'?'running':'idle'));
row.innerHTML='<span class="tdot '+cls+'"></span><span class="nm"></span>';row.querySelector('.nm').textContent=t.title||'(task)';el.appendChild(row);});}).catch(function(){});}
/* live bots — online (green) + firing (amber pulse) */
function pollBots(){fetch('/api/jarvis/overview',{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(j){
var bots=(j.bots||[]),el=$('bots');
var shown=bots.filter(function(b){return b.online||b.active;}).sort(function(a,b){return (b.active?1:0)-(a.active?1:0);});
$('botcount').textContent=shown.length?('· '+shown.length+' online'):'';
if(!shown.length){el.innerHTML='<div class="none">No bots online.</div>';return;}
el.innerHTML='';shown.slice(0,12).forEach(function(b){var row=document.createElement('div');row.className='row';
var cls=b.active?'running':'done';
row.innerHTML='<span class="tdot '+cls+'"></span><span class="nm"></span>';
row.querySelector('.nm').textContent=(b.name||b.agentId)+(b.active?' · firing':'');el.appendChild(row);});}).catch(function(){});}
/* services */
fetch('/api/jarvis/catalog',{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(j){
var apps=(j.apps||[]).slice(0,8),el=$('chips');el.innerHTML='';apps.forEach(function(a){var c=document.createElement('span');c.className='chip';c.textContent=a.name;el.appendChild(c);});}).catch(function(){});
pollHistory();pollTasks();pollBots();setInterval(pollHistory,2500);setInterval(pollTasks,5000);setInterval(pollBots,6000);
</script></body></html>`;
}

/** The phone view: reliable continuous dictation (tap to start, tap to send) → posts to Jarvis. */
const REMOTE_VIEW = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>Talk to OSHAL</title>
<style>:root{--bg:#0e0e16;--panel:#15151f;--line:#272735;--text:#e6e6f0;--muted:#8b8ba3;--accent:#7c6cff;--danger:#ff5d73}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif;
min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:16px}
h1{font-size:17px;margin:0;color:var(--muted);font-weight:600;text-align:center}
.mic{width:170px;height:170px;border-radius:50%;border:0;background:var(--accent);color:#fff;font-size:17px;font-weight:700;
cursor:pointer;box-shadow:0 16px 40px -12px var(--accent);transition:transform .1s}
.mic:active{transform:scale(.97)}.mic.live{background:var(--danger);box-shadow:0 16px 40px -12px var(--danger);animation:p 1.3s infinite}
@keyframes p{0%,100%{box-shadow:0 16px 40px -12px var(--danger)}50%{box-shadow:0 16px 54px -6px var(--danger)}}
.heard{min-height:24px;font-size:18px;text-align:center;max-width:520px}
.status{color:var(--muted);font-size:14px;min-height:20px;text-align:center}
.row{display:flex;gap:8px;width:100%;max-width:520px}
input{flex:1;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:13px;font-size:16px}
.send{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:0 18px;font-weight:600}
.ans{max-width:520px;color:var(--muted);font-size:15px;line-height:1.4;text-align:center}
.room{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:16px;max-width:520px;width:100%;text-align:center}
.roomlbl{color:var(--muted);font-size:13px;margin:-4px 0 -6px}</style></head>
<body>
<h1>Talk to OSHAL — answers show on your TV</h1>
<div class="roomlbl">Send to</div>
<select class="room" id="room"><option value="">Main</option></select>
<button class="mic" id="mic">Tap&nbsp;to&nbsp;talk</button>
<div class="heard" id="heard"></div>
<div class="status" id="status"></div>
<div class="row"><input id="text" placeholder="…or type a question" /><button class="send" id="send">Send</button></div>
<div class="ans" id="ans"></div>
<script>
var mic=document.getElementById('mic'),st=document.getElementById('status'),heard=document.getElementById('heard'),
inp=document.getElementById('text'),sendBtn=document.getElementById('send'),ans=document.getElementById('ans'),roomSel=document.getElementById('room');
var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
/* Which TV/room to answer on. The chosen <option> value is that room's sessionId
   ("" = the default/Main thread). Populated from the active TVs; pre-selected from the
   ?room= slug encoded in the TV's scan-to-talk QR, else the last room you used. */
function slug(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');}
var WANT=slug(new URLSearchParams(location.search).get('room')||'');
var LAST='';try{LAST=localStorage.getItem('oshal_room')||'';}catch(e){}
function loadRooms(){fetch('/api/jarvis/tv/rooms',{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(j){
var rooms=(j.rooms||[]),seen={};roomSel.innerHTML='<option value="">Main</option>';
rooms.forEach(function(r){if(seen[r.sessionId])return;seen[r.sessionId]=1;
var o=document.createElement('option');o.value=r.sessionId;o.textContent=r.room;roomSel.appendChild(o);});
var pick='';rooms.forEach(function(r){if(WANT&&slug(r.room)===WANT)pick=r.sessionId;});
if(!pick&&LAST){rooms.forEach(function(r){if(r.sessionId===LAST)pick=r.sessionId;});}
roomSel.value=pick;}).catch(function(){});}
roomSel.onchange=function(){try{localStorage.setItem('oshal_room',roomSel.value);}catch(e){}};
loadRooms();setInterval(loadRooms,15000);
var rec=null,listening=false,finalText='';
function setMic(on){listening=on;mic.classList.toggle('live',on);mic.innerHTML=on?'Listening…<br>tap to send':'Tap&nbsp;to&nbsp;talk';}
function startRec(){if(!SR){st.textContent='Voice not supported here — type your question below.';return;}
finalText='';heard.textContent='';ans.textContent='';st.textContent='';
rec=new SR();rec.lang='en-US';rec.continuous=true;rec.interimResults=true;
rec.onresult=function(e){var interim='';for(var i=e.resultIndex;i<e.results.length;i++){
var tr=e.results[i][0].transcript;if(e.results[i].isFinal)finalText+=tr+' ';else interim+=tr;}
heard.textContent=(finalText+interim).trim();};
rec.onerror=function(e){if(e.error==='not-allowed'){st.textContent='Allow microphone access in your browser, then tap again.';setMic(false);}};
rec.onend=function(){if(listening){try{rec.start();}catch(e){}}};/* mobile auto-stops; restart while held open */
try{rec.start();setMic(true);}catch(e){}}
function stopAndSend(){setMic(false);if(rec){try{rec.stop();}catch(e){}}
var t=(finalText||heard.textContent||'').trim();if(t)send(t);else st.textContent='Didn\\'t catch that — try again.';}
function send(text){if(!text)return;heard.textContent=text;ans.textContent='';st.textContent='Sending…';
var body={message:text};if(roomSel&&roomSel.value)body.sessionId=roomSel.value;
var where=(roomSel&&roomSel.selectedOptions[0])?roomSel.selectedOptions[0].textContent:'your TV';
fetch('/api/jarvis/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
.then(function(r){return r.json();}).then(function(j){st.textContent='Sent — watch '+where+'.';if(j.jobId)pollResult(j.jobId);})
.catch(function(){st.textContent='Could not reach OSHAL. Try again.';});}
function pollResult(jobId){var tries=0;var iv=setInterval(function(){tries++;
fetch('/api/jarvis/ask/result?jobId='+encodeURIComponent(jobId)).then(function(r){return r.json();}).then(function(j){
if(j.status==='done'){clearInterval(iv);st.textContent='Answered on your TV.';ans.textContent=j.answer||'';}
else if(j.status==='error'||tries>40){clearInterval(iv);}});} ,2000);}
mic.onclick=function(){if(listening)stopAndSend();else startRec();};
sendBtn.onclick=function(){send(inp.value.trim());};
inp.addEventListener('keydown',function(e){if(e.key==='Enter')send(inp.value.trim());});
</script></body></html>`;
