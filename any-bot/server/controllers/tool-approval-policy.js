/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted the autonomous-path tool-approval decision out of AgenticController (which is at 961 lines) so the one rule that stands between an injected prompt and a shell is directly testable, and so its history is written down. Behaviour is byte-for-byte what AgenticController implemented inline; the only addition is NEVER_AUTO_APPROVE, which is a no-op today and becomes load-bearing the moment someone flips a registry flag.
 */

/**
 * Tools the unattended path must NEVER auto-approve, whatever the caller passes.
 *
 * Today this is belt-and-braces: `execute_command` is declared `requiresApproval: true` in the
 * baseline registry, so the check below already refuses it. It exists because that registry flag
 * is one edit away from `false`, and on the autonomous path there is no human to catch it.
 */
const NEVER_AUTO_APPROVE = new Set(['execute_command']);

/**
 * @description Decides whether a tool call may execute without human approval on the autonomous
 * (ticket-dispatch) path, where by definition nobody is present to approve.
 *
 * A NOTE ON THE FLAG NAME, because it looks like a bug and removing it would open a hole:
 * every caller — AgentDispatchEngine, ClineCLIWrapper, the front door — passes per-tool keys
 * (`{ execute_command: true, write_to_file: true, … }`), while this policy reads the legacy
 * `commandExecution` key that none of them set. The net effect is that nothing is auto-approved
 * on the unattended path, which is the correct posture and is what ships today. "Fixing" the key
 * to match the callers would silently switch shell, file writes and MCP calls to auto-approved
 * for prompt-injectable bots. If that is ever wanted it must be a deliberate, reviewed change
 * with its own threat assessment — not a rename. tests/unit/tool-approval-policy.spec.ts pins it.
 *
 * @param {Record<string, boolean>|undefined} autoApprove - caller-supplied auto-approval flags.
 * @param {string} toolName - registry name of the tool being invoked.
 * @param {boolean} requiresApproval - the registry's declared approval requirement for that tool.
 * @returns {boolean} true only when the call may proceed with no human in the loop.
 */
function shouldAutoApproveTool(autoApprove, toolName, requiresApproval) {
  if (requiresApproval) return false;
  if (NEVER_AUTO_APPROVE.has(toolName)) return false;
  return Boolean((autoApprove || {}).commandExecution);
}

module.exports = { shouldAutoApproveTool, NEVER_AUTO_APPROVE };
