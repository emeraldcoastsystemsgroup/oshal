/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track the intentionally-conservative glass sheet: assert a retained framework card class (.queue-card) instead of .wf-card, which commit 7ac71804 deliberately removed so the shared sheet stops hijacking app-internal layouts
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GLASS_HREF = '/shared/ui/css/surface-glass.css';
const SURFACE_ROOTS = ['src/api', 'src/pages', 'any-bot/server/services/tools'];

describe('shared surface glass stylesheet', () => {
  it('ships the shared glass stylesheet', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/shared/ui/css/surface-glass.css'), 'utf8');
    expect(css).toContain('--oshal-glass-bg');
    expect(css).toContain('backdrop-filter');
    expect(css).toContain('.connector-card');
    expect(css).toContain('.queue-card');
  });

  it('is loaded by every standalone HTML surface with a head element', () => {
    const missing = discoverHtmlSurfaces()
      .filter((file) => {
        const html = fs.readFileSync(file, 'utf8');
        return /<\/head>/i.test(html) && !html.includes(GLASS_HREF);
      })
      .map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/'));

    expect(missing).toEqual([]);
  });
});

function discoverHtmlSurfaces(): string[] {
  const out: string[] = [];
  for (const root of SURFACE_ROOTS) {
    const abs = path.resolve(process.cwd(), root);
    if (fs.existsSync(abs)) walk(abs, out);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.html$/i.test(entry.name)) {
      out.push(full);
    }
  }
}
