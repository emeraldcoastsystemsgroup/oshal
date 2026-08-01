import { useCallback, useEffect, useRef, useState } from 'react';

const api = (p, body) =>
  fetch(p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' }).then((r) => r.json());

/**
 * Connects to the local backend. It's just a chat bot that runs on THIS computer
 * and drives the real mouse/screen — so there's no screen mirror. The bot's
 * actions stream into the same conversation as short status lines.
 */
export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [pairedTyping, setPairedTypingState] = useState({ enabled: false, status: 'off', completed: 0, total: 0 });
  const [chat, setChat] = useState([
    { role: 'bot', text: "I'm a bot that runs on this computer. Tell me what you want — I'll move the mouse and click to make it happen. Try: \"make an 8-second clip explaining photosynthesis.\"" },
  ]);
  const wsRef = useRef(null);

  const push = useCallback((m) => setChat((c) => [...c.slice(-400), m]), []);
  const sys = useCallback((text) => push({ role: 'sys', text }), [push]);

  const refresh = useCallback(async () => {
    const s = await fetch('/api/state').then((r) => r.json()).catch(() => null);
    if (!s) return;
    setConnected(s.connected);
    setRunning(Boolean(s.current));
    if (s.pairedTyping) setPairedTypingState(s.pairedTyping);
  }, []);

  useEffect(() => {
    let alive = true;
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'state') {
          setConnected(m.state.connected);
          setRunning(Boolean(m.state.current));
          if (m.state.pairedTyping) setPairedTypingState(m.state.pairedTyping);
        }
        else if (m.type === 'paired-typing') setPairedTypingState(m.state);
        else if (m.type === 'frame') { /* no mirror — you can see your own screen */ }
        else if (m.type === 'goal-start') { setRunning(true); sys(`▶ ${m.goal}`); }
        else if (m.type === 'goal-end') { setRunning(false); sys(m.ok ? `done — ${m.reason || ''}` : `stopped — ${m.reason || ''}`); }
        else if (m.type === 'step' && m.status === 'act') sys(`${m.action}${m.reason ? ' — ' + m.reason : ''}`);
        else if (m.type === 'step' && m.status === 'fail') sys(`couldn't act — ${m.message || ''}`);
        else if (m.type === 'log') sys(m.message);
        else if (m.type === 'job-end') refresh();
      };
      ws.onclose = () => { if (alive) setTimeout(connect, 1500); };
    };
    connect();
    refresh();
    return () => { alive = false; wsRef.current && wsRef.current.close(); };
  }, [sys, refresh]);

  const enableControl = useCallback(async () => {
    const r = await api('/api/connect');
    sys(r.error ? `couldn't enable control — ${r.error}` : 'screen control on — I can drive the mouse now');
    refresh();
    return r;
  }, [sys, refresh]);

  const send = useCallback(async (text) => {
    if (!text.trim()) return;
    push({ role: 'me', text });
    const r = await api('/api/chat', { message: text });
    push({ role: 'bot', text: r.reply || '…' });
    refresh();
  }, [push, refresh]);

  const control = useCallback((action) => api('/api/control', { action }), []);
  const setPairedTyping = useCallback(async (enabled) => {
    const r = await api('/api/paired-typing', { enabled });
    if (r.error) sys(`couldn't change paired typing — ${r.error}`);
    else setPairedTypingState(r);
    return r;
  }, [sys]);
  return { connected, running, pairedTyping, chat, enableControl, send, control, setPairedTyping };
}
