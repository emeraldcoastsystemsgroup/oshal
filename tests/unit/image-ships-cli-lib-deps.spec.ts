/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Cross-check every require('./lib/…') in the shipped connector CLIs against .dockerignore and Dockerfile.oshal. The helpers were extracted to scripts/lib/ and 36 require sites re-pointed, but the image build's allowlist (.dockerignore) and COPY set (Dockerfile) were never updated — so every image built after the extraction shipped CLIs that die at load, and the in-process bridge took the eats/purchasing/rides/travel route mounts down with it (2026-08-06). Static three-artifact check: it goes red the day a CLI grows a lib dependency the image will not carry, at commit time instead of in a deploy log.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = 'scripts';
const DOCKERIGNORE = readFileSync('.dockerignore', 'utf8');
const DOCKERFILE = readFileSync('Dockerfile.oshal', 'utf8');

/** Every ./lib/<name> module id required by any shipped oshal-*.js CLI. */
function libRequiresOfShippedClis(): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  for (const file of readdirSync(SCRIPTS_DIR)) {
    if (!/^oshal-.*\.js$/.test(file)) continue;
    const source = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.\/lib\/[^'"]+)['"]\s*\)/g)) {
      const id = match[1];
      if (!byModule.has(id)) byModule.set(id, []);
      byModule.get(id)!.push(file);
    }
  }
  return byModule;
}

describe('the image carries every lib helper the shipped CLIs require', () => {
  const requires = libRequiresOfShippedClis();

  it('found the require sites this guard exists for (sanity: the extraction is real)', () => {
    // If this ever legitimately reaches zero (helpers inlined again), delete this spec with the
    // Dockerfile COPY rather than letting it assert vacuously.
    expect(requires.size, 'no ./lib requires found — has the extraction been reverted?').toBeGreaterThan(0);
  });

  it('resolves every required module to a real tracked file', () => {
    for (const [id, callers] of requires) {
      const rel = join(SCRIPTS_DIR, id.replace(/^\.\//, ''));
      const found = ['', '.js', '.cjs'].some((ext) => existsSync(rel + ext));
      expect(found, `${id} (required by ${callers.join(', ')}) does not exist under scripts/`).toBe(true);
    }
  });

  it('allowlists the helpers in .dockerignore so they reach the build context', () => {
    // scripts/ is excluded wholesale; each survivor is a negation. The helpers ship as
    // scripts/lib/*.js — top level only, so lib's .ts tooling and subdirectories stay out.
    expect(DOCKERIGNORE, '.dockerignore no longer allowlists scripts/lib/*.js').toMatch(/^!scripts\/lib\/\*\.js$/m);
    for (const [id, callers] of requires) {
      // Every required id must be covered by that top-level *.js allowlist. A nested id
      // (./lib/google-workspace/x) would silently miss it — fail here, not in the container.
      expect(id, `${id} (required by ${callers.join(', ')}) is nested under lib/ — the *.js allowlist and COPY do not cover subdirectories; extend BOTH and this spec`).toMatch(/^\.\/lib\/[^/]+$/);
    }
  });

  it('COPYs the helpers in Dockerfile.oshal so they reach the image', () => {
    expect(DOCKERFILE, 'Dockerfile.oshal no longer copies scripts/lib/*.js').toMatch(/^COPY scripts\/lib\/\*\.js \.\/scripts\/lib\/$/m);
  });

  it('keeps the CLIs themselves shipped — the lib fix rides on the existing glob pair', () => {
    expect(DOCKERIGNORE).toMatch(/^!scripts\/oshal-\*\.js$/m);
    expect(DOCKERFILE).toMatch(/^COPY scripts\/oshal-\*\.js \.\/scripts\/$/m);
  });
});
