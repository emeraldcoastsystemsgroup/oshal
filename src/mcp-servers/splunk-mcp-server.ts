/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Splunk REST API MCP server — exposes splunk_search and splunk_recent_events tools via stdio JSON-RPC for incident investigation bots
 */

/**
 * @description Lightweight Splunk REST API MCP server.
 * Exposes Splunk search as stdio JSON-RPC tools for Cline bots.
 * Config via env: SPLUNK_URL, SPLUNK_TOKEN (bearer) or SPLUNK_USER + SPLUNK_PASS.
 *
 * Tools:
 *   splunk_search(query, earliest, latest, max_results) — run a Splunk SPL search
 *   splunk_recent_events(index, filter, minutes) — tail recent events from an index
 */

import * as readline from 'readline';

const SPLUNK_URL = (process.env.SPLUNK_URL || '').replace(/\/$/, '');
const SPLUNK_TOKEN = process.env.SPLUNK_TOKEN || '';
const SPLUNK_USER = process.env.SPLUNK_USER || '';
const SPLUNK_PASS = process.env.SPLUNK_PASS || '';

function buildAuthHeader(): string {
  if (SPLUNK_TOKEN) return `Bearer ${SPLUNK_TOKEN}`;
  if (SPLUNK_USER && SPLUNK_PASS) {
    return `Basic ${Buffer.from(`${SPLUNK_USER}:${SPLUNK_PASS}`).toString('base64')}`;
  }
  return '';
}

async function splunkSearch(query: string, earliest = '-60m', latest = 'now', maxResults = 50): Promise<unknown> {
  if (!SPLUNK_URL) return { error: 'SPLUNK_URL not configured' };

  const auth = buildAuthHeader();
  const createUrl = `${SPLUNK_URL}/services/search/jobs`;

  // Create search job
  const createResp = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      search: query.startsWith('search ') ? query : `search ${query}`,
      earliest_time: earliest,
      latest_time: latest,
      output_mode: 'json',
      exec_mode: 'oneshot',
      count: String(maxResults),
    }).toString(),
  });

  if (!createResp.ok) {
    return { error: `Splunk search failed: ${createResp.status} ${createResp.statusText}` };
  }

  const result = await createResp.json() as Record<string, unknown>;
  const hits = (result as any)?.results ?? [];
  return { query, earliest, latest, count: hits.length, results: hits };
}

async function splunkRecentEvents(index: string, filter = '', minutes = 30): Promise<unknown> {
  const earliest = `-${minutes}m`;
  const q = filter
    ? `index="${index}" ${filter}`
    : `index="${index}"`;
  return splunkSearch(q, earliest, 'now', 100);
}

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const TOOLS: Tool[] = [
  {
    name: 'splunk_search',
    description: 'Run a Splunk SPL search query. Returns matching events.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SPL search query (e.g. "index=main error | head 20")' },
        earliest: { type: 'string', description: 'Earliest time modifier (e.g. "-60m", "-1h", "-1d"). Default: -60m' },
        latest: { type: 'string', description: 'Latest time modifier. Default: now' },
        max_results: { type: 'number', description: 'Maximum results to return. Default: 50' },
      },
      required: ['query'],
    },
  },
  {
    name: 'splunk_recent_events',
    description: 'Tail recent events from a Splunk index with an optional keyword filter.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Splunk index name' },
        filter: { type: 'string', description: 'Optional SPL filter terms (e.g. "error OR warning")' },
        minutes: { type: 'number', description: 'How many minutes back to search. Default: 30' },
      },
      required: ['index'],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'splunk_search') {
    return splunkSearch(
      args.query as string,
      (args.earliest as string) || '-60m',
      (args.latest as string) || 'now',
      (args.max_results as number) || 50,
    );
  }
  if (name === 'splunk_recent_events') {
    return splunkRecentEvents(
      args.index as string,
      (args.filter as string) || '',
      (args.minutes as number) || 30,
    );
  }
  return { error: `Unknown tool: ${name}` };
}

// ── stdio JSON-RPC MCP loop ──────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id: number | null, result?: unknown, error?: { code: number; message: string }): void {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  let msg: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id = null, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'splunk-mcp', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  } else if (method === 'tools/list') {
    respond(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const toolName = (params?.name as string) || '';
    const toolArgs = (params?.arguments as Record<string, unknown>) || {};
    try {
      const result = await handleToolCall(toolName, toolArgs);
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      respond(id, undefined, { code: -32603, message });
    }
  } else if (method === 'notifications/initialized') {
    // no-op
  } else {
    respond(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
});
