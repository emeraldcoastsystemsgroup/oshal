import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice command intake via the browser's built-in Speech Recognition (Chrome).
 * No backend, no key. Toggle listening; onFinal(text) fires with the spoken
 * command. interim holds the live partial transcript for display.
 */
export function useVoice(onFinal) {
  const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const [supported] = useState(Boolean(Rec));
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recRef = useRef(null);

  useEffect(() => {
    if (!Rec) return;
    const rec = new Rec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      let finalText = '';
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else partial += t;
      }
      setInterim(partial);
      if (finalText) { setInterim(''); onFinal(finalText.trim()); }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return () => { try { rec.abort(); } catch { /* ignore */ } };
  }, [Rec, onFinal]);

  const toggle = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) { rec.stop(); setListening(false); }
    else { setInterim(''); try { rec.start(); setListening(true); } catch { /* already started */ } }
  }, [listening]);

  return { supported, listening, interim, toggle };
}
