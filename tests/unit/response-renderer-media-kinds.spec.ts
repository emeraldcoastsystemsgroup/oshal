/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the added oshal:map/oshal:gallery/oshal:download response-renderer kinds: proves each renders a valid block to sanitized HTML, fails a malformed block closed to its plain-text fallback, enforces the safeUrl scheme allowlist for gallery/download hrefs, and never lets a <script>/javascript:/attribute-breakout payload land unescaped through the renderResponseHtml pipeline.
 */

import { describe, expect, it } from 'vitest';
import {
  createStandardResponseRegistry,
  normalizeDownloadData,
  normalizeGalleryData,
  normalizeMapData,
  renderDownloadHtml,
  renderGalleryHtml,
  renderMapSvg,
  renderResponseHtml,
  safeUrl,
} from '../../src/shared/ui/response-renderer';

const FENCE = '```';

describe('safeUrl — scheme allowlist (fail-closed)', () => {
  it('accepts https/http/root-relative/data:image and rejects hostile schemes', () => {
    expect(safeUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(safeUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(safeUrl('/workspace/report.pdf')).toBe('/workspace/report.pdf');
    expect(safeUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    // fail-closed cases
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('  javascript:alert(1)')).toBeNull();
    expect(safeUrl('java\tscript:alert(1)')).toBeNull(); // whitespace-obfuscated scheme
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('//evil.example.com')).toBeNull(); // protocol-relative rejected
    // Backslash-authority bypass (adversarial review): browsers normalize `\`→`/`, so `/\host`
    // resolves to protocol-relative `//host`. Must be rejected like `//host`.
    expect(safeUrl('/\\evil.example.com/track.gif')).toBeNull();
    expect(safeUrl('/\\/evil.example.com')).toBeNull();
    expect(safeUrl('\\\\evil.example.com')).toBeNull(); // leading backslashes → //host after normalize
    expect(safeUrl('/workspace/a\\b.pdf')).toBe('/workspace/a/b.pdf'); // interior backslash normalized, still root-relative
    expect(safeUrl('data:text/html,<script>')).toBeNull(); // non-image data URI rejected
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('oshal:map — normalization + SVG output', () => {
  it('normalizes markers with in-range lat/lon and an optional label', () => {
    expect(normalizeMapData({
      title: 'Sites', markers: [{ lat: 30.4, lon: -87.2, label: 'HQ' }, { lat: 0, lon: 0 }],
    })).toEqual({
      title: 'Sites',
      markers: [{ lat: 30.4, lon: -87.2, label: 'HQ' }, { lat: 0, lon: 0, label: '' }],
    });
  });

  it('fails closed on malformed / out-of-range bodies', () => {
    expect(normalizeMapData(null)).toBeNull();
    expect(normalizeMapData({ markers: [] })).toBeNull();
    expect(normalizeMapData({ markers: [{ lat: 91, lon: 0 }] })).toBeNull(); // lat out of range
    expect(normalizeMapData({ markers: [{ lat: 0, lon: 181 }] })).toBeNull(); // lon out of range
    expect(normalizeMapData({ markers: [{ lat: 0 }] })).toBeNull(); // missing lon
    expect(normalizeMapData({ markers: [{ lat: Number.NaN, lon: 0 }] })).toBeNull();
    expect(normalizeMapData({ markers: [{ lat: '0', lon: '0' }] })).toBeNull(); // strings rejected
  });

  it('renders a themed equirectangular svg projecting lon/lat to plot coordinates', () => {
    const svg = renderMapSvg({ title: '', markers: [{ lat: 0, lon: 0, label: '' }] });
    expect(svg).toContain('viewBox="0 0 640 320"');
    expect(svg).toContain('role="img"');
    // lon 0 → x = 320, lat 0 → y = 160 (frame center).
    expect(svg).toContain('<circle cx="320" cy="160"');
    expect(svg).toContain('currentColor'); // graticule follows the surface theme
    // deterministic: same input → same output.
    expect(renderMapSvg({ title: '', markers: [{ lat: 0, lon: 0, label: '' }] })).toBe(svg);
  });
});

describe('oshal:gallery — normalization + output + URL allowlist', () => {
  it('renders a responsive grid of escaped image figures', () => {
    const spec = normalizeGalleryData({
      title: 'Renders',
      items: [{ url: 'https://cdn.example.com/1.png', alt: 'One', caption: 'first' }],
    });
    expect(spec).not.toBeNull();
    const html = renderGalleryHtml(spec!);
    expect(html).toContain('display:grid');
    expect(html).toContain('src="https://cdn.example.com/1.png"');
    expect(html).toContain('alt="One"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('first');
  });

  it('fails closed on a hostile URL or malformed shape', () => {
    expect(normalizeGalleryData({ items: [{ url: 'javascript:alert(1)' }] })).toBeNull();
    expect(normalizeGalleryData({ items: [{ alt: 'no url' }] })).toBeNull();
    expect(normalizeGalleryData({ items: [] })).toBeNull();
    expect(normalizeGalleryData(null)).toBeNull();
  });
});

describe('oshal:download — normalization + output + URL allowlist', () => {
  it('renders download anchors with human-readable sizes', () => {
    const spec = normalizeDownloadData({
      title: 'Exports',
      files: [
        { url: '/workspace/report.pdf', name: 'report.pdf', size: 2_097_152, mime: 'application/pdf' },
        { url: 'https://cdn.example.com/data.csv', name: 'data.csv' },
      ],
    });
    expect(spec).not.toBeNull();
    const html = renderDownloadHtml(spec!);
    expect(html).toContain('href="/workspace/report.pdf"');
    expect(html).toContain('download="report.pdf"');
    expect(html).toContain('2 MB');
    expect(html).toContain('application/pdf');
    expect(html).toContain('href="https://cdn.example.com/data.csv"');
  });

  it('fails closed on a hostile URL, missing name, or malformed shape', () => {
    expect(normalizeDownloadData({ files: [{ url: 'javascript:alert(1)', name: 'x' }] })).toBeNull();
    expect(normalizeDownloadData({ files: [{ url: '/a', name: '' }] })).toBeNull();
    expect(normalizeDownloadData({ files: [{ url: '/a' }] })).toBeNull(); // missing name
    expect(normalizeDownloadData({ files: [] })).toBeNull();
  });
});

describe('renderResponseHtml pipeline — new kinds', () => {
  it('renders each new kind and degrades a malformed one to a visible sanitized fallback', async () => {
    const reply = [
      `${FENCE}oshal:map\n{"markers":[{"lat":0,"lon":0,"label":"Origin"}]}\n${FENCE}`,
      `${FENCE}oshal:gallery\n{"items":[{"url":"https://cdn.example.com/1.png","alt":"pic"}]}\n${FENCE}`,
      `${FENCE}oshal:download\n{"files":[{"url":"/report.pdf","name":"report.pdf"}]}\n${FENCE}`,
      `${FENCE}oshal:map\n{"markers":[{"lat":999,"lon":0}]}\n${FENCE}`, // malformed → fallback
    ].join('\n\n');
    const { html, rich } = await renderResponseHtml(reply);
    expect(rich).toBe(true);
    expect(html).toContain('rr-map');
    expect(html).toContain('rr-gallery');
    expect(html).toContain('rr-download');
    // the out-of-range map degrades to the visible escaped-body fallback, never dropped.
    expect(html).toContain('data-oshal-kind="map"');
    expect(html).toContain('&quot;lat&quot;');
  });

  it('never lets a javascript: href or <script>/attribute-breakout payload land unescaped', async () => {
    const reply = [
      `${FENCE}oshal:gallery\n{"items":[{"url":"javascript:alert(1)","alt":"x"}]}\n${FENCE}`,
      `${FENCE}oshal:gallery\n{"title":"<script>alert(1)</script>","items":[{"url":"https://x/a.png","alt":"\\"><img src=x onerror=alert(1)>"}]}\n${FENCE}`,
      `${FENCE}oshal:download\n{"files":[{"url":"vbscript:x","name":"y"}]}\n${FENCE}`,
      `${FENCE}oshal:map\n{"title":"<script>alert(1)</script>","markers":[{"lat":0,"lon":0,"label":"\\"><svg onload=alert(1)>"}]}\n${FENCE}`,
    ].join('\n\n');
    const { html } = await renderResponseHtml(reply);
    // hostile schemes rejected the whole block → escaped-body fallback, no live href.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
    expect(html).not.toContain('href="vbscript:');
    // no hostile element ever opens; payloads survive only as inert escaped text.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/<svg[^>]*onload/i);
    expect(html).toContain('&lt;script&gt;');
  });
});
