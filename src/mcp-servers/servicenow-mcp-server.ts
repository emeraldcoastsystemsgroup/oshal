/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ServiceNow Table API MCP server — exposes incident/change/CI queries via stdio JSON-RPC for incident investigation bots
 */

/**
 * @description Lightweight ServiceNow Table API MCP server.
 * Config via env: SERVICENOW_URL, SERVICENOW_USER, SERVICENOW_PASS (or SERVICENOW_TOKEN).
 *
 * Tools:
 *   sn_get_incidents(filter, limit) — query ServiceNow incidents
 *   sn_get_changes(filter, limit) — query recent change records
 *   sn_get_ci(name_or_id) — look up a CI by name or sys_id
 *   sn_get_record(table, sys_id) — get any record by table + sys_id
 */

import * as readline from 'readline';

const SN_URL = (process.env.SERVICENOW_URL || '').replace(/\/$/, '');
const SN_USER = process.env.SERVICENOW_USER || '';
const SN_PASS = process.env.SERVICENOW_PASS || '';
const SN_TOKEN = process.env.SERVICENOW_TOKEN || '';

function buildAuthHeader(): string {
  if (SN_TOKEN) return `Bearer ${SN_TOKEN}`;
  if (SN_USER && SN_PASS) return `Basic ${Buffer.from(`${SN_USER}:${SN_PASS}`).toString('base64')}`;
  return '';
}

async function snQuery(table: string, params: Record<string, string>): Promise<unknown> {
  if (!SN_URL) return { error: 'SERVICENOW_URL not configured' };

  const url = new URL(`${SN_URL}/api/now/table/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('sysparm_display_value', 'true');

  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': buildAuthHeader(),
      'Accept': 'application/json',
    },
  });

  if (!resp.ok) return { error: `ServiceNow ${resp.status} ${resp.statusText}` };
  const data = await resp.json() as Record<string, unknown>;
  return (data as any)?.result ?? data;
}

async function getIncidents(filter = '', limit = 20): Promise<unknown> {
  const q = filter
    ? `active=true^${filter}`
    : `active=true^ORDERBYDESCsys_updated_on`;
  return snQuery('incident', {
    sysparm_query: q,
    sysparm_limit: String(limit),
    sysparm_fields: 'number,short_description,description,state,priority,assigned_to,cmdb_ci,sys_updated_on,resolved_at,work_notes',
  });
}

async function getChanges(filter = '', limit = 20): Promise<unknown> {
  const q = filter
    ? filter
    : `sys_created_on>javascript:gs.daysAgoStart(7)^ORDERBYDESCsys_created_on`;
  return snQuery('change_request', {
    sysparm_query: q,
    sysparm_limit: String(limit),
    sysparm_fields: 'number,short_description,description,state,type,cmdb_ci,start_date,end_date,sys_created_on,assigned_to',
  });
}

async function getCi(nameOrId: string): Promise<unknown> {
  const isSysId = /^[a-f0-9]{32}$/.test(nameOrId);
  const q = isSysId ? `sys_id=${nameOrId}` : `nameLIKE${nameOrId}^ORname=${nameOrId}`;
  return snQuery('cmdb_ci', {
    sysparm_query: q,
    sysparm_limit: '10',
    sysparm_fields: 'name,sys_id,sys_class_name,ip_address,fqdn,operational_status,install_status,support_group,asset_tag',
  });
}

async function getRecord(table: string, sysId: string): Promise<unknown> {
  if (!SN_URL) return { error: 'SERVICENOW_URL not configured' };
  const resp = await fetch(`${SN_URL}/api/now/table/${table}/${sysId}?sysparm_display_value=true`, {
    headers: { 'Authorization': buildAuthHeader(), 'Accept': 'application/json' },
  });
  if (!resp.ok) return { error: `ServiceNow ${resp.status}` };
  const data = await resp.json() as Record<string, unknown>;
  return (data as any)?.result ?? data;
}

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const TOOLS: Tool[] = [
  {
    name: 'sn_get_incidents',
    description: 'Query ServiceNow incidents. Returns incident records including description, state, priority, and affected CI.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'ServiceNow encoded query filter (e.g. "priority=1^state=2"). Leave empty for all active.' },
        limit: { type: 'number', description: 'Max records to return. Default: 20' },
      },
    },
  },
  {
    name: 'sn_get_changes',
    description: 'Query ServiceNow change requests from the last 7 days. Useful for correlating changes with incidents.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'ServiceNow encoded query (e.g. "cmdb_ci.name=prodserver01"). Leave empty for recent changes.' },
        limit: { type: 'number', description: 'Max records to return. Default: 20' },
      },
    },
  },
  {
    name: 'sn_get_ci',
    description: 'Look up a Configuration Item (CI) by name or sys_id. Returns IP, FQDN, class, operational status.',
    inputSchema: {
      type: 'object',
      properties: {
        name_or_id: { type: 'string', description: 'CI name (partial match) or exact sys_id (32-char hex)' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'sn_get_record',
    description: 'Retrieve any ServiceNow record by table name and sys_id.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'ServiceNow table name (e.g. "incident", "change_request", "cmdb_ci_server")' },
        sys_id: { type: 'string', description: '32-character sys_id of the record' },
      },
      required: ['table', 'sys_id'],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'sn_get_incidents') return getIncidents(args.filter as string, (args.limit as number) || 20);
  if (name === 'sn_get_changes') return getChanges(args.filter as string, (args.limit as number) || 20);
  if (name === 'sn_get_ci') return getCi(args.name_or_id as string);
  if (name === 'sn_get_record') return getRecord(args.table as string, args.sys_id as string);
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
  try { msg = JSON.parse(line); } catch { return; }

  const { id = null, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'servicenow-mcp', version: '1.0.0' },
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
