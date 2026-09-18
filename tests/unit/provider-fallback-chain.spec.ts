/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard for "an administrator defines as many LLMs as they want, and the order they fall back in" (operator, 2026-09-18). The defect it pins shut: src/app/bot-node-runtime.ts held a `'claude-code' | 'openai-codex' | 'cline-cli'` union on the failover wrapper and a Record literal mapping each of those three names to its hardcoded successors, so a fourth provider could never be a fallback and the order could not be changed by any setting. When the chain's remaining name ran out of tokens, recovery required editing and redeploying code. Two of these cases are SOURCE checks rather than behaviour: the defect was a type signature and a literal, and a behavioural test alone would stay green if someone reintroduced either one beside the new path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The configuration has to REACH a bot to be configuration: compose passes OSHAL_PROVIDER_FALLBACK_ORDER with an EMPTY default (a shipped default would itself be a hardcoded chain), .env.example ships the variable present and empty, and the cockpit control writes fallbackOrder while suggesting ids from the live provider list rather than any literal. An env var the containers never receive is a setting that silently does nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveProviderFallbackChain,
  type ProviderSwitchCatalog,
  type ProviderSwitchRow,
} from '../../src/shared/llm-runtime/bot-provider-switch';
import {
  maybeWrapBotNodeProviderFailover,
  resolveBotNodeProviderFallbackOrder,
} from '../../src/app/bot-node-runtime';

const RUNTIME_SOURCE = join(process.cwd(), 'src/app/bot-node-runtime.ts');

/** Every id the platform can run, as the api validates against. */
const CATALOG: ProviderSwitchCatalog = {
  harnessTypes: ['cline', 'codex-cli', 'claude-code', 'gemini-cli', 'a2a', 'noop'],
  clineApiProviders: ['gemini', 'anthropic', 'openrouter', 'openai', 'deepseek'],
};

/** A switch row carrying an administrator-written chain. */
function row(scopeId: string, providerId: string, fallbackOrder: string[] | null): ProviderSwitchRow {
  return { scopeId, providerId, modelId: null, updatedBy: 'operator', updatedAt: null, fallbackOrder };
}

