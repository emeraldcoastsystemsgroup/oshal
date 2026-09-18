/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The bot-node half of "a bot's LLM provider is a row in a table". A switch row names a provider id as an operator writes it — a harness key (codex-cli, claude-code, cline) or a Cline-backed API provider id (gemini, anthropic, openrouter, ...). The bot node runs three JS runtimes (openai-codex, claude-code, cline-cli), and the Cline wrapper picks its backing provider from CLINE_API_PROVIDER / CLINE_API_MODEL before every spawn (ClineCLIWrapper._resolveBackingProvider, precedence 1). So: resolveBotNodeSwitch translates the row's id into the runtime that executes it plus the backing provider it must front, createClineBackingEnv sets/clears those two env keys around a switch (restoring the container's own seeds when the bot moves back to codex/claude), and dispatchProviderMatches keeps the ADR-034 "what ran == what was authorized" check honest across the translation: a carried 'gemini' matches a runtime that reports cline-cli fronting gemini, and nothing else. An id neither runtime nor catalog knows resolves to null and the caller refuses by name — never a silent hop onto the container default.
 */

import { normalizePulledProviderName } from './bot-node-config-bootstrap';

/** The three runtimes a bot node builds. */
export type BotNodeRuntimeName = 'openai-codex' | 'claude-code' | 'cline-cli';

/** Where a switch id lands on this node. */
export interface BotNodeSwitchTarget {
  /** The built runtime that executes the id. */
  runtime: BotNodeRuntimeName;
  /** The Cline-backed API provider the runtime must front, or null for a native runtime. */
  apiProvider: string | null;
}

/** The live identity a bot node reports: runtime, model, and the backing provider when Cline fronts one. */
export interface BotNodeActiveIdentity {
  provider: string;
  model: string;
  apiProvider?: string | null;
}

/**
 * @description Translate a switch id into the runtime that executes it on this node.
 * @param requested - The id as the row names it (harness key, alias, or Cline-backed provider id).
 * @param built - The runtimes this node constructed at boot (name → instance, null when it failed).
 * @param clineApiProviders - The Cline-backed provider ids the platform defines (provider-definitions).
 * @returns The target, or null when neither a built runtime nor the catalog knows the id.
 */
export function resolveBotNodeSwitch(
  requested: string,
  built: Record<string, unknown>,
  clineApiProviders: readonly string[],
): BotNodeSwitchTarget | null {
  const trimmed = String(requested ?? '').trim();
  if (!trimmed) return null;
  const normalized = normalizePulledProviderName(trimmed);
  if (normalized in built && built[normalized]) {
    return { runtime: normalized as BotNodeRuntimeName, apiProvider: null };
  }
  if (!built['cline-cli']) return null;
  const key = trimmed.toLowerCase();
  const canonical = clineApiProviders.find((id) => id.toLowerCase() === key);
  return canonical ? { runtime: 'cline-cli', apiProvider: canonical } : null;
}

/** Sets and clears the Cline backing-provider env keys around a switch. */
export interface ClineBackingEnv {
  /**
   * Point Cline at a backing provider (and model), or restore the container's own seeds when the
   * bot moves onto a native runtime.
   */
  apply(apiProvider: string | null, model: string | undefined): string[];
}

/**
 * @description Build the env controller. The seeds present when it is created are what a
 * `null` apply restores, so a deployment that pinned CLINE_API_PROVIDER in compose keeps its pin
 * once the switch row no longer names a Cline-backed id.
 * @param env - Environment map to mutate (process.env in production; a plain object in tests).
 * @returns The controller.
 */
export function createClineBackingEnv(env: NodeJS.ProcessEnv = process.env): ClineBackingEnv {
  const seededProvider = env.CLINE_API_PROVIDER;
  const seededModel = env.CLINE_API_MODEL;
  const set = (key: string, value: string | undefined): void => {
    if (value === undefined) delete env[key]; else env[key] = value;
  };
  return {
    apply(apiProvider, model) {
      if (apiProvider) {
        set('CLINE_API_PROVIDER', apiProvider);
        set('CLINE_API_MODEL', model);
        return ['CLINE_API_PROVIDER', model ? 'CLINE_API_MODEL' : ''].filter(Boolean);
      }
      set('CLINE_API_PROVIDER', seededProvider);
      set('CLINE_API_MODEL', seededModel);
      return [];
    },
  };
}

/**
 * @description Does a carried provider id describe the runtime that is active? A native id must
 * normalize to the runtime name; a Cline-backed id must equal the backing provider the cline-cli
 * runtime is fronting. Case-insensitive on the backing id, because the catalog spells some ids
 * in camelCase and an operator does not.
 * @param carriedProviderId - The id the dispatch record carries (as the row names it).
 * @param active - The live identity the runtime reports.
 * @returns True when the active runtime is exactly what the record authorized.
 */
export function dispatchProviderMatches(carriedProviderId: string, active: BotNodeActiveIdentity): boolean {
  const carried = String(carriedProviderId ?? '').trim();
  if (normalizePulledProviderName(carried) === normalizePulledProviderName(active.provider)) return true;
  const backing = active.apiProvider ?? null;
  return backing !== null
    && normalizePulledProviderName(active.provider) === 'cline-cli'
    && backing.toLowerCase() === carried.toLowerCase();
}
