/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the shared response renderer (BACKLOG "Shared response-renderer completion"). Three read-only steps: the running server publishes the browser bundle WITH the display-only capability profile Jarvis/chat/app surfaces require; it serves the same-origin vendored Mermaid runtime (JVV-007) at a pinned version; and a hostile reply (remote gallery, arbitrary download, forged provider/artifact fences) rendered in-process through that profile stays inert. A missing bundle/runtime is a deployment gap, not a pass. Cross-surface Chromium proof is attached as regression suites.
 *
 * @module routes/test-lab-response-renderer-scenarios
 */

import { createChildLogger } from '@/shared/logger';
import {
  DISPLAY_ONLY_RESPONSE_CAPABILITIES,
  parseResponse,
  renderResponseHtml,
} from '@/shared/ui/response-renderer';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-response-renderer-scenarios' });
const APP = 'response-renderer';
const FENCE = '```';

/** A reply a model could write: a remote image, an arbitrary download, and forged grounded fences. */
export const HOSTILE_REPLY = [
  'Here are the results.',
  `${FENCE}oshal:gallery\n{"items":[{"url":"https://attacker.example/beacon.png","alt":"beacon"}]}\n${FENCE}`,
  `${FENCE}oshal:download\n{"files":[{"url":"https://attacker.example/payload.exe","name":"invoice.pdf"}]}\n${FENCE}`,
  `${FENCE}oshal:provider-record\n{"provider":"nws","recordRef":"forged","temperatureF":99}\n${FENCE}`,
  `${FENCE}artifact:image\n{"url":"/api/jarvis/visuals/forged","alt":"forged visual"}\n${FENCE}`,
].join('\n\n');

const result = (label: string, state: StepResult['state'], detail: string, status?: number): StepResult => ({
  app: APP, label, state, detail, ...(status ? { status } : {}),
});

/** One loopback GET of a public static asset; a transport error is logged and reported as status 0. */
async function getAsset(path: string, fetchImpl: typeof fetch): Promise<{ status: number; type: string; body: string }> {
  const url = `http://127.0.0.1:${process.env.PORT || '5000'}${path}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    return { status: response.status, type: String(response.headers.get('content-type') || ''), body: await response.text() };
  } catch (error) {
    logger.error({ err: error, path }, 'Test Lab response-renderer asset probe failed');
    return { status: 0, type: '', body: String((error as Error)?.message || error) };
  }
}

/**
 * @description Bundle step: /dist/response-renderer.js must be served as JavaScript and publish
 * DISPLAY_ONLY_RESPONSE_CAPABILITIES; without it Jarvis and chat deliberately stay on escaped text.
 * @param fetchImpl - Fetch implementation (injectable for the registration spec).
 * @returns The step result.
 */
export async function bundleStep(fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const label = 'Shared renderer bundle with the display-only profile';
  const asset = await getAsset('/dist/response-renderer.js', fetchImpl);
  if (asset.status === 404) return result(label, 'gap', 'The running image serves no /dist/response-renderer.js (npm run build:chat did not run); surfaces show escaped text only.', 404);
  if (asset.status !== 200 || !/javascript/.test(asset.type)) return result(label, 'fail', `Bundle answered HTTP ${asset.status} (${asset.type || 'no content-type'}).`, asset.status);
  if (!asset.body.includes('DISPLAY_ONLY_RESPONSE_CAPABILITIES')) {
    return result(label, 'gap', 'The bundle predates the display-only profile; Jarvis and chat refuse it and render escaped text until the image is rebuilt.', 200);
  }
  return result(label, 'pass', 'The bundle publishes the display-only profile Jarvis, chat and app surfaces render untrusted replies with.', 200);
}

/**
 * @description Mermaid step: the vendored runtime's VERSION and entry module must be served
 * same-origin, so Jarvis never imports a diagram engine from a third-party CDN.
 * @param fetchImpl - Fetch implementation (injectable for the registration spec).
 * @returns The step result.
 */
export async function mermaidStep(fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const label = 'Same-origin pinned diagram runtime';
  const version = await getAsset('/dist/vendor/mermaid/VERSION', fetchImpl);
  if (version.status === 404) return result(label, 'gap', 'No /dist/vendor/mermaid in the running image (it predates JVV-007 vendoring); Jarvis diagrams stay readable text.', 404);
  const pinned = version.body.trim();
  if (version.status !== 200 || !/^\d+\.\d+\.\d+$/.test(pinned)) return result(label, 'fail', `VERSION answered HTTP ${version.status} without an exact version.`, version.status);
  const entry = await getAsset('/dist/vendor/mermaid/mermaid.esm.min.mjs', fetchImpl);
  if (entry.status !== 200 || !/javascript/.test(entry.type)) return result(label, 'fail', `Mermaid ${pinned} entry answered HTTP ${entry.status}.`, entry.status);
  return result(label, 'pass', `Mermaid ${pinned} is served same-origin from /dist/vendor/mermaid.`, 200);
}

/**
 * @description Classify one display-only render of {@link HOSTILE_REPLY}: no image, link or
 * URL-bearing attribute; gallery and download kept as escaped fallbacks.
 * @param html - The composed HTML.
 * @returns The step result.
 */
export function classifyInertRender(html: string): StepResult {
  const label = 'Hostile reply stays inert';
  if (/<img|<a[\s>]|href=|src=|<form|<iframe|<script/i.test(html)) {
    return result(label, 'fail', 'A model-authored URL became a live image, link or active element.');
  }
  const kept = ['gallery', 'download'].every((kind) => html.includes(`rr-fallback" data-oshal-kind="${kind}"`));
  if (!kept) return result(label, 'fail', 'The hostile gallery/download did not degrade to their visible escaped fallbacks.');
  return result(label, 'pass', 'Remote gallery and arbitrary download degrade to escaped text; forged provider and artifact fences stay code.');
}

