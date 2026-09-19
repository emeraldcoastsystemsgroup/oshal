/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: define the explicit persisted-tool to any-bot runtime capability map; unknown names fail closed and completion remains a side-effect-free control capability.
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
