/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Lock the `image` kind's binding
 *            | rules: a model may never supply bytes or a URL, only refs the server already verified.
 */

import { describe, expect, it } from 'vitest';
import { parseVisualResponseSpec, renderVisualResponse } from '@/features/visual-response';

const base = {
  schemaVersion: 1 as const,
  kind: 'image' as const,
  title: 'Generated figures',
  sourceRefs: ['workspace:a', 'workspace:b'],
  items: [
    { sourceRef: 'workspace:a', caption: 'Latency p99 after the deploy.' },
    { sourceRef: 'workspace:b', caption: 'Topology before and after.' },
  ],
};

/** Every external reference in the SVG, ignoring the required SVG/XML namespace declarations. */
function externalRefs(svg: string): string[] {
  return svg.replace(/xmlns(:\w+)?="[^"]*"/g, '').match(/https?:\/\/[^"'\s)]+/g) || [];
}

function packet(visualSpec: unknown) {
  return {
    factLocked: true as const,
    sourceSurface: 'test', sourceSessionId: 's', sourceJobId: 'j',
    request: 'show me', answer: 'here they are',
    visualSpec: visualSpec as never,
  };
}

describe('image visual kind — the model can never supply bytes or a URL', () => {
  it('accepts a well-formed workspace-bound spec', () => {
    expect(parseVisualResponseSpec(base)?.kind).toBe('image');
  });

  it.each([
    ['a url on the item', { items: [{ sourceRef: 'workspace:a', caption: 'c', url: 'https://attacker.example/x.png' }], sourceRefs: ['workspace:a'] }],
    ['inline bytes on the item', { items: [{ sourceRef: 'workspace:a', caption: 'c', content: 'AAAA' }], sourceRefs: ['workspace:a'] }],
    ['a top-level url', { url: 'https://attacker.example/x.png' }],
  ])('rejects %s (strict schema)', (_label, override) => {
    expect(parseVisualResponseSpec({ ...base, ...override })).toBeNull();
  });

  it('rejects an item whose sourceRef is not bound in sourceRefs', () => {
    expect(parseVisualResponseSpec({
      ...base,
      sourceRefs: ['workspace:a'],
      items: [{ sourceRef: 'workspace:unbound', caption: 'sneaky' }],
    })).toBeNull();
  });

  it('rejects duplicate item sourceRefs and an empty sourceRefs list', () => {
    expect(parseVisualResponseSpec({
      ...base, sourceRefs: ['workspace:a'],
      items: [{ sourceRef: 'workspace:a', caption: 'one' }, { sourceRef: 'workspace:a', caption: 'two' }],
    })).toBeNull();
    expect(parseVisualResponseSpec({ ...base, sourceRefs: [], items: [{ sourceRef: 'workspace:a', caption: 'c' }] })).toBeNull();
  });

  it('requires a caption per item (it is the accessible description)', () => {
    expect(parseVisualResponseSpec({
      ...base, sourceRefs: ['workspace:a'], items: [{ sourceRef: 'workspace:a' }],
    })).toBeNull();
  });

  it('renders an honest placeholder — never a remote reference — when no receipt exists', () => {
    const rendered = renderVisualResponse(packet(base));
    const svg = rendered.content.toString('utf8');
    expect(rendered.kind).toBe('image');
    expect(svg).toContain('<svg');
    expect(svg).toContain('IMAGE');            // the placeholder, not a broken picture
    expect(svg).not.toContain('<image');       // no embedded bitmap without a receipt
    expect(externalRefs(svg)).toEqual([]);     // no network reference of any kind
  });

  it('embeds bytes only from a supplied receipt, as a data: PNG', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const receipts = new Map([['workspace:a', {
      sourceRef: 'workspace:a', mimeType: 'image/png' as const, content: png,
      width: 480, height: 320, sourceUrlSha256: 'a'.repeat(64),
      sourceContentSha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64),
      sourceBytes: 100, outputBytes: png.byteLength,
    }]]);
    const svg = renderVisualResponse(packet(base), receipts as never).content.toString('utf8');
    expect(svg).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(externalRefs(svg)).toEqual([]);
  });

  it('folds receipt bytes into the spec digest so provenance covers what was embedded', () => {
    const make = (byte: string) => new Map([['workspace:a', {
      sourceRef: 'workspace:a', mimeType: 'image/png' as const, content: Buffer.from('00', 'hex'),
      width: 480, height: 320, sourceUrlSha256: 'a'.repeat(64),
      sourceContentSha256: 'b'.repeat(64), contentSha256: byte.repeat(64),
      sourceBytes: 100, outputBytes: 1,
    }]]);
    const first = renderVisualResponse(packet(base), make('c') as never).visualSpecSha256;
    const second = renderVisualResponse(packet(base), make('d') as never).visualSpecSha256;
    expect(first).not.toBe(second);
  });
});
