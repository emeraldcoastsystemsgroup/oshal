/**
 * Pumpkin's public demo is intentionally interactive in the browser while remaining Tier-B on
 * the server. This pins the cross-repository integration seams owned by the OSHAL kernel.
 */
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('Pumpkin browser-local public demo', () => {
  it('lets an opted-in iframe receive taps and lets its projector popup escape the sandbox', () => {
    const controller = read('src/pages/cockpit/js/cockpit-view-controller.js');
    expect(controller).toContain("dataset?.guestLocalDemo === 'true'");
    expect(controller).toContain('allow-popups-to-escape-sandbox');
  });

  it('has a projector path that uses a local channel and never sets up a server room in demo mode', () => {
    const projector = read('src/pages/pumpkin/pumpkin-app.js');
    expect(projector).toContain("demo: qs.get('demo') === '1'");
    expect(projector).toContain('new window.BroadcastChannel(channel)');
    expect(projector).toMatch(/function setupPaired\(\) \{\s*if \(S\.demo\)[\s\S]*?return;\s*\}/);
    expect(projector).toContain('browserOnly: S.demo');
  });

  it('browserOnly speech bypasses the voice API', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('voice API must not be called')));
    const context: any = {
      window: {
        AudioContext: class { state = 'running'; resume() {} },
        speechSynthesis: { speak: vi.fn() },
        SpeechSynthesisUtterance: class {
          rate = 1;
          pitch = 1;
          onboundary?: () => void;
          onend?: () => void;
          constructor(public text: string) {}
        },
      },
      document: {},
      fetch: fetchSpy,
      Uint8Array,
      Blob,
      FormData,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(read('src/pages/pumpkin/pumpkin-audio.js'), context);
    const audio = new context.window.PumpkinAudio('');
    const localSpy = vi.spyOn(audio, '_speakBrowser');
    await audio.speak('Boo', { rate: 1 }, { browserOnly: true });
    expect(localSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honors a matching installed voice in browser fallback speech', () => {
    const spoken: any[] = [];
    const installed = [
      { name: 'Computer Default', voiceURI: 'default', lang: 'en-US' },
      { name: 'Charon', voiceURI: 'charon', lang: 'en-US' },
    ];
    const context: any = {
      window: {
        speechSynthesis: {
          getVoices: () => installed,
          speak: (utterance: any) => spoken.push(utterance),
        },
        SpeechSynthesisUtterance: class {
          rate = 1;
          pitch = 1;
          voice?: any;
          constructor(public text: string) {}
        },
      },
      document: {},
      Uint8Array,
      Blob,
      FormData,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(read('src/pages/pumpkin/pumpkin-audio.js'), context);
    const audio = new context.window.PumpkinAudio('');
    audio._speakBrowser('Boo', { voiceId: 'Charon', rate: 0.9 }, {});
    expect(spoken[0].voice).toBe(installed[1]);
    expect(spoken[0].rate).toBe(0.9);
  });

  it('deterministically maps cloud-only preset names to installed browser voices', () => {
    const spoken: any[] = [];
    const installed = [
      { name: 'English One', voiceURI: 'one', lang: 'en-US' },
      { name: 'English Two', voiceURI: 'two', lang: 'en-GB' },
      { name: 'French', voiceURI: 'fr', lang: 'fr-FR' },
    ];
    const context: any = {
      window: {
        speechSynthesis: {
          getVoices: () => installed,
          speak: (utterance: any) => spoken.push(utterance),
        },
        SpeechSynthesisUtterance: class {
          rate = 1;
          pitch = 1;
          voice?: any;
          constructor(public text: string) {}
        },
      },
      document: {}, Uint8Array, Blob, FormData, setTimeout, clearTimeout,
    };
    vm.runInNewContext(read('src/pages/pumpkin/pumpkin-audio.js'), context);
    const audio = new context.window.PumpkinAudio('');
    audio._speakBrowser('Boo', { voiceId: 'Fenrir' }, {});
    audio._speakBrowser('Again', { voiceId: 'Fenrir' }, {});
    expect(spoken[0].voice).toBe(spoken[1].voice);
    expect(spoken[0].voice.lang).toMatch(/^en-/);
    expect(spoken[0].pitch).not.toBe(0.7);
  });
});
