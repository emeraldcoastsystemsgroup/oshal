/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove exact registry dispatch, guarded/capability fallbacks, ordered async isolation, and cancellation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Trusted-provenance binding: an artifact block resolves only with server-channel provenance bound to its own artifact id (missing, wrong-channel, mismatched, malformed or oversized provenance falls back before any component runs), and reserved trusted oshal kinds can be neither normalized, registered nor dispatched.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createResponseComponentRegistry,
  normalizeResponseRendererKey,
  responseRendererKeyForBlock,
  type CodeBlock,
  type MarkdownBlock,
  type RenderableResponseBlock,
} from '../../src/shared/ui/response-renderer';

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';

/** A server-supplied trusted block: provenance copied from the control plane, bound to its artifact. */
function trustedArtifact(provenance: Record<string, unknown> = {}): RenderableResponseBlock {
  return {
    type: 'artifact', kind: 'image',
    artifact: { type: 'image', url: `/api/jarvis/visuals/${ARTIFACT_ID}`, alt: 'Weather for Pensacola', artifactId: ARTIFACT_ID },
    provenance: {
      channel: 'server', provider: 'nws', recordRefs: ['nws:forecast:KPNS:2026-09-26T12'],
      capturedAt: '2026-09-26T12:00:00.000Z', artifactId: ARTIFACT_ID, ...provenance,
    },
  } as RenderableResponseBlock;
}

