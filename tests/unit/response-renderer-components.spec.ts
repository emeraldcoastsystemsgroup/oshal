/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Concrete component set: proves the standard registry registration, per-component output shapes (markdown/code/mermaid data-mermaid fallback/oshal:chart SVG/oshal:table), golden-ish chart geometry for a known input, fail-closed chart/table normalization, the renderResponseHtml end-to-end pipeline with visible fallbacks, and that <script>/attribute-breakout payloads never land unescaped in any component's output.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update the standard-registry key-set assertion for the added oshal:map/oshal:gallery/oshal:download kinds (their own coverage lives in response-renderer-media-kinds.spec.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  createStandardResponseRegistry,
  normalizeChartData,
  normalizeTableData,
  renderChartSvg,
  renderFallbackHtml,
  renderMarkdownText,
  renderResponseHtml,
  renderTableHtml,
  safeLanguageToken,
  type ChartSpec,
} from '../../src/shared/ui/response-renderer';

const FENCE = '```';
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';

describe('standard response registry — registration', () => {
  it('registers exactly the shipped component set in deterministic order', () => {
    const registry = createStandardResponseRegistry();
    expect(registry.keys()).toEqual([
      'markdown', 'code', 'mermaid',
      'oshal:chart', 'oshal:table', 'oshal:map', 'oshal:gallery', 'oshal:download',
    ]);
    expect(registry.has('OSHAL:Chart')).toBe(true);
    expect(registry.has('artifact:image')).toBe(false); // surface-owned, deliberately unregistered
  });

  it('returns independent registry instances (surfaces can extend without cross-talk)', () => {
    const first = createStandardResponseRegistry();
    const second = createStandardResponseRegistry();
    second.register('oshal:custom', { render: () => 'x' });
    expect(first.has('oshal:custom')).toBe(false);
  });
});

