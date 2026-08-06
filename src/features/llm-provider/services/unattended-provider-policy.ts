/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the unattended CLI denial into a dependency-free policy module so controller-side preflight callers do not import the bot-node harness runtime.
 */

const UNBROKERED_AUTONOMOUS_PROVIDERS: ReadonlySet<string> = new Set([
  'cline',
  'codex-cli',
  'claude-code',
  'gemini-cli',
]);

/**
 * @description Fail closed before an unattended model-visible CLI can allocate a workspace
 * or start a child process. These providers may be restored only behind a separately audited
 * brokered sandbox that enforces immutable grants and keeps credentials outside the CLI.
 * This dependency-free policy is safe for both controller and bot-node preflight paths.
 * @param providerType - Exact runtime provider selected for this request.
 * @throws Error with code UNBROKERED_AUTONOMOUS_PROVIDER for uncontained CLI runtimes.
 */
export function assertAuditedAutonomousHarness(providerType: string): void {
  if (!UNBROKERED_AUTONOMOUS_PROVIDERS.has(providerType)) return;
  const error = new Error(
    `${providerType} unattended execution is disabled: select a hosted provider or an audited OSHAL brokered sandbox`,
  ) as Error & { code: string };
  error.code = 'UNBROKERED_AUTONOMOUS_PROVIDER';
  throw error;
}
