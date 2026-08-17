/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verify the domain-agnostic Jarvis stage can materialize an arbitrary image artifact, fall back safely, and reverse into the ambient cloud.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the midnight presentation plane required by transparent light-on-dark artifacts when Jarvis runs under a light cockpit theme.
 */

import path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'src', 'api', 'jarvis-stage.js');
const STYLE = path.join(ROOT, 'src', 'api', 'jarvis-stage.css');

/** @description Install the isolated DOM contract consumed by the browser response-stage module. */
async function mountStage(page: import('@playwright/test').Page): Promise<void> {
  await page.setContent(`
    <main id="root" class="response-stage" style="position:relative;width:960px;height:640px">
      <canvas id="canvas"></canvas>
      <img id="image" class="response-stage-image" alt="" />
      <div id="caption" class="response-stage-caption"></div>
      <div id="status" class="response-stage-status"></div>
    </main>
    <button id="discussion" style="position:absolute;right:10px;top:10px">Discussion</button>
  `);
  await page.addStyleTag({ path: STYLE });
  await page.addScriptTag({ path: SCRIPT });
  await page.evaluate(() => {
    const api = (window as unknown as { JarvisResponseStage: { mount: (input: unknown) => unknown } }).JarvisResponseStage;
    (window as unknown as { stageController: unknown }).stageController = api.mount({
      root: document.getElementById('root'),
      canvas: document.getElementById('canvas'),
      image: document.getElementById('image'),
      caption: document.getElementById('caption'),
      status: document.getElementById('status'),
      discussionTarget: document.getElementById('discussion'),
      config: { particleCount: 90, gatherMs: 1, revealMs: 1, archiveMs: 1 },
    });
  });
}

test.describe('Jarvis arbitrary-image response stage', () => {
  test('materializes any supplied image and archives it back to idle', async ({ page }) => {
    await mountStage(page);
    const result = await page.evaluate(async () => {
      const controller = (window as unknown as { stageController: {
        materialize: (input: unknown) => Promise<boolean>;
        archive: () => Promise<boolean>;
      } }).stageController;
      const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#101329"/><circle cx="210" cy="210" r="120" fill="#67c9ff"/><text x="380" y="235" fill="white" font-size="72">Anything</text></svg>');
      const shown = await controller.materialize({
        title: 'Arbitrary answer', spokenText: 'Here is the visual answer.',
        visual: { url: `data:image/svg+xml,${svg}`, alt: 'A blue circle beside the word Anything' },
      });
      const speaking = document.getElementById('root')?.dataset.state;
      const visible = document.getElementById('image')?.classList.contains('visible');
      const alt = document.getElementById('image')?.getAttribute('alt');
      const archived = await controller.archive();
      return { shown, speaking, visible, alt, archived, final: document.getElementById('root')?.dataset.state };
    });
    expect(result).toEqual({
      shown: true,
      speaking: 'speaking',
      visible: true,
      alt: 'A blue circle beside the word Anything',
      archived: true,
      final: 'idle',
    });
  });

  test('returns to the orb without manufacturing a text picture when the visual artifact cannot load', async ({ page }) => {
    await mountStage(page);
    const result = await page.evaluate(async () => {
      const controller = (window as unknown as { stageController: {
        materialize: (input: unknown) => Promise<boolean>;
      } }).stageController;
      const shown = await controller.materialize({
        title: 'Fallback answer', answer: 'The original answer remains available as text.',
        visual: { url: '/definitely-missing-visual.png', alt: 'Fallback answer visual' },
      });
      const image = document.getElementById('image') as HTMLImageElement;
      return { shown, state: document.getElementById('root')?.dataset.state, source: image.src, alt: image.alt };
    });
    expect(result.shown).toBe(false);
    expect(result.state).toBe('idle');
    expect(result.source).toBe('');
    expect(result.alt).toBe('');
  });

  test('keeps its mode, status, and busy state synchronized while speaking', async ({ page }) => {
    await mountStage(page);
    const result = await page.evaluate(async () => {
      const controller = (window as unknown as { stageController: {
        materialize: (input: unknown) => Promise<boolean>;
      } }).stageController;
      const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><text x="20" y="90" fill="white">Ready</text></svg>');
      await controller.materialize({
        spokenText: 'Ready to read.', visual: { url: `data:image/svg+xml,${svg}`, alt: 'Ready' },
      });
      const root = document.getElementById('root')!;
      return {
        state: root.dataset.state,
        busy: root.getAttribute('aria-busy'),
        status: document.getElementById('status')?.textContent,
      };
    });
    expect(result).toEqual({ state: 'speaking', busy: 'true', status: 'Jarvis is speaking' });
  });

  test('supplies a dark presentation plane for transparent artifacts on a light surface', async ({ page }) => {
    await mountStage(page);
    await page.evaluate(async () => {
      document.body.style.background = '#f0f2f8';
      const controller = (window as unknown as { stageController: {
        materialize: (input: unknown) => Promise<boolean>;
      } }).stageController;
      const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><text x="20" y="90" fill="#f5fbff">Readable</text></svg>');
      await controller.materialize({
        spokenText: 'Readable on daylight.', visual: { url: `data:image/svg+xml,${svg}`, alt: 'Readable' },
      });
    });
    const presentationStyle = () => page.evaluate(() => {
      const root = document.getElementById('root')!;
      const plane = getComputedStyle(root, '::before');
      return {
        backgroundColor: plane.backgroundColor,
        opacity: plane.opacity,
        captionColor: getComputedStyle(document.getElementById('caption')!).color,
      };
    });
    await expect.poll(presentationStyle).toEqual({
      backgroundColor: 'rgb(7, 17, 31)', opacity: '1', captionColor: 'rgb(245, 251, 255)',
    });

    await page.evaluate(() => (window as unknown as { stageController: {
      archive: () => Promise<boolean>;
    } }).stageController.archive());
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('root')!, '::before').opacity)).toBe('0');
  });
});
