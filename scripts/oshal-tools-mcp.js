#!/usr/bin/env node
/**
 * OSHAL tools MCP bridge (stdio, dependency-free).
 *
 * Exposes a bot's swarm-registered tools (agent_tools / dynamic registry) to the
 * Claude Code CLI harness, which otherwise only sees Bash + a few static MCP
 * servers and cannot reach framework/app tools like `career_database`.
 *
 * tools/list  -> GET  {OSHAL_API_BASE}/api/tools/for-agent/{OSHAL_AGENT_ID}
 * tools/call  -> POST {OSHAL_API_BASE}/api/tools/execute
 *
 * Both calls authenticate with the shared SWARM_SERVICE_SECRET (x-service-secret)
 * and stamp the acting user via x-oshal-user-sub, so execution runs through the
 * SAME server-side tool-executor (user-scoped, audited) the orchestrator uses.
 *
 * Config (passed via the per-task mcp-config "env" block by the Claude Code adapter):
 *   OSHAL_API_BASE       e.g. http://localhost:5000
 *   SWARM_SERVICE_SECRET shared service secret
 *   OSHAL_AGENT_ID       the bot whose tools to expose
 *   OSHAL_USER_SUB       the signed-in user the tools act for
 *   OSHAL_TASK_ID        (optional) task id for executor workspace/cost scoping
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0.
 */

const API_BASE = (process.env.OSHAL_API_BASE || 'http://localhost:5000').replace(/\/+$/, '');
const SECRET = process.env.SWARM_SERVICE_SECRET || '';
const AGENT_ID = process.env.OSHAL_AGENT_ID || '';
const USER_SUB = process.env.OSHAL_USER_SUB || '';
const TASK_ID = process.env.OSHAL_TASK_ID || `mcp-${AGENT_ID}`;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-service-secret': SECRET,
    'x-oshal-user-sub': USER_SUB,
  };
}

async function listTools() {
  const r = await fetch(`${API_BASE}/api/tools/for-agent/${encodeURIComponent(AGENT_ID)}`, { headers: headers() });
  if (!r.ok) throw new Error(`for-agent ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const tools = Array.isArray(body) ? body : (body.tools || []);
  return tools.map((t) => ({
    name: t.name,
    description: String(t.description || t.name || '').slice(0, 1024),
    inputSchema: (t.inputSchema && typeof t.inputSchema === 'object')
      ? t.inputSchema
      : { type: 'object', properties: {} },
  }));
}

async function callTool(name, args) {
  const r = await fetch(`${API_BASE}/api/tools/execute`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ agentId: AGENT_ID, userSub: USER_SUB, taskId: TASK_ID, toolName: name, input: args || {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`execute ${r.status}: ${text.slice(0, 400)}`);
  let out = text;
  try { const j = JSON.parse(text); out = typeof j.output === 'string' ? j.output : JSON.stringify(j.output ?? j); } catch { /* plain text */ }
  return out;
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) — acknowledge silently.
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      return result(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'oshal-tools', version: '1.0.0' },
      });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: await listTools() });
    if (method === 'tools/call') {
      const out = await callTool(params?.name, params?.arguments);
      return result(id, { content: [{ type: 'text', text: String(out) }] });
    }
    return error(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (method === 'tools/call') {
      // Surface tool failures as tool results (isError) so the model can react.
      return result(id, { content: [{ type: 'text', text: `Tool error: ${e.message}` }], isError: true });
    }
    return error(id, -32603, e.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