describe('markdown + code + mermaid components — output shapes', () => {
  it('renders markdown prose with the surfaces existing inline transforms', async () => {
    const registry = createStandardResponseRegistry();
    const [result] = await registry.renderBlocks(
      [{ type: 'markdown', text: 'use `foo` and **bold** now' }], undefined,
    );
    expect(result.status).toBe('rendered');
    const html = (result as { value: string }).value;
    expect(html).toContain('class="rr-block rr-markdown"');
    expect(html).toContain('<code class="inline-code">foo</code>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders a code block with the code-block class and a sanitized language class', async () => {
    const registry = createStandardResponseRegistry();
    const [result] = await registry.renderBlocks(
      [{ type: 'code', lang: 'Python', code: 'def f():\n    return 1' }], undefined,
    );
    const html = (result as { value: string }).value;
    expect(html).toContain('<pre class="code-block rr-block rr-code">');
    expect(html).toContain('language-python');
    expect(html).toContain('def f():\n    return 1');
  });

  it('renders mermaid as a fenced-code fallback carrying data-mermaid for surface hydration', async () => {
    const registry = createStandardResponseRegistry();
    const [result] = await registry.renderBlocks(
      [{ type: 'mermaid', code: 'graph TD; A-->B' }], undefined,
    );
    const html = (result as { value: string }).value;
    expect(html).toContain('data-mermaid="graph TD; A--&gt;B"');
    expect(html).toContain('rr-mermaid');
    expect(html).not.toContain('<script'); // and no external/CDN script tags ever
  });

  it('sanitizes a hostile language token down to a safe class charset', () => {
    expect(safeLanguageToken('js" onclick="alert(1)')).toBe('jsonclickalert1');
    expect(safeLanguageToken('oshal:chart')).toBe('oshalchart');
  });
});

describe('oshal:chart — normalization + golden-ish SVG geometry', () => {
  const goldenSpec: ChartSpec = {
    title: '', type: 'bar', labels: ['A', 'B'], series: [{ label: '', values: [1, 3] }],
  };

  it('normalizes {labels, series} with both number[] and {label, values} series entries', () => {
    expect(normalizeChartData({ labels: ['A', 'B'], series: [[1, 3]] })).toEqual(goldenSpec);
    expect(normalizeChartData({
      labels: ['A', 'B'], series: [{ label: 's1', values: [1, 3] }], type: 'line', title: 'T',
    })).toEqual({ title: 'T', type: 'line', labels: ['A', 'B'], series: [{ label: 's1', values: [1, 3] }] });
  });

  it('fails closed on malformed bodies', () => {
    expect(normalizeChartData(null)).toBeNull();
    expect(normalizeChartData({ labels: [], series: [[1]] })).toBeNull();
    expect(normalizeChartData({ labels: ['A'], series: [] })).toBeNull();
    expect(normalizeChartData({ labels: ['A', 'B'], series: [[1]] })).toBeNull(); // length mismatch
    expect(normalizeChartData({ labels: ['A'], series: [[Number.NaN]] })).toBeNull();
    expect(normalizeChartData({ labels: ['A'], series: [['1']] })).toBeNull(); // strings rejected
  });

  it('renders the golden bar chart geometry for {labels:[A,B], series:[[1,3]]}', () => {
    const svg = renderChartSvg(goldenSpec);
    // Fixed frame: 640x320 viewBox, plot 580x252 with margins L46 T28 B40.
    expect(svg).toContain('viewBox="0 0 640 320"');
    expect(svg).toContain('role="img"');
    // value 1 → y(1)=196, height 84; value 3 → y(3)=28, full plot height 252; bar width 203.
    expect(svg).toContain('<rect x="89.5" y="196" width="203" height="84" fill="#78effa"');
    expect(svg).toContain('<rect x="379.5" y="28" width="203" height="252" fill="#78effa"');
    // baseline at y(0)=280 across the plot, max label "3" on the y axis.
    expect(svg).toContain('x1="46" y1="280" x2="626" y2="280"');
    expect(svg).toContain('>3</text>');
    // deterministic: same input → same output.
    expect(renderChartSvg(goldenSpec)).toBe(svg);
  });

  it('renders line charts as one polyline through the label centers', () => {
    const svg = renderChartSvg({ ...goldenSpec, type: 'line' });
    expect(svg).toContain('<polyline points="191,196 481,28"');
    expect(svg).not.toContain('<rect x="89.5"');
  });
});

describe('oshal:table — normalization + output shape', () => {
  it('renders a scrollable table with header and stringified cells', () => {
    const spec = normalizeTableData({
      title: 'Costs', columns: ['bot', 'usd'], rows: [['codex', 1.25], ['claude', 0.5]],
    });
    expect(spec).not.toBeNull();
    const html = renderTableHtml(spec!);
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('<caption>Costs</caption>');
    expect(html).toContain('<th>bot</th><th>usd</th>');
    expect(html).toContain('<td>codex</td><td>1.25</td>');
  });

  it('fails closed on ragged rows and non-scalar cells', () => {
    expect(normalizeTableData({ columns: ['a'], rows: [['x', 'y']] })).toBeNull();
    expect(normalizeTableData({ columns: ['a'], rows: [[{ nested: true }]] })).toBeNull();
    expect(normalizeTableData({ columns: [], rows: [] })).toBeNull();
  });
});

describe('renderResponseHtml — end-to-end pipeline', () => {
  it('composes a mixed reply into ordered sanitized blocks and flags it rich', async () => {
    const reply = `Here you go:\n\n${FENCE}python\nprint(1)\n${FENCE}\n\n${FENCE}mermaid\ngraph TD; A-->B\n${FENCE}\n\n${FENCE}oshal:chart\n{"labels":["A","B"],"series":[[1,3]]}\n${FENCE}\n\nDone.`;
    const { html, rich } = await renderResponseHtml(reply);
    expect(rich).toBe(true);
    const order = ['rr-markdown', 'rr-code', 'rr-mermaid', 'rr-chart', 'Done.'];
    let cursor = -1;
    for (const marker of order) {
      const index = html.indexOf(marker, cursor + 1);
      expect(index, `expected ${marker} after position ${cursor}`).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(html).toContain('<svg class="rr-chart-svg"');
  });

  it('keeps plain prose as a single markdown block and flags it not-rich', async () => {
    const { html, rich } = await renderResponseHtml('just **prose** here');
    expect(rich).toBe(false);
    expect(html).toContain('<strong>prose</strong>');
    expect(await renderResponseHtml('')).toEqual({ html: '', rich: false });
  });

  it('renders a visible sanitized fallback for an unregistered or invalid typed block', async () => {
    // Unknown kind → unregistered_component fallback; bad chart shape → invalid_block fallback.
    const reply = `${FENCE}oshal:starmap\n{"stars":1}\n${FENCE}\n${FENCE}oshal:chart\n{"labels":["A"],"series":[["nope"]]}\n${FENCE}`;
    const { html } = await renderResponseHtml(reply);
    expect(html).toContain('data-oshal-kind="starmap"');
    expect(html).toContain('data-oshal-kind="chart"');
    expect(html).toContain('&quot;stars&quot;'); // raw body stays visible, escaped
  });

  it('renders fallbacks for every block shape via renderFallbackHtml', () => {
    expect(renderFallbackHtml({ type: 'code', lang: 'js', code: 'x<y' })).toContain('x&lt;y');
    expect(renderFallbackHtml({ type: 'markdown', text: 'hey' })).toContain('hey');
    expect(renderFallbackHtml({
      type: 'artifact', kind: 'image', artifact: { type: 'image', url: '/a', alt: 'An image' },
    })).toContain('An image');
  });
});

describe('XSS discipline — a <script> payload never lands as an element', () => {
  it('escapes script payloads in every component input position', async () => {
    const reply = [
      `Intro ${SCRIPT_PAYLOAD} **${SCRIPT_PAYLOAD}**`,
      `${FENCE}js" onload="alert(1)\n${SCRIPT_PAYLOAD}\n${FENCE}`,
      `${FENCE}mermaid\n"><script>alert(1)</script>\n${FENCE}`,
      `${FENCE}oshal:chart\n{"title":"${SCRIPT_PAYLOAD.replace(/"/g, '\\"')}","labels":["<img src=x onerror=alert(1)>"],"series":[[1]]}\n${FENCE}`,
      `${FENCE}oshal:table\n{"columns":["${SCRIPT_PAYLOAD.replace(/"/g, '\\"')}"],"rows":[["<svg onload=alert(1)>"]]}\n${FENCE}`,
    ].join('\n\n');

    const { html } = await renderResponseHtml(reply);
    // No hostile element ever OPENS — the only '<' in the output belong to markup this
    // renderer composed itself (the legit rr-chart <svg> has no event attributes).
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('&lt;script&gt;');                 // payload is visible, inert text
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');    // table cell stays inert text
    expect(html).not.toMatch(/<svg[^>]*onload/i);              // and the real svg carries no handler
  });

  it('escapes markup in plain markdown prose (default text path)', () => {
    const html = renderMarkdownText(`before ${SCRIPT_PAYLOAD} after`);
    expect(html).toBe('before &lt;script&gt;alert(1)&lt;/script&gt; after');
  });
});
