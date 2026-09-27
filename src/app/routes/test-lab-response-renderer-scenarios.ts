/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the shared response renderer (BACKLOG "Shared response-renderer completion"). Three read-only steps: the running server publishes the browser bundle WITH the display-only capability profile Jarvis/chat/app surfaces require; it serves the same-origin vendored Mermaid runtime (JVV-007) at a pinned version; and the renderer's shared untrusted conformance reply (remote gallery, arbitrary download, forged provider/artifact fences) rendered in-process through that profile produces its expected block sequence with every hostile block inert. A missing bundle/runtime is a deployment gap, not a pass. Cross-surface Chromium proof is attached as regression suites.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attach the JVV-003 queue-backed delayed-lifecycle suite (jarvis-queue-lifecycle.integration.spec.ts) as an integration regression: the same backlog entry closes the acceptance plan's worker-lifecycle question, and a spec on disk is not Test Lab registration.
 *
 * @module routes/test-lab-response-renderer-scenarios
 */

import { createChildLogger } from '@/shared/logger';
import {
  DISPLAY_ONLY_RESPONSE_CAPABILITIES,
  SHARED_UNTRUSTED_RESPONSE,
  parseResponse,
  renderResponseHtml,
  summarizeRenderedBlocks,
} from '@/shared/ui/response-renderer';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-response-renderer-scenarios' });
const APP = 'response-renderer';
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
 * @description Classify one display-only render of the shared conformance reply: no image, link
 * or URL-bearing attribute, and exactly the vector's expected block sequence (so the gallery and
 * download are escaped fallbacks and the forged fences are code).
 * @param html - The composed HTML.
 * @returns The step result.
 */
export function classifyInertRender(html: string): StepResult {
  const label = 'Hostile reply stays inert';
  if (/<img|<a[\s>]|href=|src=|<form|<iframe|<script/i.test(html)) {
    return result(label, 'fail', 'A model-authored URL became a live image, link or active element.');
  }
  const rendered = summarizeRenderedBlocks(html);
  const expected = SHARED_UNTRUSTED_RESPONSE.expectedBlocks;
  const same = rendered.length === expected.length
    && rendered.every((block, index) => block.role === expected[index].role && block.kind === expected[index].kind);
  if (!same) {
    const shape = rendered.map((block) => (block.kind ? `${block.role}:${block.kind}` : block.role)).join(', ');
    return result(label, 'fail', `The conformance reply rendered as [${shape}], not its expected block sequence.`);
  }
  return result(label, 'pass', 'Remote gallery and arbitrary download degrade to escaped text; forged provider and artifact fences stay code; every block matches the shared sequence.');
}

/**
 * @description In-process step: render the shared conformance reply through the display-only
 * profile and confirm the parser never promoted a forged fence to a trusted block.
 * @returns The step result.
 */
export async function inertRenderStep(): Promise<StepResult> {
  const blocks = parseResponse(SHARED_UNTRUSTED_RESPONSE.text) as Array<{ type: string; kind?: string }>;
  if (blocks.some((block) => block.type === 'artifact' || (block.type === 'oshal' && block.kind === 'provider-record'))) {
    return result('Hostile reply stays inert', 'fail', 'A forged provider/artifact fence parsed as a trusted block.');
  }
  const { html } = await renderResponseHtml(SHARED_UNTRUSTED_RESPONSE.text, { capabilities: DISPLAY_ONLY_RESPONSE_CAPABILITIES });
  return classifyInertRender(html);
}

export const RESPONSE_RENDERER_SCENARIOS: Scenario[] = [{
  id: 'shared-response-renderer',
  title: 'Shared response renderer: one untrusted reply, every surface',
  group: 'jarvis',
  description: 'Jarvis, the swarm-bot chat bubble and app surfaces render untrusted model replies through one shared renderer with one display-only capability profile. The Lab confirms the running server publishes that bundle and the same-origin pinned diagram runtime, and that a hostile reply stays inert. The registered Chromium suite proves the same reply renders to the identical block sequence in Jarvis and chat, with no request to the hostile host or any CDN; the delayed-lifecycle suite proves a handed-off task returns to its Discussion through the real queue call-out and a remote worker.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/response-renderer-parse.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-registry.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-components.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-media-kinds.spec.ts' },
    { level: 'unit', path: 'tests/unit/response-renderer-display-profile.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-mermaid-vendored.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-response-renderer-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-queue-lifecycle.integration.spec.ts' },
    { level: 'browser', path: 'tests/unit/shared-response-surfaces-browser.spec.ts' },
    { level: 'browser', path: 'tests/jarvis-shared-response-renderer.spec.ts' },
  ],
  steps: [
    { id: 'bundle', app: APP, label: 'Shared renderer bundle with the display-only profile', run: () => bundleStep() },
    { id: 'mermaid', app: APP, label: 'Same-origin pinned diagram runtime', run: () => mermaidStep() },
    { id: 'inert', app: APP, label: 'Hostile reply stays inert', run: () => inertRenderStep() },
  ],
}];
