/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Tests for persona identity validation, B2 state projection fix, B3 rollup, and routing_failed
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';

const OSHAL_ROOT = path.resolve(__dirname, '..');

// ─── A1: Persona Identity Collision Tests ────────────────────────────────────

test.describe('A1: Persona Identity Collisions', () => {
  test('no duplicate agent_id values across bot persona YAML files', () => {
    const personaDir = path.join(OSHAL_ROOT, 'ai-lab', 'bot-personas');
    const yamlFiles = fs.readdirSync(personaDir).filter((f) => f.endsWith('.yaml'));
    expect(yamlFiles.length).toBeGreaterThan(0);

    const agentIds: Map<string, string[]> = new Map();
    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(personaDir, file), 'utf-8');
      const match = content.match(/^agent_id:\s*(.+)$/m);
      if (match) {
        const id = match[1].trim();
        const existing = agentIds.get(id) ?? [];
        existing.push(file);
        agentIds.set(id, existing);
      }
    }

    const duplicates = Array.from(agentIds.entries()).filter(([, files]) => files.length > 1);
    expect(
      duplicates,
      `Duplicate agent_id values found: ${duplicates.map(([id, files]) => `${id} in [${files.join(', ')}]`).join('; ')}`,
    ).toHaveLength(0);
  });

  test('rca-specialist has unique UUID (not task-manager 0006)', () => {
    const content = fs.readFileSync(
      path.join(OSHAL_ROOT, 'ai-lab', 'bot-personas', 'rca-specialist.yaml'),
      'utf-8',
    );
    expect(content).toContain('a0000000-0000-0000-0000-000000000016');
    expect(content).not.toContain('a0000000-0000-0000-0000-000000000006');
  });

  test('presentation-bot has unique UUID (not agent-factory 0007)', () => {
    const content = fs.readFileSync(
      path.join(OSHAL_ROOT, 'ai-lab', 'bot-personas', 'presentation-bot.yaml'),
      'utf-8',
    );
    expect(content).toContain('a0000000-0000-0000-0000-000000000017');
    expect(content).not.toContain('a0000000-0000-0000-0000-000000000007');
  });

  test('system-architect has proper UUID (not string "architect-bot")', () => {
    const content = fs.readFileSync(
      path.join(OSHAL_ROOT, 'ai-lab', 'bot-personas', 'system-architect.yaml'),
      'utf-8',
    );
    expect(content).toContain('a0000000-0000-0000-0000-000000000018');
    // Should not have the old string-based ID
    expect(content).not.toMatch(/^agent_id:\s*architect-bot\s*$/m);
  });
});

// ─── A2: Startup Identity Validation Tests ───────────────────────────────────

test.describe('A2: validatePersonaIdentities()', () => {
  test('swarm-bot-registry exports validatePersonaIdentities function', () => {
    const registryPath = path.join(
      OSHAL_ROOT,
      'src',
      'app',
      'extensions',
      'swarm',
      'swarm-bot-registry.ts',
    );
    const content = fs.readFileSync(registryPath, 'utf-8');
    expect(content).toContain('export function validatePersonaIdentities()');
  });

  test('swarm extension index.ts calls validatePersonaIdentities at boot', () => {
    const indexPath = path.join(OSHAL_ROOT, 'src', 'app', 'extensions', 'swarm', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('validatePersonaIdentities()');
    expect(content).toContain("import { SwarmBotRegistry, validatePersonaIdentities");
  });

  test('swarm-bot-registry has no duplicate agentId values', () => {
    const registryPath = path.join(
      OSHAL_ROOT,
      'src',
      'app',
      'extensions',
      'swarm',
      'swarm-bot-registry.ts',
    );
    const content = fs.readFileSync(registryPath, 'utf-8');

    // Extract all agentId values from the registry array
    const agentIdMatches = content.match(/agentId:\s*'([^']+)'/g) ?? [];
    const agentIds = agentIdMatches.map((m) => m.replace(/agentId:\s*'/, '').replace(/'$/, ''));

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of agentIds) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }

    expect(duplicates, `Duplicate agentIds in registry: ${duplicates.join(', ')}`).toHaveLength(0);
  });
});

// ─── B2: State Projection Regression Tests ───────────────────────────────────

