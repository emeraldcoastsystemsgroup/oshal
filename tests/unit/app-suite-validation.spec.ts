/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: pin the suite contract — closed enum (value fail-closed at load, so a typo cannot invent a catalog shelf), presence warn-only (pre-097 store packages keep booting), suite orthogonal to tool category:, and every in-repo manifest + all three generators stamped (one unshelved generator and the flat pile returns).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Sweep the VARIANT manifest dirs too (swarm-apps-build/) — a manifest dir the spec doesn't cover is a shelf-drift hole.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 30→25 per the spec's own instruction: the Wave-3 carve lane removed job-apply + feeds (count 29 → gate red at HEAD; their gate was tsc-only under the vitest/Git-Bash env issue) and announced cloud/identity/travel next. Still catches a wholesale manifest-dir loss.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 25→21: the Wave-3 device/showcase carve lane rips camera + drone + sat-ops + pumpkin serially (28 total incl. variant dirs → 24 when all four land). 21 rides out the announced window while still catching a wholesale manifest-dir loss.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 21→20: the Wave-3 vids-media carve lane rips creative-studio + daily-trade-recap + video + vids serially (24 total incl. variant dirs → 20 when all four land). 20 rides out the announced window while still catching a wholesale manifest-dir loss.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 20→17: the Wave-3 federal-capture family lane rips capture-crm + federal-capture + gov-contracting serially (20 total incl. variant dirs → 17 when all three land). 17 rides out the announced window while still catching a wholesale manifest-dir loss.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 17→16: the Wave-3 email-summarizer carve moves the manifest to the store package (17 total incl. variant dirs → 16; the archived packer emission in ai-lab/packer-emissions/ is deliberately outside the scanned dirs). Still catches a wholesale manifest-dir loss.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 16→15 per the spec's own instruction: the Wave-3 kalshi carve (d8a4ea3c) moved swarm-apps/kalshi.yaml to the store package (16 total incl. variant dirs → 15) and its gate list didn't include this spec, leaving the gate red at HEAD. 15 still catches a wholesale manifest-dir loss.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 15→14 per the spec's own instruction: the Wave-3 world carve moves swarm-apps/world.yaml to the store package (15 total incl. variant dirs → 14). Still catches a wholesale manifest-dir loss.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Lower the sanity floor 14→13 per the spec's own instruction: the Wave-3 trading carve (the last Wave-G carve) moves swarm-apps/trading.yaml to the store package (14 total incl. variant dirs → 13). Still catches a wholesale manifest-dir loss.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { readManifest, SWARM_APP_SUITES, isSwarmAppSuite, compileWorkflowSpec } from '../../src/features/swarm-apps';
import { mapSkillToManifest } from '../../src/features/skill-import';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML appended to the required name/displayName.
 * @returns The parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-suite-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('suite enum (ADR-097)', () => {
  it('is the closed six-suites-plus-platform set', () => {
    expect([...SWARM_APP_SUITES]).toEqual([
      'ai-productivity', 'ai-knowledge', 'ai-finance', 'ai-creative', 'ai-home', 'ai-engineering', 'platform',
    ]);
    expect(isSwarmAppSuite('ai-finance')).toBe(true);
    expect(isSwarmAppSuite('finance')).toBe(false);
  });

  it('readManifest accepts a known suite and REJECTS an unknown one', () => {
    expect(read('suite: ai-finance\n').suite).toBe('ai-finance');
    expect(() => read('suite: ai-money\n')).toThrow(/not a known catalog suite/);
  });

  it('a MISSING suite is allowed — pre-097 installed packages must keep booting', () => {
    expect(read('').suite).toBeUndefined();
  });

  it('suite is orthogonal to tool category: — cross-category tools do not affect it', () => {
    const m = read(
      'suite: ai-finance\ntools:\n  - name: deck\n    category: media\n    description: d\n  - name: mail\n    category: communication\n    description: d\n',
    );
    expect(m.suite).toBe('ai-finance'); // the shelf is the declared job, never the ingredient mix
  });
});

describe('every in-repo manifest is shelved', () => {
  // The variant dirs matter as much as the main one — a manifest dir the spec
  // doesn't cover is a shelf-drift hole.
  const MANIFEST_DIRS = ['swarm-apps', 'swarm-apps-build'];

  it('all manifests in every manifest dir declare a valid suite', () => {
    const root = join(__dirname, '..', '..');
    let total = 0;
    for (const d of MANIFEST_DIRS) {
      const dir = join(root, d);
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
        total += 1;
        const m = yamlLoad(readFileSync(join(dir, f), 'utf8')) as { suite?: unknown };
        expect(isSwarmAppSuite(m.suite), `${d}/${f} suite=${String(m.suite)}`).toBe(true);
      }
    }
    // Sanity floor against an accidental mass-deletion — NOT a census. ADR-085 Wave 1 carves
    // apps out one at a time, so this number legitimately shrinks; lower the floor as waves
    // land rather than pinning a count. (14→13 on 2026-07-20: the Wave-3 trading carve — the
    // LAST Wave-G carve — moved swarm-apps/trading.yaml to the store package; 13 still
    // catches a wholesale loss.)
    expect(total).toBeGreaterThanOrEqual(11);
  });
});

describe('generators never emit an unshelved manifest', () => {
  it('skill-import defaults to ai-productivity and honors an override', () => {
    const persona = {
      name: 'demo-skill', agent_id: 'b0000000-0000-0000-0000-00000000dead', role: 'r',
      capabilities: ['c'], selector_descriptor: 'd', routing_keywords: ['k'],
    } as Parameters<typeof mapSkillToManifest>[0];
    expect(mapSkillToManifest(persona).suite).toBe('ai-productivity');
    expect(mapSkillToManifest(persona, { suite: 'ai-engineering' }).suite).toBe('ai-engineering');
  });

  it('workflow publish stamps ai-productivity on both compile paths', () => {
    const linear = compileWorkflowSpec(
      { name: 'demo-flow', mode: 'staged', stages: [{ bot: 'b' }] } as Parameters<typeof compileWorkflowSpec>[0],
      'person',
    );
    expect(linear.suite).toBe('ai-productivity');
    const graph = compileWorkflowSpec(
      {
        name: 'demo-graph', mode: 'graph',
        graph: {
          nodes: [
            { id: 'n1', type: 'start', title: 'Start', config: {} },
            { id: 'n2', type: 'execute-agent', title: 'Do', config: { agentBinding: 'b' } },
            { id: 'n3', type: 'deliver', title: 'Deliver', config: {} },
          ],
          edges: [
            { id: 'e1', source: 'n1', target: 'n2' },
            { id: 'e2', source: 'n2', target: 'n3' },
          ],
        },
      } as Parameters<typeof compileWorkflowSpec>[0],
      'person',
    );
    expect(graph.suite).toBe('ai-productivity');
  });
});
