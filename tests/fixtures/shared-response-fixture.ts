/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared-response-renderer browser fixture: the one untrusted reply every consumer renders (the renderer's own SHARED_UNTRUSTED_RESPONSE conformance vector), the REAL renderer bundled from source the way vite.config.ts bundles it, the REAL vendored mermaid runtime produced by vite.config.ts's own vendorMermaidRuntime into a temp dir, a same-origin chat harness around the REAL swarmbot-messages.js bubble module, and the in-page block normalizer both surfaces are compared with.
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Route } from 'playwright';
import { SHARED_UNTRUSTED_RESPONSE } from '../../src/shared/ui/response-renderer';
import { vendorMermaidRuntime } from '../../vite.config';

const ROOT = path.resolve(__dirname, '../..');

/** One expected top-level block: its renderer role and, for a fallback, the typed kind it kept. */
export interface ExpectedBlock { role: string; kind: string | null }

/** One rendered top-level block as a surface's DOM shows it, normalized for comparison. */
export interface RenderedBlock extends ExpectedBlock { text: string }

/** The shared untrusted reply plus the block sequence every surface must produce from it. */
export interface SharedUntrustedResponse {
  text: string;
  hostileHost: string;
  expectedBlocks: ExpectedBlock[];
}

/**
 * @description The shared untrusted reply — the renderer's own published conformance vector, so
 * this guard and the store's Tutor proof (which reads it from the served bundle) use the same bytes.
 * @returns The reply text, the hostile host and the expected block sequence.
 */
export function loadSharedUntrustedResponse(): SharedUntrustedResponse {
  const { text, hostileHost, expectedBlocks } = SHARED_UNTRUSTED_RESPONSE;
  return { text, hostileHost, expectedBlocks: expectedBlocks.map((block) => ({ ...block })) };
}

/**
 * @description Bundle the REAL response-renderer barrel as the browser ES module vite serves at
 * /dist/response-renderer.js, so the guard exercises current source rather than a stale build.
 * @returns The ES-module bundle source.
 */
export async function bundleResponseRenderer(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(ROOT, 'src/shared/ui/response-renderer/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    alias: { '@': path.join(ROOT, 'src') },
  });
  return result.outputFiles[0].text;
}

/** A vendored mermaid runtime in a disposable directory, as the build would serve it. */
export interface VendoredMermaid { dir: string; files: number; version: string; dispose: () => void }

/**
 * @description Run the build's own vendoring step into a temp output directory, so the browser
 * loads exactly the files `npm run build:chat` would publish under /dist/vendor/mermaid.
 * @returns The vendored directory, its file count/version, and a disposer.
 */
export function vendorMermaidForTest(): VendoredMermaid {
  const outDir = mkdtempSync(path.join(tmpdir(), 'oshal-mermaid-vendor-'));
  const { files, version } = vendorMermaidRuntime(outDir);
  return {
    dir: path.join(outDir, 'vendor', 'mermaid'), files, version,
    dispose: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

/**
 * @description Serve one file from the vendored mermaid directory for a /dist/vendor/mermaid/*
 * request. Path segments are resolved beneath the vendored root only; anything else 404s.
 * @param route - The intercepted route.
 * @param vendoredDir - The vendored mermaid directory.
 * @returns Promise resolving once the route is fulfilled.
 */
export async function fulfillVendoredMermaid(route: Route, vendoredDir: string): Promise<void> {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice('/dist/vendor/mermaid/'.length));
  const file = path.resolve(vendoredDir, rel);
  if (!file.startsWith(path.resolve(vendoredDir) + path.sep)) return route.fulfill({ status: 404, body: '' });
  try {
    return await route.fulfill({ contentType: 'application/javascript', body: readFileSync(file) });
  } catch {
    return route.fulfill({ status: 404, body: '' });
  }
}

/** The chat harness page: an empty message list driven by the REAL bubble module. */
export const CHAT_HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>chat harness</title></head>
<body><div id="messages"></div>
<script type="module">
import { appendMessage } from '/swarmbot/chat/swarmbot-messages.js';
window.__appendAssistant = (text) => appendMessage(document.getElementById('messages'), 'assistant', 'Swarm bot', text);
window.__harnessReady = true;
</script></body></html>`;

/**
 * @description Serve the chat harness and the real swarm-bot chat modules off disk.
 * @param route - The intercepted route.
 * @param bundle - The response-renderer bundle to serve at /dist/response-renderer.js.
 * @returns True when this function fulfilled the route.
 */
export async function fulfillChatHarness(route: Route, bundle: string): Promise<boolean> {
  const pathname = new URL(route.request().url()).pathname;
  const js = (file: string) => route.fulfill({ contentType: 'application/javascript', body: readFileSync(path.join(ROOT, file)) });
  if (pathname === '/chat-harness') { await route.fulfill({ contentType: 'text/html', body: CHAT_HARNESS_HTML }); return true; }
  if (pathname === '/swarmbot/chat/swarmbot-messages.js') { await js('src/pages/swarmbot-chat/swarmbot-messages.js'); return true; }
  if (pathname === '/swarmbot/shared/ui-debug.js') { await js('src/pages/shared/ui-debug.js'); return true; }
  if (pathname === '/dist/response-renderer.js') { await route.fulfill({ contentType: 'application/javascript', body: bundle }); return true; }
  return false;
}

/**
 * @description Normalize the top-level shared-renderer blocks inside a container: renderer role
 * (or `fallback`), the typed kind a fallback kept, and whitespace-collapsed text. A mermaid block
 * reports its `data-mermaid` source, which survives hydration into an SVG.
 * @param container - The surface's answer container.
 * @returns The ordered normalized blocks.
 */
export function renderedBlockSequence(container: Locator): Promise<RenderedBlock[]> {
  return container.evaluate((root) => {
    const roles = ['markdown', 'code', 'mermaid', 'chart', 'table', 'map', 'doc', 'gallery', 'download'];
    const blocks = Array.from(root.querySelectorAll('.rr-block'))
      .filter((el) => !el.parentElement || !el.parentElement.closest('.rr-block'));
    return blocks.map((el) => {
      const role = el.classList.contains('rr-fallback')
        ? 'fallback'
        : (roles.find((name) => el.classList.contains(`rr-${name}`)) || 'unknown');
      const source = el.getAttribute('data-mermaid');
      return {
        role,
        kind: el.getAttribute('data-oshal-kind'),
        text: source !== null ? source : String(el.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    });
  });
}
