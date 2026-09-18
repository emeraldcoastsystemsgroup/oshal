/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard compose-no-bot-provider-literal ("A bot's LLM provider is a row in a table"): no service in any tracked compose file may carry FORCE_LLM_PROVIDER / FORCE_LLM_MODEL / CODEX_MODEL / CLAUDE_CODE_MODEL / CLINE_API_PROVIDER / CLINE_API_MODEL as a LITERAL — every value must be a ${VAR:-default} interpolation, so the env seed is deployment configuration and never fights the switch row's model. On 2026-09-17 eighteen bot services carried FORCE_LLM_PROVIDER: openai-codex / FORCE_LLM_MODEL: gpt-5.5 literals overriding the x-bot-env interpolation, and a bot switched to gemini failed with 'models/gpt-5.5 is not found'. The guard also proves the removal did not change what renders: with the FORCE_LLM_* env unset, `docker compose config` is not required — the x-bot-env anchor's defaults are asserted to be exactly the literals that were removed, so the rendered value is identical by construction.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
/** Env keys that seed a bot's provider/model. A literal here hardcodes what the switch row governs. */
const PROVIDER_SEED_KEYS = ['FORCE_LLM_PROVIDER', 'FORCE_LLM_MODEL', 'CODEX_MODEL', 'CLAUDE_CODE_MODEL', 'CLINE_API_PROVIDER', 'CLINE_API_MODEL'];
const KEY_LINE = new RegExp(`^(\\s*)(${PROVIDER_SEED_KEYS.join('|')}):\\s*(.*?)\\s*$`);

function composeFiles(): string[] {
  return readdirSync(ROOT).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)).sort();
}

/** Every provider-seed assignment whose value is not a ${...} interpolation, with its location. */
function literalSeeds(file: string): string[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
  const hits: string[] = [];
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const match = KEY_LINE.exec(line);
    if (!match) return;
    const value = match[3].replace(/^["']|["']$/g, '');
    if (!value.startsWith('${')) hits.push(`${file}:${index + 1} ${match[2]}: ${value}`);
  });
  return hits;
}

describe('compose-no-bot-provider-literal', () => {
  it('scans every tracked compose file (the guard is not pointed at one path)', () => {
    const files = composeFiles();
    expect(files).toContain('docker-compose.oshal-local.yml');
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('no service carries a provider/model seed as a literal — every value is a ${VAR:-default} interpolation', () => {
    const hits = composeFiles().flatMap(literalSeeds);
    expect(
      hits,
      'A literal provider/model seed hardcodes what the switch row (agent_config / fleet-default) governs. '
        + 'Use ${FORCE_LLM_PROVIDER:-…} / ${FORCE_LLM_MODEL:-…} (or a per-service ${X_LLM_PROVIDER:-…}) instead.',
    ).toEqual([]);
  });

  it('the x-bot-env defaults are exactly the literals that were removed, so the render is byte-identical with the env unset', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.oshal-local.yml'), 'utf8');
    expect(compose).toMatch(/^\s*FORCE_LLM_PROVIDER: \$\{FORCE_LLM_PROVIDER:-openai-codex\}$/m);
    expect(compose).toMatch(/^\s*FORCE_LLM_MODEL: \$\{FORCE_LLM_MODEL:-gpt-5\.5\}$/m);
    // The guard goes red on the exact shape that was removed, not only on new spellings.
    expect(literalSeeds('docker-compose.oshal-local.yml')).toEqual([]);
    expect(compose).not.toMatch(/^\s+FORCE_LLM_PROVIDER: openai-codex$/m);
    expect(compose).not.toMatch(/^\s+FORCE_LLM_MODEL: gpt-5\.5$/m);
  });
});
