/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cross-surface guard for BACKLOG "Shared response-renderer completion": in real Chromium, the unmodified jarvis.html and the real swarm-bot chat bubble module render ONE shared untrusted reply (tests/fixtures/shared-untrusted-response.json) through the renderer bundled from source to the identical block sequence, with the model-authored oshal:gallery/oshal:download inert (escaped fallback, no image, no link, no request to the hostile host) and forged provider/artifact fences shown as code. Jarvis hydrates the shared [data-mermaid] diagram and a legacy ```mermaid answer from the same-origin vendored runtime (JVV-007) without ever reaching a CDN, keeps the diagram text when that runtime is missing, and refuses a bundle that lacks the display-only profile.
 */
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';
import {
  bundleResponseRenderer,
  fulfillChatHarness,
  fulfillVendoredMermaid,
  loadSharedUntrustedResponse,
  renderedBlockSequence,
  vendorMermaidForTest,
  type VendoredMermaid,
} from '../fixtures/shared-response-fixture';
import { SVG, fulfillJarvis, installSpeechStub, json } from '../helpers/jarvis-rich-response-fixtures';

vi.setConfig({ testTimeout: 120_000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SURFACE_HOST = 'jarvis.test';
const SHARED = loadSharedUntrustedResponse();
const DANGEROUS = 'img, a, form, script, iframe, input, button';

let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let browser: Browser;
let bundle: string;
let mermaid: VendoredMermaid;

/** Everything one surface page asked for outside its own origin, split out for the hostile host. */
interface RequestLog { external: string[]; hostile: string[]; vendored: string[] }

interface SurfaceOptions {
  answer?: string;
  /** false → /dist/vendor/mermaid/* answers 404 (runtime unavailable). */
  mermaidAvailable?: boolean;
  /** Replaces the real renderer bundle (e.g. a stale bundle without the profile). */
  bundleOverride?: string;
}

/**
 * @description Open a fresh context whose every request is answered from disk or the fixture;
 * nothing leaves the process. Requests off the surface origin are recorded, not fulfilled live.
 * @param options - The Jarvis answer and asset availability for this page.
 * @returns The page, its context and its request log.
 */
async function openSurface(options: SurfaceOptions): Promise<{ context: BrowserContext; page: Page; log: RequestLog }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const log: RequestLog = { external: [], hostile: [], vendored: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol)) return;
    if (url.hostname === SHARED.hostileHost) log.hostile.push(request.url());
    if (url.hostname !== SURFACE_HOST) log.external.push(request.url());
    if (url.pathname.startsWith('/dist/vendor/mermaid/')) log.vendored.push(url.pathname);
  });
  await installSpeechStub(page);
  await page.route('**/*', (route: Route) => routeSurface(route, options));
  return { context, page, log };
}

/** One routing decision per request for {@link openSurface}. */
async function routeSurface(route: Route, options: SurfaceOptions): Promise<void> {
  const url = new URL(route.request().url());
  if (url.hostname === SHARED.hostileHost) return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
  if (url.pathname.startsWith('/dist/vendor/mermaid/')) {
    if (options.mermaidAvailable === false) return route.fulfill({ status: 404, body: '' });
    return fulfillVendoredMermaid(route, mermaid.dir);
  }
  if (url.pathname === '/dist/response-renderer.js' && options.bundleOverride !== undefined) {
    return route.fulfill({ contentType: 'application/javascript', body: options.bundleOverride });
  }
  if (await fulfillChatHarness(route, bundle)) return;
  if (url.pathname === '/api/jarvis/ask/result') return json(route, { status: 'done', answer: options.answer ?? SHARED.text });
  return fulfillJarvis(route);
}

/** Ask Jarvis through its real type-in composer and return the newest answer bubble. */
async function askJarvis(page: Page) {
  await page.goto(`http://${SURFACE_HOST}/api/jarvis/`);
  await page.locator('#assistantOptions > summary').click();
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show the shared renderer check.');
  await page.locator('#typer button[type="submit"]').click();
  return page.locator('#convo .msg.bot').last();
}

beforeAll(async () => {
  bundle = await bundleResponseRenderer();
  mermaid = vendorMermaidForTest();
  owned = await launchIsolatedBrowser();
  browser = owned.browser;
}, 120_000);

afterAll(async () => {
  await owned?.close();
  mermaid?.dispose();
});