describe('ResponseComponentRegistry', () => {
  it('normalizes only fixed keys and exact bounded oshal kinds', () => {
    expect(normalizeResponseRendererKey(' Markdown ')).toBe('markdown');
    expect(normalizeResponseRendererKey('ARTIFACT:IMAGE')).toBe('artifact:image');
    expect(normalizeResponseRendererKey('OSHAL:Priority-Email')).toBe('oshal:priority-email');
    expect(normalizeResponseRendererKey('artifact:video')).toBeNull();
    expect(normalizeResponseRendererKey('oshal:*')).toBeNull();
    expect(normalizeResponseRendererKey('oshal:')).toBeNull();
    expect(normalizeResponseRendererKey('oshal:map/path')).toBeNull();
  });

  it('resolves the supported runtime block shapes to exact keys', () => {
    expect(responseRendererKeyForBlock({ type: 'markdown', text: 'hello' })).toBe('markdown');
    expect(responseRendererKeyForBlock({ type: 'code', lang: 'ts', code: 'x' })).toBe('code');
    expect(responseRendererKeyForBlock({ type: 'mermaid', code: 'A-->B' })).toBe('mermaid');
    expect(responseRendererKeyForBlock(trustedArtifact())).toBe('artifact:image');
    expect(responseRendererKeyForBlock({
      type: 'oshal', kind: 'Map', data: {}, raw: '{}',
    })).toBe('oshal:map');
    expect(responseRendererKeyForBlock({ type: 'other' } as unknown as RenderableResponseBlock)).toBeNull();
  });

  it('rejects invalid keys and normalized duplicate registrations', () => {
    const registry = createResponseComponentRegistry<void, string>();
    const component = { render: () => 'ok' };
    expect(() => registry.register('artifact:video', component)).toThrow(/Invalid response renderer key/);
    registry.register(' Markdown ', component);
    expect(registry.has('MARKDOWN')).toBe(true);
    expect(() => registry.register('markdown', component)).toThrow(/already registered: markdown/);
    expect(registry.keys()).toEqual(['markdown']);
  });

  it('uses an optional type guard and never executes an invalid block', async () => {
    const render = vi.fn((block: MarkdownBlock) => block.text.toUpperCase());
    const registry = createResponseComponentRegistry<void, string>()
      .register<MarkdownBlock>('markdown', {
        validate: (block): block is MarkdownBlock => (
          block.type === 'markdown' && typeof block.text === 'string' && block.text.length <= 5
        ),
        render,
      });

    const invalid = { type: 'markdown', text: 'too long' } as MarkdownBlock;
    const results = await registry.renderBlocks([invalid], undefined);

    expect(render).not.toHaveBeenCalled();
    expect(results).toMatchObject([{
      status: 'fallback', index: 0, key: 'markdown', reason: 'invalid_block',
    }]);
  });

  it('rejects a malformed built-in block before an unguarded component can execute', async () => {
    const render = vi.fn(() => 'unexpected');
    const registry = createResponseComponentRegistry<void, string>()
      .register('artifact:image', { render });
    const malformed = {
      type: 'artifact', kind: 'image', artifact: { type: 'image', url: '/visual' },
    } as unknown as RenderableResponseBlock;

    const results = await registry.renderBlocks([malformed], undefined);

    expect(render).not.toHaveBeenCalled();
    expect(results).toMatchObject([{
      status: 'fallback', index: 0, key: null, reason: 'invalid_block',
    }]);
  });

  it('filters registered components by exact surface capabilities', async () => {
    const markdownRender = vi.fn(() => 'markdown');
    const codeRender = vi.fn(() => 'code');
    const registry = createResponseComponentRegistry<void, string>()
      .register('markdown', { render: markdownRender })
      .register('code', { render: codeRender });

    const results = await registry.renderBlocks([
      { type: 'markdown', text: 'hello' },
      { type: 'code', lang: 'ts', code: 'const x = 1' },
    ], undefined, { capabilities: ['markdown'] });

    expect(markdownRender).toHaveBeenCalledOnce();
    expect(codeRender).not.toHaveBeenCalled();
    expect(results.map((result) => result.status)).toEqual(['rendered', 'fallback']);
    expect(results[1]).toMatchObject({ key: 'code', reason: 'unsupported_capability' });
  });

  it('never dispatches an unknown exact oshal kind to another component', async () => {
    const renderMap = vi.fn(() => 'map');
    const registry = createResponseComponentRegistry<void, string>()
      .register('oshal:map', { render: renderMap });
    const results = await registry.renderBlocks([
      { type: 'oshal', kind: 'chart', data: { values: [1] }, raw: '{"values":[1]}' },
    ], undefined);

    expect(renderMap).not.toHaveBeenCalled();
    expect(results).toMatchObject([{
      status: 'fallback', key: 'oshal:chart', reason: 'unregistered_component',
    }]);
  });

  it('isolates synchronous and asynchronous failures while preserving source order', async () => {
    const execution: string[] = [];
    const registry = createResponseComponentRegistry<{ prefix: string }, string>()
      .register<MarkdownBlock>('markdown', {
        async render(block, context) {
          execution.push(`start:${block.text}`);
          await Promise.resolve();
          execution.push(`done:${block.text}`);
          return `${context.prefix}${block.text}`;
        },
      })
      .register<CodeBlock>('code', {
        render() {
          execution.push('throw:code');
          throw new Error('broken component');
        },
      })
      .register('mermaid', {
        async render() {
          execution.push('reject:mermaid');
          throw new Error('broken async component');
        },
      });

    const results = await registry.renderBlocks([
      { type: 'markdown', text: 'first' },
      { type: 'code', lang: 'ts', code: 'bad' },
      { type: 'mermaid', code: 'bad' },
      { type: 'markdown', text: 'last' },
    ], { prefix: 'rendered:' });

    expect(execution).toEqual([
      'start:first', 'done:first', 'throw:code', 'reject:mermaid', 'start:last', 'done:last',
    ]);
    expect(results.map((result) => [result.index, result.status])).toEqual([
      [0, 'rendered'], [1, 'fallback'], [2, 'fallback'], [3, 'rendered'],
    ]);
    expect(results[0]).toMatchObject({ value: 'rendered:first' });
    expect(results[1]).toMatchObject({ reason: 'render_failed' });
    expect(results[2]).toMatchObject({ reason: 'render_failed' });
    expect(results[3]).toMatchObject({ value: 'rendered:last' });
  });

  it('honors AbortSignal before dispatch and during an async component', async () => {
    const neverRun = vi.fn(() => 'unexpected');
    const preAborted = new AbortController();
    preAborted.abort();
    const registry = createResponseComponentRegistry<void, string>()
      .register('markdown', {
        render(_block, _context, meta) {
          return new Promise<string>((resolve) => {
            meta.signal?.addEventListener('abort', () => resolve('late'), { once: true });
          });
        },
      })
      .register('code', { render: neverRun });

    const before = await registry.renderBlocks([
      { type: 'markdown', text: 'first' },
      { type: 'code', lang: '', code: 'second' },
    ], undefined, { signal: preAborted.signal });
    expect(neverRun).not.toHaveBeenCalled();
    expect(before.map((result) => result.status === 'fallback' && result.reason)).toEqual([
      'aborted', 'aborted',
    ]);

    const controller = new AbortController();
    const rendering = registry.renderBlocks([
      { type: 'markdown', text: 'first' },
      { type: 'code', lang: '', code: 'second' },
    ], undefined, { signal: controller.signal });
    controller.abort();
    const during = await rendering;

    expect(neverRun).not.toHaveBeenCalled();
    expect(during.map((result) => result.status === 'fallback' && result.reason)).toEqual([
      'aborted', 'aborted',
    ]);
  });
});

