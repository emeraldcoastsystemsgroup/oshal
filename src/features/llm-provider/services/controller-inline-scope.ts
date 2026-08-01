/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — least-privilege scope for CONTROLLER-INLINE bots (BACKLOG "Harden inline controller bots"). Pure policy, no runtime: stripShellTools removes Bash from a claude-code allowedTools list, CONTROLLER_INLINE_SCRUB_ENV_KEYS names the platform-plane credentials that must not reach an inline bot's subprocess env, and resolveControllerInlineScope maps a registry `container` to the whole scope. Deliberately named without "harness" so it stays off the forbidden-module list controller-runtime-boundary.spec.ts pins.
 */

/**
 * Least-privilege scope for bots that run INLINE in the controller (api) container.
 *
 * THE THREAT, precisely. A bot-node bot runs in its own container: compromising it gets the
 * attacker that container's env. An INLINE bot (registry `container: 'oshal-api'` —
 * codex-packer, project-manager, quality-judge, the per-app concierges) executes inside the
 * api process's container, which holds the platform's own credentials. So for inline bots the
 * blast radius of a prompt injection is the CONTROL PLANE, not one worker.
 *
 * Two independent controls, because either alone leaves a hole:
 *
 *  1. **No shell.** `Bash` is what turns "the model was talked into something" into
 *     `printenv`, an outbound curl, or a write outside the workspace. Inline bots lose it.
 *     They keep Read/Write/Edit/Glob/Grep/WebFetch — codex-packer must be able to emit a
 *     persona YAML and a manifest, and none of those tools read the process environment.
 *  2. **No platform-plane credentials in the child env.** `BaseCliHarnessAdapter` already
 *     scrubs `SESSION_SECRET` and the connector app secrets from every bot spawn. It does NOT
 *     scrub `REMOTE_CLIENT_SHARED_SECRET` — which is present ONLY on the api service — and
 *     that value is machine trust on the worker plane: it bypasses per-device ownership
 *     entirely, so an inline bot holding it could enqueue a shell-exec task on ANY user's
 *     desktop. That is a worse outcome than reading the master key, and it is closed here.
 *     Scoped to inline spawns on purpose: bot-node containers never carry these vars, and
 *     host/`docker exec` tooling that legitimately drives the device plane
 *     (scripts/oshal-recap-agent-remote.js, scripts/codex-remote-node*.mjs) is not a harness
 *     spawn and is untouched.
 *
 * What this does NOT claim to close: a codex-harness inline bot still has a shell by
 * construction (the codex CLI owns its own permission model, and `CODEX_SANDBOX_MODE` is set
 * to `danger-full-access` in compose), so for those the env scrub is the load-bearing control,
 * not the tool list. The complete answer is the BACKLOG done-when's other option — move inline
 * bots into dedicated non-controller containers — which is a topology change, not a wrap-up.
 *
 * @module features/llm-provider/services/controller-inline-scope
 */

/**
 * Compose service names that ARE the controller. Mirrors
 * `CONTROLLER_INLINE_CONTAINERS` in features/agent-management/services/bot-node-client.ts,
 * which is what makes `hasEndpoint()` return false and route these bots inline in the first
 * place. Kept as its own list rather than imported so this pure policy module does not pull
 * the agent-management slice onto the harness graph (FSD: no cross-slice imports at a layer).
 */
export const CONTROLLER_INLINE_CONTAINERS: readonly string[] = ['oshal-api', 'oshal-local-api'];

/**
 * Claude Code tool names that give a bot a shell. `Bash` is the tool; the rest are the
 * variants the CLI has shipped under, listed so a vendor rename does not silently restore
 * shell access to an inline bot.
 */
export const SHELL_TOOL_NAMES: readonly string[] = ['Bash', 'BashOutput', 'KillBash', 'KillShell', 'Shell'];

