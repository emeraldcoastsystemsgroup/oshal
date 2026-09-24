/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted the autonomous-path tool-approval decision out of AgenticController (which is at 961 lines) so the one rule that stands between an injected prompt and a shell is directly testable, and so its history is written down. Behaviour is byte-for-byte what AgenticController implemented inline; the only addition is NEVER_AUTO_APPROVE, which is a no-op today and becomes load-bearing the moment someone flips a registry flag.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added cli_yq to NEVER_AUTO_APPROVE, as belt-and-braces ONLY. What refuses an unattended cli_yq call is `requiresApproval: true` on its registration (cliTools.js), set in the same change: all three consumers gate on `requiresApproval === true` before they consult this policy, so for a tool declared false this set is never reached. An earlier draft of this entry claimed the set itself stopped an unattended caller; that was wrong, was proved wrong by driving the real dispatch executor, and is corrected here.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added cli_cline, cli_jq, cli_fzf to NEVER_AUTO_APPROVE as belt-and-braces beside requiresApproval:true in cliTools.js.
 */

/**
 * Tools the unattended path must NEVER auto-approve, whatever the caller passes.
 *
 * READ THIS BEFORE ADDING A NAME HERE, because the set is weaker than it looks. Every consumer
 * of this policy — AgenticController, dispatch-tool-executor, ToolRegistry.execute — refuses with
 * `requiresApproval && !approved`. The registry flag is the gate; this set only decides whether
 * an ALREADY-gated tool can be auto-approved. Listing a `requiresApproval: false` tool here
 * therefore refuses nothing: the refusal branch is never entered and the auto-approve answer is
 * never read. A name added here without the registration flag is a guard that cannot fire.
 *
 * Both entries are declared `requiresApproval: true` in their registrations, so both are already
 * refused unattended. They are listed because that flag is one edit away from `false`, and on the
 * autonomous path there is no human to catch it — belt-and-braces against a registry edit, not a
 * substitute for one.
 */
const NEVER_AUTO_APPROVE = new Set([
  'execute_command',
  'cli_yq',
  'cli_cline',
  'cli_jq',
  'cli_fzf',
]);

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
