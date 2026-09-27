/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | JVV-007 guard: jarvis.html imports no third-party module at render time (the floating mermaid@11 jsDelivr import is gone and loads the same-origin /dist/vendor/mermaid copy instead), and the build's own vendorMermaidRuntime writes a self-contained runtime — every relative import in the entry and in every chunk resolves to a vendored file — whose VERSION is the exact version package-lock.json pins. The browser behaviour (hydration, offline text fallback, no CDN request) is proven in tests/unit/shared-response-surfaces-browser.spec.ts.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { vendorMermaidRuntime } from '../../vite.config';

const ROOT = path.resolve(__dirname, '../..');
const JARVIS = readFileSync(path.join(ROOT, 'src/api/jarvis.html'), 'utf8');
const outDir = mkdtempSync(path.join(tmpdir(), 'oshal-mermaid-vendor-spec-'));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

/** Every static or dynamic module specifier in one ES module source. */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

describe('Jarvis diagram runtime is same-origin (JVV-007)', () => {
  it('imports no module from a third-party origin and loads the vendored mermaid build', () => {
    expect(JARVIS).not.toMatch(/cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|skypack/i);
    expect(JARVIS).not.toMatch(/import\(\s*['"]https?:/i);
    expect(JARVIS).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(JARVIS).toContain("import('/dist/vendor/mermaid/mermaid.esm.min.mjs')");
    expect(JARVIS).toContain("securityLevel: 'strict'");
  });

  it('vendors a self-contained runtime at the lock-pinned version', () => {
    const { files, version } = vendorMermaidRuntime(outDir);
    const vendored = path.join(outDir, 'vendor', 'mermaid');
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(version).toBe(lock.packages['node_modules/mermaid'].version);
    expect(readFileSync(path.join(vendored, 'VERSION'), 'utf8').trim()).toBe(version);

    const modules = [path.join(vendored, 'mermaid.esm.min.mjs'),
      ...readdirSync(path.join(vendored, 'chunks', 'mermaid.esm.min')).map((name) => path.join(vendored, 'chunks', 'mermaid.esm.min', name))];
    expect(modules).toHaveLength(files);
    const unresolved: string[] = [];
    for (const file of modules) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        if (!existsSync(path.resolve(path.dirname(file), specifier))) unresolved.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    expect(unresolved).toEqual([]);
    // Nothing but the entry, chunks and VERSION: no source maps or package internals ride along.
    expect(readdirSync(vendored).sort()).toEqual(['VERSION', 'chunks', 'mermaid.esm.min.mjs']);
  });

  it('rebuilds the target from scratch so a version bump leaves no stale chunk', () => {
    const stale = path.join(outDir, 'vendor', 'mermaid', 'chunks', 'mermaid.esm.min', 'chunk-STALE.mjs');
    vendorMermaidRuntime(outDir);
    writeFileSync(stale, 'export {};');
    vendorMermaidRuntime(outDir);
    expect(existsSync(stale)).toBe(false);
  });

  it('fails the build when the mermaid runtime is missing instead of shipping Jarvis without diagrams', () => {
    expect(() => vendorMermaidRuntime(outDir, path.join(outDir, 'no-such-mermaid'))).toThrow(/mermaid runtime not found/);
  });
});
