/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the unattended CLI denial into a dependency-free policy module so controller-side preflight callers do not import the bot-node harness runtime.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: export isUnbrokeredAutonomousProvider so the chat entry points can test "would this registry harness be refused?" against the ONE policy set instead of duplicating it. The refusal itself is unchanged.
 */

const UNBROKERED_AUTONOMOUS_PROVIDERS: ReadonlySet<string> = new Set([
  'cline',
  'codex-cli',
  'claude-code',
  'gemini-cli',
]);

/**
 * @description Whether a provider/harness id names an unbrokered autonomous local CLI —
 * exactly the set {@link assertAuditedAutonomousHarness} refuses unconditionally on the
 * controller. Chat entry points use this predicate to resolve a hosted user brain BEFORE
 * a turn would hit that refusal; it never weakens the refusal itself.
 * @param providerType - Runtime provider / registry harnessType id.
 * @returns True when the id is one of the refused local CLI harnesses.
 */
export function isUnbrokeredAutonomousProvider(providerType: string): boolean {
  return UNBROKERED_AUTONOMOUS_PROVIDERS.has(providerType);
}

/**
 * @description Fail closed before an unattended model-visible CLI can allocate a workspace
 * or start a child process. These providers may be restored only behind a separately audited
 * brokered sandbox that enforces immutable grants and keeps credentials outside the CLI.
 * This dependency-free policy is safe for both controller and bot-node preflight paths.
 * @param providerType - Exact runtime provider selected for this request.
 * @throws Error with code UNBROKERED_AUTONOMOUS_PROVIDER for uncontained CLI runtimes.
 */
export function assertAuditedAutonomousHarness(providerType: string): void {
  if (!isUnbrokeredAutonomousProvider(providerType)) return;
  const error = new Error(
    `${providerType} unattended execution is disabled: select a hosted provider or an audited OSHAL brokered sandbox`,
  ) as Error & { code: string };
  error.code = 'UNBROKERED_AUTONOMOUS_PROVIDER';
  throw error;
}
