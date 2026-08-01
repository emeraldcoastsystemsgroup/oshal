import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useBackend } from './useBackend.js';
import { useVoice } from './useVoice.js';

export default function App() {
  const { connected, running, pairedTyping, chat, enableControl, send, control, setPairedTyping } = useBackend();
  const [input, setInput] = useState('');
  const [enabling, setEnabling] = useState(false);

  const submit = useCallback((text) => { const t = (text ?? input).trim(); if (!t) return; setInput(''); send(t); }, [input, send]);
  const voice = useVoice(useCallback((spoken) => submit(spoken), [submit]));

  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [chat]);

  return (
    <div className="app">
      <header>
        <div className="logo" />
        <h1>Vids Operator</h1>
        <div className="status">
          <span className={`dot ${connected ? 'on' : ''}`} />
          {connected ? 'in control' : 'idle'}
          {running && <span className="run">working…</span>}
        </div>
        {running ? (
          <button className="stop" onClick={() => control('abort')}>Stop</button>
        ) : !connected ? (
          <button className="primary" disabled={enabling} onClick={async () => { setEnabling(true); await enableControl(); setEnabling(false); }}>
            {enabling ? 'Enabling…' : 'Enable control'}
          </button>
        ) : null}
        {connected && !running && (
          <button
            className={pairedTyping.enabled ? 'paired on' : 'paired'}
            onClick={() => setPairedTyping(!pairedTyping.enabled)}
            title="Each ordinary keypress types the next prepared character"
          >
            {pairedTyping.enabled ? 'Paired typing on' : 'Pair typing'}
          </button>
        )}
      </header>

      <div className="chat" ref={ref}>
        {chat.map((m, i) => <div className={`msg ${m.role}`} key={i}>{m.text}</div>)}
      </div>

      <div className="composer">
        <button
          className={`mic ${voice.listening ? 'live' : ''}`}
          title={voice.supported ? 'Speak a command' : 'Voice not supported in this browser'}
          disabled={!voice.supported}
          onClick={voice.toggle}
        >{voice.listening ? '●' : '🎙'}</button>
        <input
          value={voice.listening && voice.interim ? voice.interim : input}
          placeholder={voice.listening ? 'listening…' : 'Tell me what to do…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        <button className="primary" onClick={() => submit()}>Send</button>
      </div>
      {running && pairedTyping.enabled && (
        <div className={`footnote ${pairedTyping.status === 'paused' ? 'paused' : ''}`}>
          {pairedTyping.status === 'typing'
            ? `Paired typing ${pairedTyping.completed}/${pairedTyping.total} — press ordinary keys; F8 pauses and F9 cancels`
            : pairedTyping.status === 'paused'
              ? `Paired typing paused (${pairedTyping.reason || 'operator'}) — press F8 to resume`
              : 'I’m reading the screen and moving to the next field…'}
        </div>
      )}
      {running && !pairedTyping.enabled && <div className="footnote">I'm driving the mouse — keep your hands off. Hit Stop to take over.</div>}
    </div>
  );
}
