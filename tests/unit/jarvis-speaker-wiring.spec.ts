/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Jarvis surface, authenticated-asset, hot-swap, and push-to-talk speaker-capture wiring tests.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Loader update for the jarvis-ambient decomposition: `ambient` is now the concatenation of the four load-ordered classic scripts, and a wiring test pins each sibling into the asset allowlist, the compose hot-swap mounts, and jarvis.html in core→ui→recognition→coordinator order.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const html = read('src/api/jarvis.html');
// The ambient client is four load-ordered classic scripts (see jarvis.html).
const AMBIENT_FILES = [
  'jarvis-ambient-core.js',
  'jarvis-ambient-ui.js',
  'jarvis-ambient-recognition.js',
  'jarvis-ambient.js',
];
const ambient = AMBIENT_FILES.map((file) => read(`src/api/${file}`)).join('\n');
const capture = read('src/api/jarvis-speaker-capture.js');
const routes = read('src/app/routes/jarvis-routes.ts');
const compose = read('docker-compose.oshal-local.yml');

describe('Jarvis speaker surface wiring', () => {
  it('loads and mounts the profile panel and ephemeral capture client', () => {
    expect(html).toContain('/api/jarvis/assets/jarvis-speakers.css');
    expect(html).toContain('/api/jarvis/assets/jarvis-speakers.js');
    expect(html).toContain('/api/jarvis/assets/jarvis-speaker-capture.js');
    expect(html).toContain('window.JarvisSpeakers.mount');
    expect(html).toContain('window.JarvisSpeakerCapture.mount');
    expect(html).toContain('mountTarget: document.body');
    expect(ambient).toContain('data-ja-speakers-open');
  });

  it('pauses the diarization recorder while push-to-talk owns the microphone', () => {
    expect(html).toContain("'jarvis:speaker-capture-suspend'");
    expect(html).toContain("'jarvis:speaker-capture-resume'");
    expect(html).toContain("reason:'push-to-talk'");
  });

  it('suppresses ambient and speaker capture during the voice preview', () => {
    expect(html).toContain('u.onstart=()=>setAssistantSpeaking(true)');
    expect(html).toContain('u.onend=finishPreview');
    expect(html).toContain('setAssistantSpeaking(true); previewTimer=');
    expect(html).toContain('activeVoicePreviewFinish=finishPreview');
  });

  it('keeps the transcript acknowledgement deadline beyond the bounded audio request', () => {
    const acknowledgementMs = Number(ambient.match(/SPEAKER_ACK_TIMEOUT_MS = (\d+)/)?.[1]);
    const uploadMs = Number(capture.match(/UPLOAD_TIMEOUT_MS = (\d+)/)?.[1]);
    const chunkMs = Number(capture.match(/CHUNK_DURATION_MS = (\d+)/)?.[1]);
    expect(acknowledgementMs).toBeGreaterThan(uploadMs + chunkMs);
    expect(acknowledgementMs - uploadMs - chunkMs).toBeGreaterThanOrEqual(10000);
  });

  it('serves only explicitly authenticated assets and hot-swaps all three new files', () => {
    for (const file of ['jarvis-speakers.js', 'jarvis-speakers.css', 'jarvis-speaker-capture.js']) {
      expect(routes).toContain(`['${file}'`);
      expect(compose).toContain(`./src/api/${file}:/app/src/api/${file}:ro`);
    }
    expect(routes).toContain("router.get('/assets/:file', serveJarvisClientAsset(apiDir))");
  });

  it('serves, hot-swaps, and load-orders the four ambient decomposition scripts', () => {
    for (const file of AMBIENT_FILES) {
      expect(routes).toContain(`['${file}'`);
      expect(compose).toContain(`./src/api/${file}:/app/src/api/${file}:ro`);
      expect(html).toContain(`/api/jarvis/assets/${file}`);
    }
    // The coordinator needs the namespaces the siblings attach: core → ui → recognition → coordinator.
    const positions = AMBIENT_FILES.map((file) => html.indexOf(`/api/jarvis/assets/${file}"`));
    expect(positions.every((position, index) => position > (index ? positions[index - 1] : -1))).toBe(true);
  });

  it('wires the ADR-100 per-person insights consent panel end to end', () => {
    // allowlisted asset + hot-swap bind-mount so the panel serves and updates without a rebuild
    expect(routes).toContain("['jarvis-person-consent.js'");
    expect(compose).toContain('./src/api/jarvis-person-consent.js:/app/src/api/jarvis-person-consent.js:ro');
    // loaded and mounted on the surface, pointed at the live consent endpoints
    expect(html).toContain('/api/jarvis/assets/jarvis-person-consent.js');
    expect(html).toContain('window.JarvisPersonConsent.mount');
    expect(html).toContain("apiBase: '/api/jarvis/ambient/person'");
  });
});
