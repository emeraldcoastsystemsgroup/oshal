/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Child-process fixture for the Token Chase end-to-end guard (BACKLOG "Workspace-bound checkpoint and tail replay"): runs the REAL AgenticController loop with capture on, over a scripted provider that is explicitly identified (provider 'scripted-fixture', model 'scripted-v1' — no network, no vendor), the REAL file tools (read_file/list_files exactly as registered; write_to_file with its real handler under this fixture's own approval policy, because the unattended loop never auto-approves an approval-gated tool and would otherwise write nothing) and one REAL live tool (weather_now, replayClass live-read, whose result carries the wall clock). The capture under test is therefore what a bot node writes: frames, per-turn pins, private-git commits and final.json. A child process because the capture flag is read once at module load. Usage: node token-chase-e2e-capture.cjs <workspaceRoot> <runId> <replayable|live> <ownerSub>
 */

'use strict';

const path = require('path');

const [, , workspaceRoot, runId, mode, ownerSub] = process.argv;
if (!workspaceRoot || !runId || !mode || !ownerSub) {
  process.stderr.write('usage: node token-chase-e2e-capture.cjs <workspaceRoot> <runId> <replayable|live> <ownerSub>\n');
  process.exit(2);
}
// The real tool registry accepts a task workspace only under a configured workspace root.
process.env.SHARED_WORKSPACE_ROOT = workspaceRoot;

const ROOT = path.resolve(__dirname, '..', '..');
const AgenticController = require(path.join(ROOT, 'any-bot/server/controllers/AgenticController'));
const ToolRegistry = require(path.join(ROOT, 'any-bot/server/services/ToolRegistry'));
const { fileToolDefinitions } = require(path.join(ROOT, 'any-bot/server/services/tools/fileTools'));
const { tokenChase } = require(path.join(ROOT, 'any-bot/server/services/token-chase/TokenChaseCapture'));

const registry = new ToolRegistry();
for (const definition of fileToolDefinitions()) {
  // Real handlers throughout. The fixture's ONLY policy change: write_to_file is auto-approvable
  // here, since the unattended loop refuses every approval-gated tool and the guard needs an artifact.
  registry.register(definition.name === 'write_to_file' ? { ...definition, requiresApproval: false } : definition);
}
registry.register({
  name: 'weather_now',
  description: 'Current weather (a genuinely live read: the result carries the wall clock)',
  category: 'live',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => ({ tempC: 21, observedAt: new Date().toISOString() }),
  requiresApproval: false,
  replayClass: 'live-read',
  timeout: 5000,
});

const WRITE = '<write_to_file><path>out.txt</path><content>artifact from the scripted turn</content></write_to_file>';
const READ = '<read_file><path>out.txt</path></read_file>';
const LIVE = '<weather_now></weather_now>';
const DONE = '<attempt_completion><result>done</result></attempt_completion>';
const script = mode === 'live' ? [WRITE, LIVE, DONE] : [WRITE, READ, DONE];
let turn = 0;
/** The scripted provider: one fixed response per turn, identified so no reader mistakes it for a vendor. */
const provider = {
  generateResponse: async () => ({
    content: script[turn++] || DONE,
    contentBlocks: [],
    provider: 'scripted-fixture',
    model: 'scripted-v1',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    cost: 0,
  }),
};

const workspaceDir = path.join(workspaceRoot, runId);
const taskController = {
  getTask: async () => ({ id: runId, workspace_dir: workspaceDir, source: 'swarm', messages: [] }),
  addMessage: async () => undefined,
  updateMetrics: async () => undefined,
};
const stream = { broadcast() {} };
const controller = new AgenticController({
  bedrockProvider: provider, clineProvider: null, claudeCodeProvider: null, codexProvider: null, antigravityProvider: null,
  getCurrentProvider: () => 'scripted-fixture',
}, registry, stream, taskController);

(async () => {
  const result = await controller.processAgenticTask(runId, 'Write the artifact and finish.', [], { commandExecution: true }, {
    agentId: 'bot-e2e',
    source: 'swarm',
    allowedTools: ['read_file', 'write_to_file', 'list_files', 'weather_now', 'attempt_completion'],
    authorizedScopes: ['tool:read_file', 'tool:write_to_file', 'tool:list_files', 'tool:weather_now', 'control:attempt_completion'],
    extraEnv: { OSHAL_USER_SUB: ownerSub },
  });
  // The capture writers run on setImmediate; drain them before the process exits.
  await tokenChase.flush();
  await tokenChase.flush();
  process.stdout.write(`\nTC_E2E_RESULT ${JSON.stringify({ success: result.success, turns: turn, provider: 'scripted-fixture', captureEnabled: tokenChase.isEnabled() })}\n`);
  // The real registry races every handler against an uncleared timeout timer (30 s for the file
  // tools); the capture is on disk, so leave rather than wait for it.
  process.exit(0);
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err));
  process.exit(1);
});