describe('trusted provenance binding', () => {
  it('dispatches a trusted artifact block only with provenance bound to its own artifact', async () => {
    const render = vi.fn(() => 'trusted');
    const registry = createResponseComponentRegistry<void, string>().register('artifact:image', { render });
    const { provenance: _drop, ...withoutProvenance } = trustedArtifact() as unknown as Record<string, unknown>;
    const forged: RenderableResponseBlock[] = [
      withoutProvenance as unknown as RenderableResponseBlock,
      trustedArtifact({ channel: 'model' }),
      trustedArtifact({ artifactId: '22222222-2222-4222-8222-222222222222' }),
      trustedArtifact({ provider: 'NWS <script>' }),
      trustedArtifact({ recordRefs: [] }),
      trustedArtifact({ recordRefs: Array.from({ length: 17 }, (_, i) => `ref-${i}`) }),
      trustedArtifact({ recordRefs: ['ok', 'line\nbreak'] }),
      trustedArtifact({ capturedAt: 'yesterday' }),
    ];

    const results = await registry.renderBlocks([...forged, trustedArtifact()], undefined);

    expect(render).toHaveBeenCalledOnce();
    expect(results.slice(0, forged.length).map((result) => [result.status, result.key])).toEqual(
      forged.map(() => ['fallback', null]),
    );
    expect(results[forged.length]).toMatchObject({ status: 'rendered', key: 'artifact:image', value: 'trusted' });
  });

  it('refuses reserved trusted oshal kinds as keys, registrations and dispatch targets', async () => {
    for (const key of ['oshal:provider-record', 'oshal:artifact-image', 'OSHAL:Visual', 'oshal:trusted', 'oshal:receipt-png', 'oshal:grounded-weather']) {
      expect(normalizeResponseRendererKey(key)).toBeNull();
      expect(() => createResponseComponentRegistry<void, string>().register(key, { render: () => 'x' }))
        .toThrow(/Invalid response renderer key/);
    }
    // Non-reserved kinds that merely CONTAIN a stem stay ordinary.
    expect(normalizeResponseRendererKey('oshal:weather-provider')).toBe('oshal:weather-provider');
    expect(normalizeResponseRendererKey('oshal:providers')).toBe('oshal:providers');

    const results = await createResponseComponentRegistry<void, string>().renderBlocks([
      { type: 'oshal', kind: 'provider-record', data: {}, raw: '{}' },
    ], undefined);
    expect(results).toMatchObject([{ status: 'fallback', key: null, reason: 'invalid_block' }]);
  });
});