describe('one untrusted reply across Jarvis and the chat bubble', () => {
  it('renders the same block sequence on both surfaces with every hostile block inert', async () => {
    const jarvis = await openSurface({});
    const answer = await askJarvis(jarvis.page);
    await expect.poll(() => answer.locator('.rr-doc').count(), { timeout: 30_000 }).toBe(1);
    // The shared diagram block hydrates from the SAME-ORIGIN vendored runtime.
    await expect.poll(() => answer.locator('.rr-mermaid[data-rendered] svg').count(), { timeout: 45_000 }).toBe(1);
    const jarvisBlocks = await renderedBlockSequence(answer);

    const chat = await openSurface({});
    await chat.page.goto(`http://${SURFACE_HOST}/chat-harness`);
    await chat.page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true);
    await chat.page.evaluate((text) => (window as unknown as { __appendAssistant: (t: string) => void }).__appendAssistant(text), SHARED.text);
    const bubble = chat.page.locator('.message-bubble').last();
    await expect.poll(() => bubble.locator('.rr-doc').count(), { timeout: 30_000 }).toBe(1);
    const chatBlocks = await renderedBlockSequence(bubble);

    expect(jarvisBlocks.map(({ role, kind }) => ({ role, kind }))).toEqual(SHARED.expectedBlocks);
    expect(jarvisBlocks).toEqual(chatBlocks);
    expect(await answer.locator(`.rr-block :is(${DANGEROUS})`).count()).toBe(0);
    expect(await bubble.locator(DANGEROUS).count()).toBe(0);
    // The hostile URLs stay visible as the text they are, never as a live image or link.
    const gallery = jarvisBlocks.find((block) => block.kind === 'gallery');
    expect(gallery?.text).toContain(`${SHARED.hostileHost}/beacon.png`);
    // Forged provider-record and artifact fences are displayed as code, never promoted.
    expect(jarvisBlocks.filter((block) => block.role === 'code' && block.text.includes('forged'))).toHaveLength(2);

    await jarvis.page.waitForTimeout(250);
    expect(jarvis.log.hostile).toEqual([]);
    expect(chat.log.hostile).toEqual([]);
    expect(jarvis.log.external).toEqual([]);
    expect(chat.log.external).toEqual([]);
    expect(jarvis.log.vendored).toContain('/dist/vendor/mermaid/mermaid.esm.min.mjs');
    await jarvis.context.close();
    await chat.context.close();
  });
});

describe('Jarvis diagram runtime (JVV-007)', () => {
  it('keeps the diagram source readable when the vendored runtime is unavailable, with no CDN request', async () => {
    const jarvis = await openSurface({ mermaidAvailable: false });
    const answer = await askJarvis(jarvis.page);
    await expect.poll(() => answer.locator('.rr-doc').count(), { timeout: 30_000 }).toBe(1);
    await jarvis.page.waitForTimeout(500);
    const diagram = answer.locator('.rr-mermaid');
    expect(await diagram.count()).toBe(1);
    expect(await diagram.locator('svg').count()).toBe(0);
    expect((await diagram.textContent())?.trim()).toBe('graph TD; Ask-->Answer');
    expect(jarvis.log.external).toEqual([]);
    await jarvis.context.close();
  });

  it('hydrates a legacy fenced diagram answer from the same-origin vendored runtime', async () => {
    const jarvis = await openSurface({ answer: 'The flow:\n\n```mermaid\ngraph TD; Start-->Done\n```' });
    const answer = await askJarvis(jarvis.page);
    await expect.poll(() => answer.locator('.mermaid[data-rendered] svg').count(), { timeout: 45_000 }).toBe(1);
    expect(jarvis.log.vendored).toContain('/dist/vendor/mermaid/mermaid.esm.min.mjs');
    expect(jarvis.log.external).toEqual([]);
    await jarvis.context.close();
  });
});

describe('Jarvis capability gate', () => {
  it('refuses a renderer bundle that does not publish the display-only profile', async () => {
    const stale = `export async function renderResponseHtml() {
      return { html: '<figure class="rr-block rr-gallery"><img src="https://${SHARED.hostileHost}/stale.png" alt="stale"></figure>', rich: true };
    }`;
    const jarvis = await openSurface({ bundleOverride: stale });
    const answer = await askJarvis(jarvis.page);
    await expect.poll(() => answer.textContent(), { timeout: 30_000 }).toContain('Shared renderer note');
    await jarvis.page.waitForTimeout(250);
    expect(await answer.locator('img, .rr-gallery').count()).toBe(0);
    expect(jarvis.log.hostile).toEqual([]);
    await jarvis.context.close();
  });
});