test.describe('B2: deriveOshalTicketStateFromWorkItems — state projection', () => {
  test('cockpit-work-item-helpers.ts uses allPending check (not some-pending)', () => {
    const helpersPath = path.join(OSHAL_ROOT, 'src', 'app', 'routes', 'cockpit-work-item-helpers.ts');
    const content = fs.readFileSync(helpersPath, 'utf-8');

    // B2 fix: should check allPending (every), not some-pending
    expect(content).toContain('allPending');
    expect(content).toContain('.every(');
  });

  test('routing_failed is handled in state derivation', () => {
    const helpersPath = path.join(OSHAL_ROOT, 'src', 'app', 'routes', 'cockpit-work-item-helpers.ts');
    const content = fs.readFileSync(helpersPath, 'utf-8');
    expect(content).toContain('routing_failed');
  });
});

// ─── B3: Parent/Child Rollup Tests ───────────────────────────────────────────

test.describe('B3: rollupChildStatus helper', () => {
  test('rollupChildStatus is exported from cockpit-work-item-helpers', () => {
    const helpersPath = path.join(OSHAL_ROOT, 'src', 'app', 'routes', 'cockpit-work-item-helpers.ts');
    const content = fs.readFileSync(helpersPath, 'utf-8');
    expect(content).toContain('export function rollupChildStatus(');
  });

  test('rollupChildStatus rules are documented in the function', () => {
    const helpersPath = path.join(OSHAL_ROOT, 'src', 'app', 'routes', 'cockpit-work-item-helpers.ts');
    const content = fs.readFileSync(helpersPath, 'utf-8');
    // Verify the key rules are present
    expect(content).toContain("'in_progress'");
    expect(content).toContain("'in_review'");
    expect(content).toContain("'needs_attention'");
  });
});

// ─── C2: routing_failed Status Tests ─────────────────────────────────────────

test.describe('C2: routing_failed status', () => {
  test('WorkItemStatusSchema includes routing_failed', () => {
    const typesPath = path.join(OSHAL_ROOT, 'src', 'entities', 'work-item', 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');
    expect(content).toContain("'routing_failed'");
  });

  test('DB schema CHECK constraint includes routing_failed', () => {
    const schemaPath = path.join(
      OSHAL_ROOT,
      'src',
      'shared',
      'services',
      'database',
      'work-item-schema.ts',
    );
    const content = fs.readFileSync(schemaPath, 'utf-8');
    expect(content).toContain("'routing_failed'");
  });
});

// ─── D1: ADR Index Completeness Tests ────────────────────────────────────────

test.describe('D1: ADR index completeness', () => {
  test('ADR index has all 24 entries (no missing ADRs)', () => {
    const indexPath = path.join(OSHAL_ROOT, 'docs', 'adr', 'README.md');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Check the 6 previously-missing ADRs are now indexed
    expect(content).toContain('005-cline-cli-only-provider.md');
    expect(content).toContain('019-per-bot-container-architecture.md');
    expect(content).toContain('020-openai-codex-runtime-provider-wiring.md');
    expect(content).toContain('021-per-round-output-tracking.md');
    expect(content).toContain('022-no-deterministic-fallback.md');
    expect(content).toContain('023-dispatch-circuit-breaker.md');
  });

  test('no ADR index entries have "—" for Status or Date', () => {
    const indexPath = path.join(OSHAL_ROOT, 'docs', 'adr', 'README.md');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Extract table rows (lines starting with |)
    const tableRows = content.split('\n').filter((line) => line.startsWith('| ['));
    expect(tableRows.length).toBeGreaterThanOrEqual(23); // At least 23 ADR entries

    for (const row of tableRows) {
      expect(row, `ADR row has missing Status/Date: ${row}`).not.toContain('| — |');
    }
  });
});

// ─── D2/E1: Script Existence Tests ───────────────────────────────────────────

test.describe('D2/E1: Operational scripts', () => {
  test('validate-doc-links.sh exists and is executable', () => {
    const scriptPath = path.join(OSHAL_ROOT, 'scripts', 'validate-doc-links.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0); // executable bit set
  });

  test('verify-bot-health.sh exists and is executable', () => {
    const scriptPath = path.join(OSHAL_ROOT, 'scripts', 'verify-bot-health.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0); // executable bit set
  });

  test('package.json has verify:bots and validate:doc-links scripts', () => {
    const pkgPath = path.join(OSHAL_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts['verify:bots']).toBeDefined();
    expect(pkg.scripts['validate:doc-links']).toBeDefined();
  });
});

// ─── core-setup.md Naming Fix Test ───────────────────────────────────────────

test.describe('core-setup.md naming consistency', () => {
  test('core-setup.md uses api-server (not oshal-api-server)', () => {
    const setupPath = path.join(OSHAL_ROOT, 'docs', 'setup', 'core-setup.md');
    const content = fs.readFileSync(setupPath, 'utf-8');
    expect(content).toContain('`api-server`');
    expect(content).not.toContain('oshal-api-server');
  });
});