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
  createClineBackedRungProvider,
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
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', {
        OSHAL_PROVIDER_FALLBACK_ORDER: 'claude-code, anthropic  gemini',
      })).toEqual(['claude-code', 'anthropic', 'gemini']);
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', {
        OSHAL_PROVIDER_FALLBACK_ORDER: 'none',
      })).toEqual([]);
    });

    it('the node-local kill switch beats a configured chain, as .env.example promises', () => {
      // "Set false to disable provider failover on this node entirely, whatever is configured
      // above." It was read AFTER the configured order had already returned, so it could never
      // fire in either arm while compose passed it to every bot.
      const configured = { OSHAL_PROVIDER_FALLBACK_ORDER: 'claude-code,cline-cli' };
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', configured))
        .toEqual(['claude-code', 'cline-cli']);

      for (const off of ['false', 'off', 'none', 'FALSE', ' Off ']) {
        expect(
          resolveBotNodeProviderFallbackOrder('openai-codex', { ...configured, OSHAL_PROVIDER_AUTO_FAILOVER: off }),
          `${off} must disable failover on this node`,
        ).toEqual([]);
      }
      // Anything else leaves the administrator's chain alone — it is opt-OUT, not opt-in.
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', { ...configured, OSHAL_PROVIDER_AUTO_FAILOVER: 'true' }))
        .toEqual(['claude-code', 'cline-cli']);
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', { ...configured, OSHAL_PROVIDER_AUTO_FAILOVER: '' }))
        .toEqual(['claude-code', 'cline-cli']);
    });

    it('invents no chain when nothing is configured', () => {
      // The outage shape: a chain this file made up, that no setting could change.
      //
      // An EXPLICIT empty env, not a deleted key: the resolver reads five variables and this case
      // has to establish "unconfigured" for all five. Deleting one and inheriting the shell for
      // the rest is what made the sibling guard in codex-default-floor.spec.ts go red from
      // ambient environment, and the variable that breaks it is the one this feature tells
      // operators to set.
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', {})).toEqual([]);
    });
  });

  describe('a recovery is attributed to the provider that actually answered', () => {
    it('a three-rung chain names the THIRD provider, not the first fallback', async () => {
      // An administrator's order folds into A->(B->(C)). The record used to be rebuilt by the
      // outermost wrapper after the spread, so when C answered it still read "A -> B" — every
      // recovery credited to the first rung, which is the number someone reads to decide which
      // vendor is failing and which to drop.
      const fail = (name: string) => ({
        // The message must be failover-ELIGIBLE, or the wrapper rethrows instead of walking the
        // chain: the classifier looks for throttle/quota/auth/stall shapes, not plain prose.
        generateResponse: async () => { throw new Error(`${name}: 429 quota exhausted`); },
      });
      const answer = (name: string) => ({
        generateResponse: async () => ({ content: 'done', provider: name, usage: {}, cost: 0 }),
      });
      const providers: Record<string, any> = {
        'claude-code': fail('claude-code'),
        'openai-codex': fail('openai-codex'),
        'cline-cli': answer('cline-cli'),
      };

      const wrapped: any = maybeWrapBotNodeProviderFailover(
        fail('primary'), 'gemini-runtime', providers,
        ['claude-code', 'openai-codex', 'cline-cli'],
        { clineApiProviders: [] },
      );
      const response = await wrapped.generateResponse([{ role: 'user', content: 'go' }], {});

      expect(response.providerFailover.answered, 'the provider that produced the answer').toBe('cline-cli');
      expect(response.providerFailover.chain, 'every provider walked, in order').toEqual(
        ['gemini-runtime', 'claude-code', 'openai-codex', 'cline-cli'],
      );
      expect(response.provider).toBe('cline-cli');
    });
  });

  describe('a rung may name any provider the catalog knows, not only a runtime key', () => {
    const RUNTIMES = (): Record<string, any> => ({
      'claude-code': { id: 'claude-code' },
      'openai-codex': { id: 'openai-codex' },
      'cline-cli': { id: 'cline-cli', generateResponse: async () => ({ ok: true }) },
      'antigravity-cli': { id: 'antigravity-cli' },
    });
    const CATALOG = ['openrouter', 'anthropic', 'gemini'];

    /** Unwrap the nesting and read the realized rung order back out. */
    function rungNames(wrapped: any): string[] {
      const names: string[] = [];
      let node: any = wrapped;
      while (node && node.fallback) { names.push(node.fallbackName); node = node.fallback; }
      return names;
    }

    it('realizes every rung of a mixed chain, not just the native one', () => {
      // The exact chain .env.example and the cockpit placeholder advertise. Before the rung
      // translator this realized as ONE rung: openrouter and anthropic are not runtime keys, so
      // indexing the three-key runtime map dropped them into a log line nothing surfaces.
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        { id: 'primary' }, 'gemini-runtime', RUNTIMES(),
        ['claude-code', 'openrouter', 'anthropic'],
        { clineApiProviders: CATALOG },
      );
      expect(rungNames(wrapped)).toEqual(['claude-code', 'openrouter', 'anthropic']);
    });

    it('keeps two Cline-backed rungs distinct instead of collapsing them onto one runtime', () => {
      // Both execute on cline-cli. Deduping on the runtime key alone silently discarded the
      // second vendor in the order the administrator wrote.
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        { id: 'primary' }, 'openai-codex', RUNTIMES(),
        ['openrouter', 'anthropic'],
        { clineApiProviders: CATALOG },
      );
      expect(rungNames(wrapped)).toEqual(['openrouter', 'anthropic']);
    });

    it('a Cline-backed rung fronts its OWN vendor and restores what it found', async () => {
      const env: NodeJS.ProcessEnv = { CLINE_API_PROVIDER: 'gemini', CLINE_API_MODEL: 'gemini-3.8-flash' };
      const seen: Array<string | undefined> = [];
      const runtime = {
        id: 'cline-cli',
        generateResponse: async () => { seen.push(env.CLINE_API_PROVIDER); return { ok: true }; },
      };
      const rung = createClineBackedRungProvider(runtime, 'anthropic', env);

      await rung.generateResponse([], {});

      expect(seen, 'the rung must run on the vendor it names').toEqual(['anthropic']);
      // Restored to what was there on ENTRY, not to the container seeds: an active primary that
      // is itself Cline-backed must keep its own backing when a rung returns.
      expect(env.CLINE_API_PROVIDER).toBe('gemini');
      expect(env.CLINE_API_MODEL).toBe('gemini-3.8-flash');
    });

    it('a rung does not inherit another vendor model, and restores an absent key as absent', async () => {
      const env: NodeJS.ProcessEnv = { CLINE_API_MODEL: 'gpt-5.5' };
      let modelDuringCall: string | undefined = 'unset';
      const runtime = {
        generateResponse: async () => { modelDuringCall = env.CLINE_API_MODEL; return { ok: true }; },
      };
      await createClineBackedRungProvider(runtime, 'anthropic', env).generateResponse([], {});
      // fallback_order stores provider ids only, so there is no per-rung model. Carrying the
      // primary vendor model id would fail as a wrong-model error, not as the failover it is.
      expect(modelDuringCall).toBeUndefined();
      expect(env.CLINE_API_MODEL).toBe('gpt-5.5');
      expect(env.CLINE_API_PROVIDER).toBeUndefined();
    });

    it('restores the backing even when the rung throws', async () => {
      const env: NodeJS.ProcessEnv = { CLINE_API_PROVIDER: 'gemini' };
      const runtime = { generateResponse: async () => { throw new Error('vendor 429'); } };
      await expect(
        createClineBackedRungProvider(runtime, 'anthropic', env).generateResponse([], {}),
      ).rejects.toThrow('vendor 429');
      expect(env.CLINE_API_PROVIDER).toBe('gemini');
    });

    it('never makes the primary a rung of itself, even when named by its backing id', () => {
      // cline-cli fronting anthropic IS the primary here; listing anthropic must not produce a
      // rung that re-spawns the vendor that just failed.
      const providers = RUNTIMES();
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        providers['cline-cli'], 'anthropic', providers,
        ['anthropic', 'claude-code'],
        { clineApiProviders: CATALOG },
      );
      expect(rungNames(wrapped)).toEqual(['claude-code']);
    });

    it('only a harness with no bot-node runtime produces no rung', () => {
      // gemini-cli remains api-side-only. Antigravity now has a real built runtime and therefore
      // survives as a rung; this assertion moves with the same HARNESS_BY_ID table as dispatch.
      //
      // This case exists because the opposite was asserted in SEVEN durable places (ROADMAP row,
      // four change-log entries, two JSDoc blocks) and was false in all of them. A claim that
      // nothing executes is a claim that rots silently.
      const wrapped: any = maybeWrapBotNodeProviderFailover(
        { id: 'primary' }, 'openai-codex', RUNTIMES(),
        ['gemini-cli', 'antigravity-cli'],
        { clineApiProviders: CATALOG },
      );
      expect(rungNames(wrapped)).toEqual(['antigravity-cli']);

      // ...while the API-provider id for the same vendor IS usable, which is the distinction the
      // corrected wording has to preserve: selectable api-side, and 'gemini' works as a rung.
      const viaApiId: any = maybeWrapBotNodeProviderFailover(
        { id: 'primary' }, 'openai-codex', RUNTIMES(),
        ['gemini'],
        { clineApiProviders: CATALOG },
      );
      expect(rungNames(viaApiId)).toEqual(['gemini']);
    });

    it('delegates every other member to the runtime it wraps', () => {
      const runtime = { getModelInfo: () => ({ model: 'x' }), id: 'cline-cli', generateResponse: async () => ({}) };
      const rung = createClineBackedRungProvider(runtime, 'anthropic', {});
      expect(rung.getModelInfo()).toEqual({ model: 'x' });
      expect(rung.id).toBe('cline-cli');
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
      // Quoting-independent, and scoped to EXECUTABLE code. The old form matched only
      // single-quoted ids, so the placeholder copy — which names three providers, unquoted,
      // inside a template string — sailed through an assertion titled "must name no provider".
      //
      // Example ids in placeholder text are legitimate: they show an administrator what a chain
      // looks like. What must never appear is a provider id used as LOGIC. So the check strips
      // comments and the placeholder attribute, then looks for any known id however it is spelled.
      const executable = surface
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/placeholder="[^"]*"/g, '');
      const namedProviders = executable.match(
        /\b(claude-code|openai-codex|codex-cli|cline-cli|gemini-cli|openrouter)\b/g,
      );
      expect(namedProviders, 'no provider id may appear in this surface as logic').toBeNull();
    });
  });

  describe('no provider may be named in the failover path', () => {
    // These were three source greps scoped to function bodies located with indexOf, so renaming a
    // function or moving code out of its body turned them green on a live violation — the exact
    // guard shape this repo has a rule against, and I wrote them. The real guard is behavioural:
    // the resolver cannot have an opinion about providers it has never heard of.
    it('treats provider names it has never seen exactly as it treats the familiar ones', () => {
      const invented = ['vendor-alpha', 'vendor-beta', 'vendor-gamma'];
      expect(
        resolveBotNodeProviderFallbackOrder('vendor-omega', { OSHAL_PROVIDER_FALLBACK_ORDER: invented.join(',') }),
        'an unknown primary and three unknown rungs must survive intact and in order',
      ).toEqual(invented);

      // Reversed, it is a different chain — order is the administrator's, never normalised.
      const reversed = [...invented].reverse();
      expect(resolveBotNodeProviderFallbackOrder('vendor-omega', {
        OSHAL_PROVIDER_FALLBACK_ORDER: reversed.join(','),
      })).toEqual(reversed);
    });

    it('invents nothing for a primary it does recognise', () => {
      // The outage shape in its strongest form: every provider this file knows by name, asked with
      // an empty environment, must produce nothing. A map hidden anywhere in the module reddens
      // this regardless of which function it lives in or what that function is called.
      for (const primary of ['claude-code', 'openai-codex', 'cline-cli', 'codex-cli', 'cline', 'gemini']) {
        expect(
          resolveBotNodeProviderFallbackOrder(primary, {}),
          `${primary} must have no chain of its own`,
        ).toEqual([]);
      }
    });

    it('is the administrator who removes a provider from a chain, not this module', () => {
      // A vendor exclusion used to be encoded as a missing array entry, so restoring it required
      // editing code. Any id the administrator writes is a rung, including one previously dropped.
      expect(resolveBotNodeProviderFallbackOrder('openai-codex', {
        OSHAL_PROVIDER_FALLBACK_ORDER: 'claude-code',
      })).toEqual(['claude-code']);
    });

    // Kept as a COMPANION to the behavioural cases above, not as the evidence: it is cheap and it
    // names the exact literal that caused the outage, but a rename defeats it and that is fine
    // because the cases above do not care what anything is called.
    it('companion check: the literal Record that caused the outage is not back', () => {
      const source = readFileSync(RUNTIME_SOURCE, 'utf8');
      expect(source, 'the literal Record is the defect; it must not return')
        .not.toMatch(/fallbackOrder\s*:\s*Record</);
    });
  });
});