describe('the provider fallback chain is configuration, not code', () => {
  describe('the ordered chain an administrator writes', () => {
    it('honours as many providers as the administrator lists, in the order written', () => {
      const chain = resolveProviderFallbackChain({
        fleetRow: row('fleet-default', 'gemini', ['claude-code', 'openrouter', 'anthropic', 'codex-cli']),
        primaryProviderId: 'gemini',
        catalog: CATALOG,
      });
      expect(chain.order).toEqual(['claude-code', 'openrouter', 'anthropic', 'codex-cli']);
      expect(chain.source).toBe('fleet-default');
      expect(chain.refused).toEqual([]);
    });

    it('reorders with no code change — the same four ids, a different order, is a different chain', () => {
      const first = resolveProviderFallbackChain({
        fleetRow: row('fleet-default', 'gemini', ['claude-code', 'codex-cli']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      const second = resolveProviderFallbackChain({
        fleetRow: row('fleet-default', 'gemini', ['codex-cli', 'claude-code']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      expect(first.order).toEqual(['claude-code', 'codex-cli']);
      expect(second.order).toEqual(['codex-cli', 'claude-code']);
    });

    it('lets a bot row override the fleet chain, matching the provider id precedence', () => {
      const chain = resolveProviderFallbackChain({
        botRow: row('bot-1', 'anthropic', ['gemini']),
        fleetRow: row('fleet-default', 'gemini', ['codex-cli', 'claude-code']),
        primaryProviderId: 'anthropic', catalog: CATALOG,
      });
      expect(chain.order).toEqual(['gemini']);
      expect(chain.source).toBe('bot-row');
    });

    it('treats an EMPTY chain as a decision, not an absence — it does not inherit', () => {
      // "Fail visibly rather than spend on a second vendor" has to be expressible, and it is the
      // one answer a null-means-inherit rule would silently discard.
      const chain = resolveProviderFallbackChain({
        botRow: row('bot-1', 'gemini', []),
        fleetRow: row('fleet-default', 'gemini', ['codex-cli']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      expect(chain.order).toEqual([]);
      expect(chain.source).toBe('bot-row');
    });

    it('falls to the next rung only when a row carries no chain at all', () => {
      const chain = resolveProviderFallbackChain({
        botRow: row('bot-1', 'gemini', null),
        fleetRow: row('fleet-default', 'gemini', ['claude-code']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      expect(chain.order).toEqual(['claude-code']);
      expect(chain.source).toBe('fleet-default');
    });

    it('drops an unrunnable id with a reason instead of disabling the whole chain', () => {
      const chain = resolveProviderFallbackChain({
        fleetRow: row('fleet-default', 'gemini', ['not-a-provider', 'claude-code']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      expect(chain.order, 'one bad entry must not cost the good ones').toEqual(['claude-code']);
      expect(chain.refused).toHaveLength(1);
      expect(chain.refused[0]?.providerId).toBe('not-a-provider');
      expect(chain.refused[0]?.reason, 'a dropped id must say why').toBeTruthy();
    });

    it('never lets a provider fail over to itself, however the administrator writes it', () => {
      const chain = resolveProviderFallbackChain({
        fleetRow: row('fleet-default', 'gemini', ['GEMINI', 'claude-code', 'claude-code']),
        primaryProviderId: 'gemini', catalog: CATALOG,
      });
      expect(chain.order).toEqual(['claude-code']);
    });
  });

  describe('the runtime walks the whole chain', () => {
    const ORIGINAL = { ...process.env };
    beforeEach(() => { delete process.env.OSHAL_PROVIDER_FALLBACK_ORDER; });
    afterEach(() => { process.env = { ...ORIGINAL }; });

    it('builds one rung per configured provider, so a chain of four is a chain of four', () => {
      const providers: Record<string, { id: string }> = {
        'claude-code': { id: 'claude-code' },
        'openai-codex': { id: 'openai-codex' },
        'cline-cli': { id: 'cline-cli' },
      };
      const primary = { id: 'primary' };
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        primary, 'gemini-runtime', providers, ['claude-code', 'openai-codex', 'cline-cli'],
      );
      // Unwrap the nesting and read the order back out. Three fallbacks => three nested rungs.
      const names: string[] = [];
      let node: any = wrapped;
      while (node && node.fallback) { names.push(node.fallbackName); node = node.fallback; }
      expect(names, 'every configured rung must be reachable, not just the first').toEqual(
        ['claude-code', 'openai-codex', 'cline-cli'],
      );
    });

    it('returns the bare provider when the administrator configured no chain', () => {
      const primary = { id: 'primary' };
      expect(maybeWrapBotNodeProviderFailover(primary, 'gemini-runtime', {}, [])).toBe(primary);
    });

    it('skips a configured provider with no runtime here rather than losing the rest', () => {
      const providers: Record<string, { id: string }> = { 'cline-cli': { id: 'cline-cli' } };
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        { id: 'primary' }, 'gemini-runtime', providers, ['claude-code', 'cline-cli'],
      );
      expect(wrapped.fallbackName).toBe('cline-cli');
    });

    it('reads an ordered list from configuration, and one name still works', () => {
      process.env.OSHAL_PROVIDER_FALLBACK_ORDER = 'claude-code, anthropic  gemini';
      expect(resolveBotNodeProviderFallbackOrder('openai-codex')).toEqual(
        ['claude-code', 'anthropic', 'gemini'],
      );
      process.env.OSHAL_PROVIDER_FALLBACK_ORDER = 'none';
      expect(resolveBotNodeProviderFallbackOrder('openai-codex')).toEqual([]);
    });

    it('invents no chain when nothing is configured', () => {
      // The outage shape: a chain this file made up, that no setting could change.
      expect(resolveBotNodeProviderFallbackOrder('openai-codex')).toEqual([]);
    });
  });

  describe('the configuration actually reaches a bot', () => {
    it('compose passes the ordered chain to every bot, with an empty default', () => {
      // "we better have an env that corialtes as well" - an env var the containers never receive
      // is a setting that silently does nothing, which is the shape this whole change exists to
      // delete. The empty default is load-bearing: a shipped default would BE a hardcoded chain.
      const compose = readFileSync(join(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
      expect(compose).toMatch(
        /OSHAL_PROVIDER_FALLBACK_ORDER:\s*\$\{OSHAL_PROVIDER_FALLBACK_ORDER:-\}/,
      );
    });

    it('.env.example documents the variable and ships it EMPTY', () => {
      const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
      expect(example).toContain('OSHAL_PROVIDER_FALLBACK_ORDER');
      const assignment = example
        .split(/\r?\n/)
        .find((line) => line.startsWith('OSHAL_PROVIDER_FALLBACK_ORDER='));
      expect(assignment, 'the variable must be present and uncommented, so it is visible')
        .toBe('OSHAL_PROVIDER_FALLBACK_ORDER=');
    });

    it('the cockpit control writes the chain and suggests only ids this deployment can run', () => {
      const surface = readFileSync(
        join(process.cwd(), 'src/pages/config-admin/config-admin-fleet-default.js'), 'utf8',
      );
      expect(surface, 'the write must carry the chain').toContain('fallbackOrder');
      expect(surface, 'suggestions come from the provider list, never a literal')
        .toMatch(/renderDatalist\(app\.state\.providers\)/);
      const providerLiterals = surface.match(
        /'(claude-code|openai-codex|codex-cli|cline-cli|gemini|anthropic|openrouter)'/g,
      );
      expect(providerLiterals, 'the surface must name no provider').toBeNull();
    });
  });

  describe('no provider may be named in the failover path', () => {
    it('has no hardcoded fallback map', () => {
      const source = readFileSync(RUNTIME_SOURCE, 'utf8');
      expect(source, 'the literal Record is the defect; it must not return')
        .not.toMatch(/fallbackOrder\s*:\s*Record</);
    });

    it('does not restrict the failover wrapper to a closed set of provider names', () => {
      const source = readFileSync(RUNTIME_SOURCE, 'utf8');
      const signature = source.slice(
        source.indexOf('export function maybeWrapBotNodeProviderFailover'),
        source.indexOf('export function resolveBotNodeProviderFallbackOrder'),
      );
      expect(signature.length, 'both functions must exist for this check to mean anything')
        .toBeGreaterThan(0);
      // A union of string literals in the parameter list is exactly what stopped a fourth
      // provider from ever being a fallback.
      const parameters = signature.slice(0, signature.indexOf('): any {'));
      expect(parameters, 'a closed provider union on the parameters is the defect')
        .not.toMatch(/'[a-z0-9-]+'\s*\|\s*'[a-z0-9-]+'/);
    });

    it('names no provider inside the order resolver', () => {
      const source = readFileSync(RUNTIME_SOURCE, 'utf8');
      const body = source.slice(
        source.indexOf('export function resolveBotNodeProviderFallbackOrder'),
        source.indexOf('export function normalizeProviderName'),
      );
      // The env var names and the off-switch vocabulary are configuration KEYS, not providers.
      const providerLiterals = body.match(
        /'(claude-code|openai-codex|codex-cli|cline-cli|cline|gemini|gemini-cli|anthropic|openrouter|openai)'/g,
      );
      expect(providerLiterals, 'the chain is the administrator’s, not this file’s').toBeNull();
    });
  });
});
