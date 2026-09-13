/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove one shared STL renderer through both actual application pages: real shaders, first frame, parsing, controls, lifecycle and clear upgrade errors.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type BrowserContext, type Page } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { boxStl, CONSUMERS, hasStore, observeStlRendering, observeViewerListeners, startStlViewerFixture } from '../fixtures/stl-viewer';
import { launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ testTimeout: 20_000 });
let fixture: Awaited<ReturnType<typeof startStlViewerFixture>>, owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let context: BrowserContext, page: Page;
let pageErrors: string[];
beforeAll(async () => {
  if (!hasStore) return;
  fixture = await startStlViewerFixture();
  owned = await launchIsolatedBrowser({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
afterEach(async () => {
  try { if (pageErrors) expect(pageErrors).toEqual([]); }
  finally { await context?.close(); }
});
afterAll(async () => {
  if (!hasStore) return;
  try {
    try { expect(fixture.requests.filter(value => !value.startsWith('GET '))).toEqual([]); }
    finally { await writeFile(`temp/shared-stl-viewer-cleanup-${process.pid}.json`, JSON.stringify(await owned.close(), null, 2)); }
  } finally { await fixture.close(); }
}, 30_000);

/** @description Open unmodified shipped HTML and app boot, revealing its existing empty preview for component checks. */
async function open(slug: string) {
  context = await owned.browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(observeStlRendering);
  await context.addInitScript(observeViewerListeners);
  page = await context.newPage(); page.setDefaultTimeout(4000); pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(fixture.origin + `/api/${slug}/app`);
  await page.locator(slug === 'cad-studio' ? '#model-list' : '#job-list').getByText(/No (parts|objects)/).waitFor();
  await page.locator('#viewer').evaluate(canvas => {
    for (let node: HTMLElement | null = canvas as HTMLElement; node; node = node.parentElement) node.hidden = false;
  });
  await page.locator('#viewer').scrollIntoViewIfNeeded();
}

/** @description Two real animation frames drain an invalidation without sleeping or fabricating GL readiness. */
async function frames() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }

/** @description The consumer alias mounts the actual shared renderer on its shipped canvas. */
async function load(alias: 'ScanToPrintViewer' | 'CadStudioViewer', width = 60, binary = false) {
  const result = await page.evaluate(({ name, bytes }) => {
    window.fixtureViewer ||= window[name].mount(document.querySelector<HTMLCanvasElement>('#viewer')!);
    return window.fixtureViewer.load(new Uint8Array(bytes).buffer);
  }, { name: alias, bytes: boxStl(width, binary) });
  await frames();
  return result;
}

/** @description Return observations only after original drawArrays and readPixels have completed. */
async function lastFrame() { return page.evaluate(() => window.stlProof.frames.at(-1)!); }

for (const consumer of CONSUMERS) {
  const check = (title: string, run: () => Promise<void>) => it.skipIf(!hasStore)(`${consumer.label} shared STL: ${title} (requires sibling public store)`, run);
  check('compiles real shaders and immediately draws mesh triangles and shaded pixels', async () => {
    await open(consumer.slug);
    expect(await load(consumer.alias)).toEqual({ triangles: 12, size: [60, 40, 30] });
    const proof = await page.evaluate(() => ({ version: window.OSHALStlViewer.apiVersion, ...window.stlProof }));
    expect(proof.version).toBe(1); expect(proof.shaders).toEqual([true, true]); expect(proof.links).toEqual([true]);
    expect(proof.lines).toEqual([60]);
    expect(proof.uploads.at(-1)!.slice(0, 15)).toEqual([-70, -70, 0, 70, -70, 0, -70, -70, 0, -70, 70, 0, -70, -60, 0]);
    expect(proof.frames).toHaveLength(1); expect(proof.frames[0].count).toBe(36);
    expect(proof.frames[0].opaque).toBeGreaterThan(100); expect(proof.frames[0].colors).toBeGreaterThan(20);
    const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
    expect(scripts.indexOf('/shared/ui/js/stl-viewer.js')).toBeLessThan(scripts.indexOf(`/api/${consumer.slug}/assets/${consumer.slug}-gl.js`));
    await frames(); expect(await page.evaluate(() => window.stlProof.frames.length)).toBe(1);
    await page.locator('#viewer').screenshot({ path: `temp/shared-stl-viewer-${consumer.slug}.png` });
  });

  check('parses equivalent ASCII and binary STL through the existing consumer alias', async () => {
    await open(consumer.slug);
    const result = await page.evaluate(({ alias, ascii, binary }) => {
      const a = window[alias].parseStl(new Uint8Array(ascii).buffer), b = window[alias].parseStl(new Uint8Array(binary).buffer);
      return { a: a.triangles, b: b.triangles, positions: Array.from(a.positions), binaryPositions: Array.from(b.positions),
        normals: Array.from(a.normals), binaryNormals: Array.from(b.normals) };
    }, { alias: consumer.alias, ascii: boxStl(), binary: boxStl(60, true) });
    expect(result.a).toBe(12); expect(result.b).toBe(12);
    expect(result.positions).toEqual(result.binaryPositions); expect(result.normals).toEqual(result.binaryNormals);
  });

  check('resizes once, clears without stale triangles and reloads new geometry', async () => {
    await open(consumer.slug); await load(consumer.alias);
    const before = await lastFrame();
    await page.locator('#viewer').evaluate(canvas => { (canvas as HTMLElement).style.width = '320px'; window.fixtureViewer.resize(); window.fixtureViewer.resize(); });
    await frames(); const resized = await lastFrame();
    expect(resized.width).not.toBe(before.width); expect(resized.width).toBe(await page.locator('#viewer').evaluate(canvas => canvas.clientWidth * devicePixelRatio));
    const counts = await page.evaluate(() => ({ frames: window.stlProof.frames.length, clears: window.stlProof.clears }));
    await page.evaluate(() => window.fixtureViewer.clear()); await frames();
    expect(await page.evaluate(() => window.stlProof.frames.length)).toBe(counts.frames);
    expect(await page.evaluate(() => window.stlProof.clears)).toBe(counts.clears + 1);
    expect(await load(consumer.alias, 80, true)).toEqual({ triangles: 12, size: [80, 40, 30] });
    expect((await lastFrame()).count).toBe(36); expect((await lastFrame()).opaque).toBeGreaterThan(100);
  });

  check('orbits, pans and clamps zoom without starting a continuous draw loop', async () => {
    await open(consumer.slug); await load(consumer.alias);
    const before = await lastFrame(), box = (await page.locator('#viewer').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
    await page.mouse.move(box.x + 110, box.y + 75); await page.mouse.up(); await frames();
    const orbit = await lastFrame(); expect(orbit.matrix).not.toEqual(before.matrix);
    await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + 90);
    await page.mouse.up(); await page.keyboard.up('Shift'); await frames();
    expect((await lastFrame()).matrix).not.toEqual(orbit.matrix);
    for (const delta of [100, -100]) {
      await page.locator('#viewer').evaluate((canvas, value) => {
        for (let i = 0; i < 100; i += 1) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: value, cancelable: true }));
      }, delta);
      await frames(); const limit = await lastFrame();
      await page.mouse.wheel(0, delta); await frames();
      expect((await lastFrame()).matrix).toEqual(limit.matrix);
      expect(limit.matrix.every(Number.isFinite)).toBe(true);
    }
    const count = await page.evaluate(() => window.stlProof.frames.length);
    await frames(); expect(await page.evaluate(() => window.stlProof.frames.length)).toBe(count);
  });

  check('refuses nonfinite mesh data and bounds the grid for enormous finite parts', async () => {
    await open(consumer.slug); await load(consumer.alias);
    const bad = new TextEncoder().encode('solid invalid\nfacet normal 0 0 1\nouter loop\nvertex 1e999 0 0\nvertex 0 40 0\nvertex 0 0 30\nendloop\nendfacet\nendsolid');
    const binary = new Uint8Array(boxStl(60, true)); new DataView(binary.buffer).setFloat32(96, Infinity, true);
    const result = await page.evaluate(({ alias, inputs }) => {
      const failures = [];
      for (const bytes of inputs) for (const method of ['parse', 'load']) {
        try { const data = new Uint8Array(bytes).buffer;
          if (method === 'parse') window[alias].parseStl(data); else window.fixtureViewer.load(data);
          failures.push('accepted'); } catch (error) { failures.push(String(error)); }
      }
      return failures;
    }, { alias: consumer.alias, inputs: [[...bad], [...binary]] });
    expect(result).toHaveLength(4);
    for (const error of result) expect(error).toMatch(/finite numbers/);
    await load(consumer.alias, 1_000_000, true);
    const proof = await page.evaluate(() => window.stlProof);
    expect(proof.lines.at(-1)).toBeLessThanOrEqual(804);
    expect(proof.uploads.at(-1)!.every(Number.isFinite)).toBe(true);
    expect(proof.frames.at(-1)!.count).toBe(36);
    await load(consumer.alias); expect((await lastFrame()).opaque).toBeGreaterThan(100);
  });

  check('disposes owned pending frames/listeners/buffers and supports a clean remount', async () => {
    await open(consumer.slug); await load(consumer.alias);
    expect(await page.evaluate(() => window.stlListeners)).toBe(7);
    const count = await page.evaluate(() => {
      const count = window.stlProof.frames.length;
      window.fixtureViewer.resize(); window.fixtureViewer.dispose(); window.fixtureViewer.dispose();
      window.dispatchEvent(new Event('resize'));
      document.getElementById('viewer')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      return count;
    });
    await frames();
    const proof = await page.evaluate(() => window.stlProof);
    expect(proof.frames).toHaveLength(count); expect(proof.deletedBuffers).toBe(3); expect(proof.deletedPrograms).toBe(1);
    expect(await page.evaluate(() => window.stlListeners)).toBe(0);
    expect(await page.evaluate(() => { try { window.fixtureViewer.load(new ArrayBuffer(0)); return ''; } catch (error) { return String(error); } })).toMatch(/disposed/);
    await page.evaluate(name => { window.fixtureViewer = window[name].mount(document.querySelector<HTMLCanvasElement>('#viewer')!); }, consumer.alias);
    await load(consumer.alias); expect((await lastFrame()).opaque).toBeGreaterThan(100);
    expect(await page.evaluate(() => window.stlProof.buffers - window.stlProof.deletedBuffers)).toBe(3);
  });

  for (const invalid of ['missing', 'incompatible'] as const) check(`gives a clear upgrade error for ${invalid} core assets`, async () => {
    context = await owned.browser.newContext();
    await context.route('**/shared/ui/js/stl-viewer.js', route => invalid === 'missing' ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'application/javascript', body: 'window.OSHALStlViewer={apiVersion:2};' }));
    page = await context.newPage(); pageErrors = [];
    await page.goto(fixture.origin + `/api/${consumer.slug}/app`);
    const errors = await page.evaluate(name => {
      return ['mount', 'parseStl'].map(method => {
        try { if (method === 'mount') window[name].mount(document.querySelector<HTMLCanvasElement>('#viewer')!);
          else window[name].parseStl(new ArrayBuffer(0)); return ''; } catch (error) { return String(error); }
      });
    }, consumer.alias);
    expect(errors).toEqual([expect.stringMatching(/updated OSHAL core.*STL viewer v1/), expect.stringMatching(/updated OSHAL core.*STL viewer v1/)]);
  });
}
