/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: define the explicit persisted-tool to any-bot runtime capability map; unknown names fail closed and completion remains a side-effect-free control capability.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bind the read-only question tools. Every name this map held was a shell, a file write or an infrastructure CLI, so the only thing a granted bot could be advertised was a way to ACT; the tools that let one ANSWER - retrieval, the caller's own graph, and the caller's own conversation history - had no binding at all and were denied here as unmapped no matter what the operator granted. The three added names resolve to the handlers bot-node-read-only-tools.ts registers on the bot-node registry. Deliberately absent: rag-ingestion, whose sibling name differs by one word and which WRITES.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind the exact conversation-fetch capability beside conversation-query so the persisted tool assignment cannot advertise a handler that the bot-node registry does not expose.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The image-turn tool table (ADR-130 amendment 2026-10-02, SEC-05 carve for image turns): the native image tool an image turn's authority rebind may name, per harness the render bot runs. The 2026-10-02 live render was refused by the model itself because the only text naming generate_image sat inside a data-only record under an authority of [attempt_completion]; the rebind must name the tool the server-authored instruction asks for. Only a tool proven live is listed (agy's generate_image, the name any-bot's agy-image-turn.js collects from). The codex CLI's native image generation produced images on 2026-08-22 but its tool name was never recorded, so a codex image turn carries no image tool here.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER, the marker between an Antigravity image-turn refusal's own words and its untrusted diagnostic (operator decision 2026-10-03, clearer Guard A refusals). Shared so the bot-node handler re-attaches the diagnostic behind it where an error leaves the node, and the api's render provider splits on the same string; the node's own classifiers (provider failover) never see it.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ANY_BOT_IMAGE_TURN_ERROR_REFUSAL and ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY (operator decision 2026-10-03: "Retry, max 3, fresh turns"): Guard A's fixed words for a generate_image step that ran and ended in ERROR, and its own [backoff] category for one whose tool error read as a quota or rate limit. The api's antigravity render provider retries a render as a fresh turn only when a failed attempt's error message ends with them; both are pinned equal to agy-image-turn.js's ENDED_IN_ERROR_REFUSAL and BACKOFF_CATEGORY.
 */

/** Side-effect-free protocol control understood by AgenticController. */
export const ANY_BOT_COMPLETION_TOOL = 'attempt_completion';

/**
 * Where an Antigravity image-turn refusal's own words end and its untrusted diagnostic (the image
 * tool's error text, the model's final reply) begins: DIAGNOSTIC_MARKER in
 * any-bot/server/services/codebase/agy-image-turn.js. The node keeps that diagnostic off every error
 * message and stderr it classifies (provider failover among them) and re-attaches it behind this
 * marker only where the error leaves the node (bot-node-execution-handler); the api's render provider
 * splits on it again so its own callers never classify tool or model text either.
 */
export const ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER = ' | untrusted diagnostic: ';

/**
 * Guard A's own words for an Antigravity image turn whose generate_image step ran and ended in ERROR,
 * from the start of the refusal (ENDED_IN_ERROR_REFUSAL in agy-image-turn.js). The api's render provider
 * retries a render as a fresh turn only when a failed attempt's error MESSAGE ends with these words,
 * alone or followed by ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY; it never reads the untrusted diagnostic for it.
 */
export const ANY_BOT_IMAGE_TURN_ERROR_REFUSAL = 'image turn refused: the event stream shows no generate_image tool step that reached DONE: generate_image ran and ended in ERROR';

/**
 * Guard A's own category after that refusal when the image tool's error read as a quota or rate limit
 * (BACKOFF_CATEGORY in agy-image-turn.js): the api waits longer before its fresh retry. Its words match
 * none of the node's provider failover patterns, which read the refusal's own words.
 */
export const ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY = ' [backoff]';

/** Exact runtime scope required at the operation boundary for completion. */
export const ANY_BOT_COMPLETION_SCOPE = 'control:attempt_completion';

const PERSISTED_TO_RUNTIME_TOOL: Readonly<Record<string, string>> = Object.freeze({
  bash: 'execute_command',
  'read-file': 'read_file',
  'write-file': 'write_to_file',
  execute_command: 'execute_command',
  read_file: 'read_file',
  write_to_file: 'write_to_file',
  'aws-cli': 'cli_aws',
  kubectl: 'cli_kubectl',
  gcloud: 'cli_gcloud',
  'azure-cli': 'cli_azure',
  helm: 'cli_helm',
  argocd: 'cli_argocd',
  terraform: 'cli_terraform',
  ansible: 'cli_ansible',
  vault: 'cli_vault',
  git: 'cli_git',
  yq: 'cli_yq',
  // Read-only question tools (bot-node-read-only-tools.ts). Owner-scoped reads, no shell, no
  // cloud CLI, no write path. `rag-ingestion` is NOT here and must not be added: it ingests.
  'rag-query': 'rag_query',
  'graph-query': 'graph_query',
  'conversation-query': 'conversation_query',
  'conversation-fetch': 'conversation_fetch',
});

/**
 * @description Resolves one persisted registry name to the exact callable any-bot name.
 * There is deliberately no punctuation normalization or identity fallback: a newly registered
 * name cannot acquire a runtime handler until this reviewed map explicitly binds it.
 * @param persistedName - Exact name loaded from the authoritative tool assignment.
 * @returns Exact any-bot runtime name, or undefined when no reviewed binding exists.
 */
export function anyBotRuntimeToolFor(persistedName: string): string | undefined {
  return PERSISTED_TO_RUNTIME_TOOL[persistedName];
}

/** @description Exact operation scope required for one runtime tool invocation. */
export function anyBotRuntimeToolScope(runtimeTool: string): string {
  return `tool:${runtimeTool}`;
}

/**
 * The native image tool an image turn (ADR-130) names in its authority rebind, per harness. A
 * harness absent here has no recorded image tool: its image turns keep the completion floor alone.
 * The antigravity entry is the name agy showed in the 2026-10-02 headless proof and the one
 * any-bot/server/services/codebase/agy-image-turn.js (Guard A) requires to reach DONE.
 */
const IMAGE_TURN_TOOL_BY_HARNESS: Readonly<Record<string, string>> = Object.freeze({
  'antigravity-cli': 'generate_image',
});

/**
 * @description The native image tool an image turn may invoke on a harness, or undefined when no
 * tool has been recorded for it. Read by the bot-node handler to widen an image turn's authority
 * to exactly that tool beside the completion floor; it is never read for any other turn.
 * @param harness - The provider id the render bot runs, as its runtime record names it.
 * @returns The exact tool name, or undefined.
 */
export function anyBotImageTurnToolFor(harness: string | null | undefined): string | undefined {
  const key = String(harness ?? '').trim().toLowerCase();
  return key ? IMAGE_TURN_TOOL_BY_HARNESS[key] : undefined;
}
