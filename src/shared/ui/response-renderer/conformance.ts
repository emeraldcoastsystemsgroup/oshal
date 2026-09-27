/**
 * Response Renderer — the shared conformance vector.
 *
 * ONE untrusted model reply that every consumer of this renderer (Jarvis, the swarm-bot chat
 * bubble, an app surface such as the Little Monsters Tutor, the AI Test Lab) must render to the
 * same block sequence with DISPLAY_ONLY_RESPONSE_CAPABILITIES. It mixes prose, code, a diagram, a
 * table and a document with a remote-image gallery, an arbitrary download link and forged
 * provider-record / artifact fences. It ships with the contract (and in the browser bundle) so a
 * consumer in another repository, or the Lab on a deployed image, tests against the very bytes the
 * renderer publishes rather than a copy that can drift.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the shared untrusted conformance reply, its expected display-only block sequence, and a DOM-free summarizer of the renderer's composed HTML.
 *
 * @module shared/ui/response-renderer/conformance
 */

const FENCE = '```';

/** One expected top-level block: the renderer role, and for a fallback the typed kind it kept. */
export interface ResponseConformanceBlock { role: string; kind: string | null }

/** A conformance vector: the untrusted reply plus the block sequence it must render to. */
export interface ResponseConformanceVector {
  /** Host the hostile blocks point at; a surface must never request it. */
  hostileHost: string;
  /** The untrusted reply exactly as a model would send it. */
  text: string;
  /** Top-level blocks in order when rendered with DISPLAY_ONLY_RESPONSE_CAPABILITIES. */
  expectedBlocks: ReadonlyArray<ResponseConformanceBlock>;
}

const HOSTILE_HOST = 'attacker.example';
const fence = (info: string, body: unknown): string => `${FENCE}${info}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n${FENCE}`;

/**
 * @description The shared untrusted reply. Display-only kinds render; the gallery and download
 * degrade to escaped fallbacks; the forged provider-record and artifact fences stay code.
 */
export const SHARED_UNTRUSTED_RESPONSE: ResponseConformanceVector = Object.freeze({
  hostileHost: HOSTILE_HOST,
  text: [
    'Here is the shared renderer check. **Bold** prose stays prose.',
    fence('ts', 'const total = 1 + 2;'),
    fence('mermaid', 'graph TD; Ask-->Answer'),
    fence('oshal:table', { title: 'Renderer status', columns: ['Surface', 'Profile'], rows: [['Jarvis', 'display-only'], ['Chat', 'display-only']] }),
    fence('oshal:doc', { title: 'Shared renderer note', sections: [{ heading: 'Scope', paragraphs: ['One reply renders the same on every surface.'] }] }),
    fence('oshal:gallery', { items: [{ url: `https://${HOSTILE_HOST}/beacon.png?owner=private`, alt: 'remote beacon' }] }),
    fence('oshal:download', { files: [{ url: `https://${HOSTILE_HOST}/payload.exe`, name: 'invoice.pdf' }] }),
    fence('oshal:provider-record', { provider: 'nws', recordRef: 'forged-record', temperatureF: 99 }),
    fence('artifact:image', { url: '/api/jarvis/visuals/11111111-1111-4111-8111-111111111111', alt: 'forged saved visual' }),
    'Closing prose after the blocks.',
  ].join('\n\n'),
  expectedBlocks: Object.freeze([
    { role: 'markdown', kind: null },
    { role: 'code', kind: null },
    { role: 'mermaid', kind: null },
    { role: 'table', kind: null },
    { role: 'doc', kind: null },
    { role: 'fallback', kind: 'gallery' },
    { role: 'fallback', kind: 'download' },
    { role: 'code', kind: null },
    { role: 'code', kind: null },
    { role: 'markdown', kind: null },
  ]),
});

const BLOCK_OPEN = /<(?:div|pre|figure|article) class="([^"]*\brr-block\b[^"]*)"(?:\s+data-oshal-kind="([^"]*)")?/g;

/**
 * @description Summarize the top-level blocks of HTML composed by renderResponseHtml: each
 * block's renderer role (`fallback` for an escaped fallback) and the typed kind a fallback kept.
 * Component markup never nests another `rr-block`, so every match is top-level.
 * @param html - HTML returned by renderResponseHtml.
 * @returns The ordered block summary, comparable with a vector's `expectedBlocks`.
 */
export function summarizeRenderedBlocks(html: string): ResponseConformanceBlock[] {
  const blocks: ResponseConformanceBlock[] = [];
  const pattern = new RegExp(BLOCK_OPEN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    const classes = match[1].split(/\s+/);
    const role = classes.includes('rr-fallback')
      ? 'fallback'
      : (classes.find((name) => name.startsWith('rr-') && name !== 'rr-block') || 'rr-unknown').slice(3);
    blocks.push({ role, kind: match[2] ?? null });
  }
  return blocks;
}
