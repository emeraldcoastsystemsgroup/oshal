/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the one-shot tool query on app-navigate. An embedded surface (the Create front door) may open a sibling tile on a purpose — kind=docx&starter=resume — and ONLY that: the query is k=v&k=v in URL-safe characters, bounded, appended to the tile's OWN iframeUrl by the view controller, consumed on first render, and a query onto the already-active tile re-renders it. Anything else (a path, a fragment, whitespace, a second URL, an over-long value, a non-string) is dropped and the navigation proceeds without it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeToolQuery } from '@/pages/cockpit/js/components/RibbonNav.js';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');
const RIBBON = 'src/pages/cockpit/js/components/RibbonNav.js';
const CONTROLLER = 'src/pages/cockpit/js/cockpit-view-controller.js';

describe('sanitizeToolQuery', () => {
  it('accepts the purpose deep link the Create front door sends', () => {
    expect(sanitizeToolQuery('kind=docx&starter=resume&theme=paper')).toBe('kind=docx&starter=resume&theme=paper');
    expect(sanitizeToolQuery('kind=pptx')).toBe('kind=pptx');
    expect(sanitizeToolQuery('theme=')).toBe('theme=');
    expect(sanitizeToolQuery('topic=Q3%20board%20update')).toBe('topic=Q3%20board%20update');
  });

  it('drops anything that is not a bounded k=v list in URL-safe characters', () => {
    for (const bad of [
      '', 'kind', 'kind=docx#frag', 'kind=docx&', '&kind=docx', 'kind=do cx', 'kind=docx;x=1',
      '../x=1', 'a=/api/other', 'a=b?c=d', 'a=<script>', 'a=b&&c=d', 'k=' + 'x'.repeat(520),
    ]) expect(sanitizeToolQuery(bad), bad).toBeNull();
    for (const notString of [undefined, null, 42, {}, [], () => 'a=b']) expect(sanitizeToolQuery(notString)).toBeNull();
  });
});

describe('the ribbon carries the query to the view controller, one-shot', () => {
  it('stores a sanitized query on the tool form only and re-renders the active tile', () => {
    const src = read(RIBBON);
    expect(src).toMatch(/const toolQuery = d\.type === 'app-navigate' && d\.tool \? sanitizeToolQuery\(d\.query\) : null;/);
    expect(src).toMatch(/this\._pendingToolQuery = toolQuery \? \{ id, query: toolQuery \} : null;/);
    // setActive early-returns for the active view; a purpose onto the showing tile must still land.
    expect(src).toMatch(/if \(toolQuery && this\.activeView === id && this\.onViewChange\) this\.onViewChange\(id\);/);
    // consumed on read — a later plain click renders the tile's own URL again.
    expect(src).toMatch(/consumeToolQuery\(viewId\) \{[\s\S]*?this\._pendingToolQuery = null;[\s\S]*?return pending\.query;/);
  });

  it('is appended to the tile\'s OWN iframeUrl after the artifact ref, never used as a URL', () => {
    const src = read(CONTROLLER);
    const at = src.indexOf("const toolQuery = ribbon?.consumeToolQuery?.(viewId);");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toMatch(/if \(toolQuery\) bustedUrl \+= '&' \+ toolQuery;/);
    // It rides the same busted URL the tile always loads — no separate navigation path exists.
    expect(src.indexOf('let bustedUrl = String(iframeUrl)')).toBeLessThan(at);
  });

  it('ships a new cockpit shell cache so installed PWAs pick the change up', () => {
    const sw = read('src/pages/cockpit/service-worker.js');
    const version = Number(/const CACHE_VERSION = 'oshal-cockpit-v(\d+)'/.exec(sw)?.[1]);
    expect(version).toBeGreaterThanOrEqual(36);
  });
});
