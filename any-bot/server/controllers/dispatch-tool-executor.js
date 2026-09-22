/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the one authorized channel through which a DIRECT-path model turn may reach a registry tool. Extracted rather than added to TaskController, which is already past the 1000-code-line cap, and for the same reason tool-approval-policy.js was: the rule standing between an injected prompt and a tool should be directly testable. Re-checks the request-start handler generations and the caller authorization at the OPERATION boundary (SEC-05), re-authorizes each call through authorizeCapability, honours the existing unattended approval policy unchanged, treats attempt_completion as the side-effect-free control it is declared to be, and fences tool output as untrusted content the same way AgenticController does.
 */

'use strict';

const logger = require('../utils/logger');
const { wrapUntrustedContent } = require('../utils/untrusted-content');
const {
  assertDispatchCapabilitiesCurrent,
  authorizeCapability,
} = require('../utils/dispatch-capabilities');
const { shouldAutoApproveTool } = require('./tool-approval-policy');

/**
 * @description Builds the execution channel a direct-path provider exchange may call, bound to ONE
 * request's captured capabilities.
 *
 * The provider has already refused anything outside the declared set and the exact operation
 * scopes before it gets here; this is the second half of the same SEC-05 pair, and it is the half
 * that holds the registry. It deliberately re-derives the decision instead of trusting the
 * provider's: `authorizeCapability` is the authority, a provider is not.
 *
 * Every refusal is a returned value, never a throw. The model is told why a call did not run and
 * answers the user with that fact; a thrown error would lose the turn, which is the failure this
 * whole path exists to stop.
 * @param {Object} deps - the request's bindings.
 * @param {Object} deps.toolRegistry - the registry the capabilities were captured from.
 * @param {Object} deps.dispatchCapabilities - the snapshot captured at request start.
 * @param {Object} deps.task - the task record, for its workspace binding.
 * @param {string} deps.taskId - the task id passed to tool handlers.
 * @param {Object} deps.options - the processMessage options (owner, agent, approval, authority).
 * @returns {function(string, Object): Promise<Object>} the executeTool channel.
 */
function createDispatchToolExecutor({ toolRegistry, dispatchCapabilities, task, taskId, options }) {
  return async function executeTool(toolName, toolInput) {
    // The OPERATION boundary. A capability revoked or replaced since request start invalidates the
    // whole request, and a caller whose authorization lapsed mid-exchange does not get a tool run.
    assertDispatchCapabilitiesCurrent(toolRegistry, dispatchCapabilities);
    if (typeof options.assertCurrentAuthorization === 'function') {
      await options.assertCurrentAuthorization();
    }
    const capability = authorizeCapability(dispatchCapabilities, toolName);
    if (!capability.allowed) return { ok: false, error: capability.error };
    if (capability.control) return resolveCompletionControl(toolInput);
    return runCapturedTool(capability.snapshot, toolName, toolInput, {
      toolRegistry, task, taskId, options,
    });
  };
}

/**
 * @description Resolves `attempt_completion`, which is a protocol control and not a side effect:
 * its argument IS the final answer, so it ends the exchange rather than producing a tool result.
 * @param {Object} toolInput - the model-supplied arguments.
 * @returns {Object} a final-answer outcome, or a stated refusal when the argument is missing.
 */
function resolveCompletionControl(toolInput) {
  const result = toolInput && typeof toolInput.result === 'string' ? toolInput.result.trim() : '';
  return result
    ? { ok: true, final: true, content: result }
    : { ok: false, error: 'attempt_completion requires a non-empty result string.' };
}

/**
 * @description Runs one authorized tool against its request-start snapshot and fences the output.
 *
 * Approval policy is `shouldAutoApproveTool` unchanged — the direct path gets no approval its
 * unattended sibling would not get, so this widens nothing. Output is wrapped as untrusted content
 * because a tool result is exactly the prompt-injectable input ADR-122 names.
 * @param {Object} snapshot - the captured tool handler generation.
 * @param {string} toolName - the registry name being run.
 * @param {Object} toolInput - the model-supplied arguments.
 * @param {{toolRegistry:Object,task:Object,taskId:string,options:Object}} ctx - request bindings.
 * @returns {Promise<Object>} the outcome fed back to the model.
 */
async function runCapturedTool(snapshot, toolName, toolInput, ctx) {
  const requiresApproval = snapshot.tool.requiresApproval === true;
  const approved = shouldAutoApproveTool(ctx.options.autoApprove, toolName, requiresApproval);
  if (requiresApproval && !approved) {
    return { ok: false, error: `Tool '${toolName}' requires approval before execution.` };
  }
  const workspaceDir = ctx.task && ctx.task.workspace_dir;
  try {
    // The SAME registry the capability was captured from - executeSnapshot revalidates the
    // handler generation against it, so a later registry could not honour this snapshot anyway.
    const output = await ctx.toolRegistry.executeSnapshot(snapshot, {
      ...toolInput,
      taskWorkspace: workspaceDir,
      workspace_dir: workspaceDir,
    }, {
      approved,
      taskWorkspace: workspaceDir,
      userSub: ctx.options.extraEnv && ctx.options.extraEnv.OSHAL_USER_SUB,
      agentId: ctx.options.agentId,
      taskId: ctx.taskId,
      allowedTools: ctx.options.allowedTools,
      authorizedScopes: ctx.options.authorizedScopes,
      // Trusted request context; ToolRegistry re-sanitizes before handlers receive it.
      extraEnv: ctx.options.extraEnv,
    });
    return { ok: true, result: wrapUntrustedContent(`tool-result:${toolName}`, output) };
  } catch (error) {
    logger.error(`Direct-path tool execution failed (${toolName}): ${error.message}`, {
      tool: toolName, taskId: ctx.taskId, stack: error.stack,
    });
    return { ok: false, error: error.message };
  }
}

module.exports = { createDispatchToolExecutor };
