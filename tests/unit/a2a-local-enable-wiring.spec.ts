/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the a2a-local-prod enable path (BACKLOG Plan F): the bug shape is "the operator flips A2A_GATEWAY_ENABLED=true in .env but the surface stays 404" (compose passthrough removed / defaulted) or its inverse (a shipped default silently enabling the surface). Pins: compose passes A2A_GATEWAY_ENABLED, A2A_PUBLIC_BASE_URL, and A2A_MAX_INBOUND_PER_HOUR through with EMPTY defaults; .env.example documents the enable line but only COMMENTED (default-off in any copied env); the strict === 'true' gate treats the compose empty default as OFF; and the enable runbook (docs/runbooks/a2a-gateway-local-enable.md) exists with the flip line, card probe, and disabled=404 re-proof, indexed in the runbooks README.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isA2aGatewayEnabled } from '@/features/a2a-gateway';

const repoRoot = process.cwd();

/**
 * @description Reads a repo-root-relative file as UTF-8 for wiring assertions.
 * @param rel - Path relative to the repo root.
 * @returns The file content.
 */
function readRepoFile(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('a2a local enable wiring (BACKLOG Plan F — a2a-local-prod)', () => {
  it('compose passes the inbound gateway env through with EMPTY defaults (flip in .env reaches the container; nothing enables by default)', () => {
    const compose = readRepoFile('docker-compose.oshal-local.yml');
    // Passthrough must exist AND default to empty — `${VAR:-}` — so the .env flip is
    // the single flip point and a missing .env line means OFF, never ON.
    expect(compose).toMatch(/A2A_GATEWAY_ENABLED:\s*\$\{A2A_GATEWAY_ENABLED:-\}/);
    expect(compose).toMatch(/A2A_PUBLIC_BASE_URL:\s*\$\{A2A_PUBLIC_BASE_URL:-\}/);
    expect(compose).toMatch(/A2A_MAX_INBOUND_PER_HOUR:\s*\$\{A2A_MAX_INBOUND_PER_HOUR:-\}/);
    // No truthy compose-side default may ever be introduced for the enable flag.
    expect(compose).not.toMatch(/A2A_GATEWAY_ENABLED:\s*\$\{A2A_GATEWAY_ENABLED:-\s*true\s*\}/i);
  });

  it('the compose empty default is OFF under the strict gate (structurally 404 until the operator opts in)', () => {
    // What the container sees with no .env line: the compose `${A2A_GATEWAY_ENABLED:-}`
    // empty-string default. Must read as disabled.
    expect(isA2aGatewayEnabled({ A2A_GATEWAY_ENABLED: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isA2aGatewayEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    // The documented flip value must read as enabled.
    expect(isA2aGatewayEnabled({ A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('.env.example documents the enable line COMMENTED-only (a copied example env never enables the surface)', () => {
    const example = readRepoFile('.env.example');
    // The exact flip line is documented for the operator…
    expect(example).toMatch(/^#\s*A2A_GATEWAY_ENABLED=true\s*$/m);
    // …but no ACTIVE (uncommented) assignment exists anywhere in the example.
    expect(example).not.toMatch(/^\s*A2A_GATEWAY_ENABLED=/m);
    // And the example points at the enable runbook so the flip is done with its
    // verification steps, not from memory.
    expect(example).toContain('docs/runbooks/a2a-gateway-local-enable.md');
  });

  it('the enable runbook exists with the flip line, the card probe, and the disabled=404 re-proof, and is indexed', () => {
    const runbook = readRepoFile('docs/runbooks/a2a-gateway-local-enable.md');
    expect(runbook).toContain('A2A_GATEWAY_ENABLED=true');
    expect(runbook).toContain('/.well-known/agent-card.json');
    expect(runbook).toContain('scripts/migrations/089-a2a-gateway.sql');
    // Rollback / default-off re-proof must be part of the procedure.
    expect(runbook.toLowerCase()).toContain('404');
    expect(runbook).toMatch(/rollback/i);
    const index = readRepoFile('docs/runbooks/README.md');
    expect(index).toContain('a2a-gateway-local-enable.md');
  });
});
