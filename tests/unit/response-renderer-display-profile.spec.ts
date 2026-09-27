/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for DISPLAY_ONLY_RESPONSE_CAPABILITIES, the profile Jarvis, the chat bubble and the Tutor pass for untrusted model text: it is a subset of the standard registry, every registered kind is explicitly classified (a new kind cannot silently join), no display-only component emits a URL-bearing attribute, link, image, form or action, and the shared SHARED_UNTRUSTED_RESPONSE conformance vector renders to its expected block sequence (summarizeRenderedBlocks) with its hostile gallery/download inert — while the same reply WITHOUT the profile does load the hostile image, proving the profile is what closes it.
 */

import { describe, expect, it } from 'vitest';
import {
  DISPLAY_ONLY_RESPONSE_CAPABILITIES,
  SHARED_UNTRUSTED_RESPONSE,
  createStandardResponseRegistry,
  renderResponseHtml,
  summarizeRenderedBlocks,
  type RenderableResponseBlock,
} from '../../src/shared/ui/response-renderer';

/** Registered kinds whose output carries a model-supplied URL: never display-only. */
const URL_BEARING = ['oshal:gallery', 'oshal:download'];
const FORBIDDEN = /href=|src=|xlink:|url\(|action=|formaction|<a[\s>]|<img|<form|<button|<input|<iframe|<script|<object|<embed|\son[a-z]+=/i;

const SAMPLE_BLOCKS: Record<string, RenderableResponseBlock> = {
  markdown: { type: 'markdown', text: 'Plain **bold** and `code` see https://attacker.example/x' },
  code: { type: 'code', lang: 'ts', code: 'fetch("https://attacker.example/x")' },
  mermaid: { type: 'mermaid', code: 'graph TD; A-->B; click A "https://attacker.example"' },
  'oshal:chart': { type: 'oshal', kind: 'chart', data: { title: 'T', labels: ['a', 'b'], series: [[1, 2]] }, raw: '{}' },
  'oshal:table': { type: 'oshal', kind: 'table', data: { columns: ['url'], rows: [['https://attacker.example/x']] }, raw: '{}' },
  'oshal:map': { type: 'oshal', kind: 'map', data: { markers: [{ lat: 30.4, lon: -87.2, label: 'https://attacker.example' }] }, raw: '{}' },
  'oshal:doc': { type: 'oshal', kind: 'doc', data: { title: 'T', sections: [{ heading: 'H', paragraphs: ['https://attacker.example/x'] }] }, raw: '{}' },
};

describe('DISPLAY_ONLY_RESPONSE_CAPABILITIES', () => {
  it('is a frozen subset of the standard registry and excludes every URL-bearing kind', () => {
    const registered = createStandardResponseRegistry().keys();
    expect(Object.isFrozen(DISPLAY_ONLY_RESPONSE_CAPABILITIES)).toBe(true);
    for (const key of DISPLAY_ONLY_RESPONSE_CAPABILITIES) expect(registered).toContain(key);
    for (const key of URL_BEARING) expect(DISPLAY_ONLY_RESPONSE_CAPABILITIES).not.toContain(key);
  });

  it('classifies every registered kind, so a new component cannot silently join the profile', () => {
    const classified = new Set([...DISPLAY_ONLY_RESPONSE_CAPABILITIES, ...URL_BEARING]);
    expect(createStandardResponseRegistry().keys().filter((key) => !classified.has(key))).toEqual([]);
    expect(Object.keys(SAMPLE_BLOCKS).sort()).toEqual([...DISPLAY_ONLY_RESPONSE_CAPABILITIES].sort());
  });

  it.each([...DISPLAY_ONLY_RESPONSE_CAPABILITIES])('%s renders no URL-bearing attribute, link, image, form or action', async (key) => {
    const results = await createStandardResponseRegistry().renderBlocks([SAMPLE_BLOCKS[key]], undefined, {
      capabilities: DISPLAY_ONLY_RESPONSE_CAPABILITIES,
    });
    expect(results[0].status).toBe('rendered');
    const html = results[0].status === 'rendered' ? results[0].value : '';
    expect(html).not.toMatch(FORBIDDEN);
  });
});

describe('shared untrusted fixture through the display-only profile', () => {
  it('renders the expected block sequence with hostile gallery/download as escaped fallbacks', async () => {
    const shared = SHARED_UNTRUSTED_RESPONSE;
    const { html } = await renderResponseHtml(shared.text, { capabilities: DISPLAY_ONLY_RESPONSE_CAPABILITIES });
    expect(summarizeRenderedBlocks(html)).toEqual(shared.expectedBlocks);
    expect(html).not.toMatch(/<img|<a[\s>]|href=|src=/);
    expect(html).toContain(`${shared.hostileHost}/beacon.png`); // visible as escaped text only
  });

  it('WITHOUT the profile the same reply would load the hostile image and link (the profile is load-bearing)', async () => {
    const shared = SHARED_UNTRUSTED_RESPONSE;
    const { html } = await renderResponseHtml(shared.text);
    expect(html).toContain(`src="https://${shared.hostileHost}/beacon.png`);
    expect(html).toContain(`href="https://${shared.hostileHost}/payload.exe"`);
  });
});