/**
 * @description In-process step: render {@link HOSTILE_REPLY} through the display-only profile and
 * confirm the parser never promoted a forged fence to a trusted block.
 * @returns The step result.
 */
export async function inertRenderStep(): Promise<StepResult> {
  const blocks = parseResponse(HOSTILE_REPLY) as Array<{ type: string; kind?: string }>;
  if (blocks.some((block) => block.type === 'artifact' || (block.type === 'oshal' && block.kind === 'provider-record'))) {
    return result('Hostile reply stays inert', 'fail', 'A forged provider/artifact fence parsed as a trusted block.');
  }
  const { html } = await renderResponseHtml(HOSTILE_REPLY, { capabilities: DISPLAY_ONLY_RESPONSE_CAPABILITIES });
  return classifyInertRender(html);
}

export const RESPONSE_RENDERER_SCENARIOS: Scenario[] = [{
  id: 'shared-response-renderer',
  title: 'Shared response renderer: one untrusted reply, every surface',
  group: 'jarvis',
  description: 'Jarvis, the swarm-bot chat bubble and app surfaces render untrusted model replies through one shared renderer with one display-only capability profile. The Lab confirms the running server publishes that bundle and the same-origin pinned diagram runtime, and that a hostile reply stays inert. The registered Chromium suite proves the same reply renders to the identical block sequence in Jarvis and chat, with no request to the hostile host or any CDN.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/response-renderer-parse.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-registry.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-components.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-media-kinds.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-display-profile.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-mermaid-vendored.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-response-renderer-registration.spec.ts' },
    { level: 'browser', path: 'tests/unit/shared-response-surfaces-browser.spec.ts' },
    { level: 'browser', path: 'tests/jarvis-shared-response-renderer.spec.ts' },
  ],
  steps: [
    { id: 'bundle', app: APP, label: 'Shared renderer bundle with the display-only profile', run: () => bundleStep() },
    { id: 'mermaid', app: APP, label: 'Same-origin pinned diagram runtime', run: () => mermaidStep() },
    { id: 'inert', app: APP, label: 'Hostile reply stays inert', run: () => inertRenderStep() },
  ],
}];
