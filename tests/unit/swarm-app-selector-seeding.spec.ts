import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = process.cwd();

describe('swarm app selector seeding', () => {
  it('allows manifest bot declarations to carry selector metadata', () => {
    const src = readFileSync(join(repoRoot, 'src/features/swarm-apps/types.ts'), 'utf8');
    expect(src).toMatch(/selectorDescriptor\?:\s*string/);
    expect(src).toMatch(/routingKeywords\?:\s*string\[\]/);
  });

  it('seeds app bot selector fields into the agents table', () => {
    const src = readFileSync(join(repoRoot, 'src/features/swarm-apps/services/swarm-app-service.ts'), 'utf8');
    expect(src).toContain('readBotSelectorSeed');
    expect(src).toContain('selector_descriptor');
    expect(src).toContain('routing_keywords');
    expect(src).toContain('base_selector_descriptor');
    expect(src).toContain('base_routing_keywords');
  });
});
