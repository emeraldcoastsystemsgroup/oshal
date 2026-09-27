/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Stand-in agy executable for the host-tool-loop seam guard (tests/unit/antigravity-host-tool-loop.spec.ts). It runs as a REAL child process under the wrapper's real argv, cwd and env, records what agy itself would see (argv, the private HOME's settings.json, custom agent and MCP config, and whether the task workspace grew a .agents folder) to FAKE_AGY_OBSERVE_FILE, then answers the stream-json turn the way the live model answered the same prompt in the 2026-09-27 repro: conversation_query first, conversation_fetch with the returned taskId next, then attempt_completion carrying the codeword it was handed. FAKE_AGY_MODE=deny replays the live failure shape instead: a native view_file refused by the permission check and an empty SUCCESS result. It never contacts a model.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Read a file under the private HOME, or null when absent. */
function readHomeFile(...parts) {
  const file = path.join(process.env.HOME || '', ...parts);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Record exactly what this invocation of agy was handed. */
function observe(prompt) {
  const out = process.env.FAKE_AGY_OBSERVE_FILE;
  if (!out) return;
  const agentName = process.argv.includes('--agent') ? process.argv[process.argv.indexOf('--agent') + 1] : null;
  fs.appendFileSync(out, `${JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    home: process.env.HOME,
    settings: readHomeFile('.gemini', 'antigravity-cli', 'settings.json'),
    agentMd: agentName ? readHomeFile('.gemini', 'config', 'agents', agentName, 'agent.md') : null,
    mcpConfig: readHomeFile('.gemini', 'config', 'mcp_config.json'),
    workspaceAgentsDir: fs.existsSync(path.join(process.cwd(), '.agents')),
    prompt,
  })}\n`);
}

/** The next host-loop reply for the prompt the host sent, as the live model produced it. */
function hostLoopReply(prompt) {
  if (!prompt.includes('tool-result:conversation_query')) {
    return '<conversation_query>\n<query>Recall drill fixture codeword</query>\n</conversation_query>';
  }
  if (!prompt.includes('tool-result:conversation_fetch')) {
    // The host fences a tool result as JSON inside JSON, so the id's quotes arrive escaped.
    const taskId = (prompt.match(/\\?"taskId\\?":\s*\\?"([^"\\]+)\\?"/) || [])[1] || 'missing';
    return `<conversation_fetch>\n<taskId>${taskId}</taskId>\n<source>conversation</source>\n</conversation_fetch>`;
  }
  const codeword = (prompt.match(/TESTLAB-RECALL-[0-9A-F]+/) || [])[0] || 'NONE';
  return `<attempt_completion>\n<result>The codeword is ${codeword}.</result>\n</attempt_completion>`;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const first = JSON.parse(input.split('\n')[0]);
  const prompt = String(first.message && first.message.content || '');
  observe(prompt);
  emit({ event: 'init', init: { model: 'fake-agy', cwd: process.cwd() } });
  if (process.env.FAKE_AGY_MODE === 'deny') {
    const target = '/app/server/app.js';
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'view_file',
      tool_info: { name: 'view_file', parameters: { AbsolutePath: target }, error: { type: 'TOOL_ERROR',
        message: `permission check failed for read_file "${target}": user denied permission for read_file(${target})\nDo not attempt to circumvent this denial.` } } } });
    emit({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] } });
    process.stderr.write('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    return;
  }
  const response = hostLoopReply(prompt);
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: response } });
  emit({ event: 'result', result: { status: 'SUCCESS', response, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
});
