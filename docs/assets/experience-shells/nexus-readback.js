/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: speaking-core readback that drives the particle core from the bundled prerecorded sample; no speech service or microphone.
 */
/* Local prerecorded sample only. No speech service, microphone or swarm calls. */
(() => {
 'use strict';
 const asset = window.NexusReadbackAudio;
 let context, analyser, samples, bufferPromise, source, frame, watchdog;
 let generation = 0, phase = 'idle', level = 0, status = 'LOCAL SAMPLE VOICE · NO MICROPHONE';
 let startTime = 0, duration = 0;

 function paint() {
  const box = document.querySelector('.readback');
  if (!box) return;
  const active = phase === 'loading' || phase === 'speaking';
  box.dataset.state = phase;
  box.querySelector('[data-action="readback"]').textContent = active ? '■ Stop readback' : '▶ Play readback';
  box.querySelector('[data-action="readback"]').setAttribute('aria-pressed', String(active));
  box.querySelector('.readback-status').textContent = phase === 'speaking' && box.dataset.reduced === 'true' ? 'SPEAKING · VISUAL MOTION IS OFF' : status;
 }

 function meter() {
  if (phase !== 'speaking') return;
  analyser.getFloatTimeDomainData(samples);
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const target = Math.min(1, Math.max(0, rms - .003) * 8);
  level += (target - level) * (target > level ? .5 : .2);
  const box = document.querySelector('.readback');
  if (box) {
   box.style.setProperty('--voice-level', level.toFixed(3));
   box.style.setProperty('--readback-progress', Math.min(1, (context.currentTime - startTime) / duration).toFixed(3));
  }
  frame = requestAnimationFrame(meter);
 }

 function stop(message = 'STOPPED · READY WHEN YOU ARE') {
  generation++;
  clearTimeout(watchdog);
  cancelAnimationFrame(frame);
  if (source) {
   source.onended = null;
   try { source.stop(); } catch { /* A naturally ended source may already be stopped. */ }
   source.disconnect();
   source = null;
  }
  level = 0;
  phase = 'idle';
  status = message;
  if (context?.state === 'running') context.suspend().catch(() => {});
  const box = document.querySelector('.readback');
  box?.style.setProperty('--voice-level', '0');
  box?.style.setProperty('--readback-progress', '0');
  paint();
 }

 async function play() {
  if (phase === 'loading' || phase === 'speaking') { stop(); return; }
  const ticket = ++generation;
  phase = 'loading';
  status = 'PREPARING LOCAL SAMPLE…';
  paint();
  watchdog = setTimeout(() => {
   if (ticket === generation) stop('AUDIO DID NOT START · PRESS PLAY TO RETRY');
  }, 8000);
  try {
   const Audio = window.AudioContext || window.webkitAudioContext;
   if (!Audio || !asset) throw new Error('Local audio unavailable');
   if (!context || context.state === 'closed') {
    context = new Audio();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Float32Array(analyser.fftSize);
    analyser.connect(context.destination);
   }
   if (!bufferPromise) {
    const bytes = Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0));
    bufferPromise = context.decodeAudioData(bytes.buffer);
    bufferPromise.catch(() => { bufferPromise = null; });
   }
   // Resume inside the click gesture. Decoding runs locally, including from file://.
   const resumed = context.resume();
   const [buffer] = await Promise.all([bufferPromise, resumed]);
   if (ticket !== generation || document.hidden) return;
   if (!buffer || context.state !== 'running') throw new Error('Audio blocked');
   source = context.createBufferSource();
   source.buffer = buffer;
   source.connect(analyser);
   source.onended = () => {
    if (ticket === generation) stop('READBACK COMPLETE · READY WHEN YOU ARE');
   };
   startTime = context.currentTime;
   duration = buffer.duration;
   source.start();
   clearTimeout(watchdog);
   phase = 'speaking';
   status = 'SPEAKING · PARTICLES FOLLOW THE SOUND';
   paint();
   meter();
  } catch {
   if (ticket === generation) {
    stop('AUDIO UNAVAILABLE · TRANSCRIPT BELOW');
    document.querySelector('.readback details')?.setAttribute('open', '');
   }
  }
 }

 document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase !== 'idle') stop('PAUSED WHILE AWAY · PRESS PLAY TO RESTART');
 });
 window.addEventListener('pagehide', () => stop());
 window.NexusReadback = Object.freeze({
  play, stop, paint,
  get level() { return level; },
  get active() { return phase === 'speaking'; },
  get pending() { return phase === 'loading'; },
  get transcript() { return asset?.transcript || 'Local sample unavailable.'; }
 });
})();
