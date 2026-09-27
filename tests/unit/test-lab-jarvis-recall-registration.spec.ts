/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Jarvis cross-conversation recall card is registered exactly once, is explicit-only so "Run live scenarios" never spends its model turn, keeps every attached suite on disk, and the case module it requires ships in the api image (scripts/lib is both allowlisted and copied), which is what lets the deployed card and the staged live proof run the same code.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The card and 'jarvis-routing' both carry the Antigravity host-tool-loop guard, the fix for the defect this card's first live run found.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenariosForRun } from '@/app/routes/test-lab-scenarios';
import { JARVIS_RECALL_SCENARIOS } from '@/app/routes/test-lab-jarvis-recall-scenarios';

describe('Jarvis cross-conversation recall Test Lab card', () => {
  it('is registered once, with one step and suites that exist on disk', () => {
    const [scenario] = JARVIS_RECALL_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === 'jarvis-cross-thread-recall')).toEqual([scenario]);
    expect(scenario.group).toBe('jarvis');
    expect(scenario.steps.map((s) => s.id)).toEqual(['jarvis-recall-other-thread']);
    expect(scenario.regressionTests!.map((t) => t.path)).toEqual(expect.arrayContaining([
      'tests/unit/jarvis-recall-acceptance.spec.ts', 'tests/unit/jarvis-recall-acceptance-postgres.spec.ts',
      'tests/unit/antigravity-host-tool-loop.spec.ts',
    ]));
    const routing = SCENARIOS.find((s) => s.id === 'jarvis-routing');
    expect(routing?.regressionTests?.map((t) => t.path)).toContain('tests/unit/antigravity-host-tool-loop.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.description).toContain('ONE real model turn');
  });

  it('never runs from a run-all, only from its own card', () => {
    const all = scenariosForRun('all');
    expect(all.map((s) => s.id)).not.toContain('jarvis-cross-thread-recall');
    expect(all.length).toBe(SCENARIOS.filter((s) => !s.explicitOnly).length);
    expect(all.length).toBeGreaterThan(10);
    expect(scenariosForRun('jarvis-cross-thread-recall').map((s) => s.id)).toEqual(['jarvis-cross-thread-recall']);
    expect(scenariosForRun('no-such-card')).toEqual([]);
  });

  it('ships the shared case module in the api image', () => {
    expect(existsSync('scripts/lib/jarvis-recall-acceptance.js')).toBe(true);
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^!scripts\/lib\/\*\.js$/m);
    expect(readFileSync('Dockerfile.oshal', 'utf8')).toMatch(/^COPY scripts\/lib\/\*\.js \.\/scripts\/lib\/$/m);
  });
});
