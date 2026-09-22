/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: define the explicit persisted-tool to any-bot runtime capability map; unknown names fail closed and completion remains a side-effect-free control capability.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bind the read-only question tools. Every name this map held was a shell, a file write or an infrastructure CLI, so the only thing a granted bot could be advertised was a way to ACT; the tools that let one ANSWER - retrieval, the caller's own graph, the caller's own conversation history - had no binding at all and were denied here as unmapped no matter what the operator granted. The three added names resolve to the handlers bot-node-read-only-tools.ts registers on the bot-node registry. Deliberately absent: rag-ingestion, whose sibling name differs by one word and which WRITES.
 */

/** Side-effect-free protocol control understood by AgenticController. */
export const ANY_BOT_COMPLETION_TOOL = 'attempt_completion';

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