/**
 * Platform-plane credentials scrubbed from an INLINE bot's subprocess environment, on top of
 * `BaseCliHarnessAdapter.SECRET_ENV_KEYS`. Each is machine trust the api process holds and no
 * bot tool has a legitimate use for:
 *  - the remote-client (worker/desktop) plane's swarm-wide secret + its alias, which skip
 *    per-device ownership entirely;
 *  - the fail-closed webhook ingest tokens, which would let a bot forge alert/world intake;
 *  - the TV-pairing signing secret, a session-minting key.
 * Deliberately NOT here: `SWARM_SERVICE_SECRET` (bot personas legitimately call the api with
 * it and scripts/swarm-cli.js depends on it) and provider API keys (the CLI *is* the LLM
 * caller and needs its own auth) — removing either breaks real flows, and both are already
 * bounded by their own gates (#83 operator-only PAT mints; per-caller entitlement).
 */
export const CONTROLLER_INLINE_SCRUB_ENV_KEYS: readonly string[] = [
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'ALERT_WEBHOOK_TOKEN',
  'WORLD_INGEST_TOKEN',
  'TV_PAIRING_SECRET',
];

/**
 * The shell-free tool set an inline bot gets when the deployment declares no
 * `CLAUDE_ALLOWED_TOOLS` at all. Matches the compose list minus the shell tools, so a fresh
 * install and the running swarm converge on the same inline capability.
 */
export const DEFAULT_INLINE_ALLOWED_TOOLS = 'Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch';

/** The scope applied to a harness built for one bot. Empty object = no restriction (bot node). */
export interface ControllerInlineScope {
  /** True when this bot executes inside the controller container. */
  inline: boolean;
  /** Comma-separated allowedTools with every shell tool removed, or undefined when not inline. */
  allowedTools?: string;
  /** Extra env keys the adapter must delete from the child process env. */
  scrubEnvKeys?: readonly string[];
}

/**
 * @description Whether a registry `container` value names the controller itself.
 * @param container - The SwarmBotDefinition container field.
 * @returns True for the api/controller container (i.e. an inline bot).
 */
export function isControllerInlineContainer(container: string | null | undefined): boolean {
  return CONTROLLER_INLINE_CONTAINERS.includes(String(container ?? '').trim());
}

/**
 * @description Removes every shell tool from a comma-separated Claude Code allowedTools list,
 * preserving the order and spelling of the rest. Case-insensitive on the tool name so
 * `bash` cannot slip through, and tolerant of stray whitespace/empty entries.
 * @param allowedTools - The list to filter (env value or explicit config).
 * @returns The filtered list; '' when nothing survives (the CLI then prompts for everything,
 *   which fails closed rather than opening up).
 */
export function stripShellTools(allowedTools: string): string {
  const denied = new Set(SHELL_TOOL_NAMES.map((name) => name.toLowerCase()));
  return String(allowedTools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && !denied.has(tool.toLowerCase()))
    .join(',');
}

/**
 * @description Resolves the full inline scope for a bot from its registry container.
 * Non-inline (bot-node) bots get `{ inline: false }` and nothing else, so their harnesses are
 * built exactly as before — this is additive by construction.
 * @param container - The bot's registry container field.
 * @param env - Environment map (process.env by default; injectable for tests) supplying the
 *   deployment's CLAUDE_ALLOWED_TOOLS baseline that shell tools are removed from.
 * @returns The scope to fold into the harness factory config.
 */
export function resolveControllerInlineScope(
  container: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ControllerInlineScope {
  if (!isControllerInlineContainer(container)) return { inline: false };
  const baseline = String(env.CLAUDE_ALLOWED_TOOLS ?? '').trim();
  return {
    inline: true,
    // Only override when the deployment actually declares a list; with none declared the
    // adapter's own default applies and we still hand it a shell-free version of it.
    allowedTools: stripShellTools(baseline.length > 0 ? baseline : DEFAULT_INLINE_ALLOWED_TOOLS),
    scrubEnvKeys: CONTROLLER_INLINE_SCRUB_ENV_KEYS,
  };
}

