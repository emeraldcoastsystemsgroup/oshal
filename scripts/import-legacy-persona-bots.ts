/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy persona import script with dry-run/apply modes to upsert agents and tool auth assignments from ai-lab/bot-personas YAML files
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored importer for maintainability under file-size constraints while preserving dry-run/apply behavior and authorization mapping
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Moved authorization aliases into dedicated module and wired importer to shared alias map to stay under file-size governance threshold
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import yaml from 'js-yaml';
import { config as loadDotenv } from 'dotenv';
import { createChildLogger } from '../src/shared/logger';
import { AuthMode } from '../src/shared/types/tool';
import { createOptionalPostgresPool } from '../src/shared/services/database';
import { AUTHORIZATION_TOOL_ALIASES } from './import-legacy-persona-bots-auth-aliases';

const logger = createChildLogger({ module: 'scripts/import-legacy-persona-bots' });

const DEFAULT_PERSONA_DIR = 'ai-lab/bot-personas';
const DEFAULT_PROVIDER_ID = 'anthropic';
const DEFAULT_MODEL_ID = 'claude-sonnet-4-20250514';

const HELP_TEXT = [
  'Usage: npm run import:legacy-bots -- [options]',
  '',
  'Modes:',
  '  (default)                 Dry-run only (no mutations)',
  '  --apply                   Persist agent/tool updates',
  '',
  'Options:',
  `  --persona-dir=<path>       Persona directory (default: ${DEFAULT_PERSONA_DIR})`,
  '  --include=<csv>           Only import listed bot names (name or file stem)',
  '  --exclude=<csv>           Skip listed bot names (name or file stem)',
  '  --help                    Show this help text',
].join('\n');

type ImportMode = 'dry-run' | 'apply';

interface ImportOptions {
  mode: ImportMode;
  showHelp: boolean;
  personaDir: string;
  include: Set<string>;
  exclude: Set<string>;
}

interface PersonaRecord {
  filePath: string;
  fileName: string;
  fileStem: string;
  name: string;
  role: string;
  legacyAgentId: string;
  systemPrompt: string;
  perspective: string;
  description: string;
  capabilities: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
  authorizations: Record<string, string>;
  personality: Record<string, string>;
  sourceKeys: string[];
  rawDocument: Record<string, unknown>;
  scope: string;
  configGuide?: {
    title?: string;
    summary?: string;
    docPath: string;
  };
}

interface ToolRow {
  toolId: string;
  name: string;
}

interface AgentRow {
  agentId: string;
  name: string;
  metadata: Record<string, unknown>;
}

interface ToolAssignmentPlan {
  toolId: string;
  toolName: string;
  sourceKey: string;
  rawValue: string;
  authMode: AuthMode;
}

interface AgentImportPlan {
  persona: PersonaRecord;
  action: 'create' | 'update';
  existingAgent?: AgentRow;
  assignments: ToolAssignmentPlan[];
  unresolvedAuthorizationKeys: string[];
}

interface ImportContext {
  personas: PersonaRecord[];
  toolLookup: Map<string, ToolRow[]>;
  existingAgentsByName: Map<string, AgentRow>;
  duplicateAgentNames: string[];
}

interface ImportApplyResult {
  createdAgents: number;
  updatedAgents: number;
  upsertedToolAssignments: number;
  unresolvedAuthorizationCount: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  loadEnvironmentDefaults();
  const options = parseArgs(process.argv.slice(2));

  if (options.showHelp) {
    logger.info({ usage: HELP_TEXT }, 'Legacy persona import help');
    return;
  }

  const pool = createOptionalPostgresPool('scripts/import-legacy-persona-bots');
  if (!pool) {
    logger.error(
      { requiredEnv: ['DATABASE_URL', 'PGHOST/POSTGRES_HOST'] },
      'Postgres configuration missing. Legacy persona import cannot run.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const context = await loadContext(pool, options);
    const plans = buildImportPlans(context.personas, context.existingAgentsByName, context.toolLookup);
    logImportPlan(plans, context.duplicateAgentNames, options);

    if (options.mode === 'apply') {
      const result = await applyImportPlan(pool, plans);
      logger.info({ durationMs: Date.now() - startedAt, result }, 'Legacy persona import applied successfully');
      return;
    }

    logger.info(
      { durationMs: Date.now() - startedAt },
      'Legacy persona import dry-run complete; re-run with --apply to persist changes',
    );
  } catch (error) {
    logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Legacy persona import failed');
    process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

function parseArgs(args: string[]): ImportOptions {
  const options = buildDefaultOptions();

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.mode = 'apply';
      continue;
    }
    if (!arg.startsWith('--') || !arg.includes('=')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [key, ...valueParts] = arg.slice(2).split('=');
    const value = valueParts.join('=').trim();
    applyFlagValue(options, key, value);
  }

  return options;
}

function buildDefaultOptions(): ImportOptions {
  return {
    mode: 'dry-run',
    showHelp: false,
    personaDir: DEFAULT_PERSONA_DIR,
    include: new Set<string>(),
    exclude: new Set<string>(),
  };
}

function applyFlagValue(options: ImportOptions, key: string, value: string): void {
  switch (key) {
    case 'persona-dir':
      options.personaDir = value;
      return;
    case 'include':
      options.include = parseCsvToSet(value);
      return;
    case 'exclude':
      options.exclude = parseCsvToSet(value);
      return;
    default:
      throw new Error(`Unknown argument: --${key}`);
  }
}

function parseCsvToSet(value: string): Set<string> {
  const parsed = value.split(',').map((entry) => normalizeNameToken(entry)).filter(Boolean);
  return new Set(parsed);
}

async function loadContext(pool: Pool, options: ImportOptions): Promise<ImportContext> {
  const [personas, tools, existingAgents] = await Promise.all([
    loadPersonaRecords(options),
    loadEnabledTools(pool),
    loadExistingAgents(pool),
  ]);

  const toolLookup = buildToolLookup(tools);
  const { agentsByName, duplicateNames } = buildAgentLookup(existingAgents);
  return {
    personas,
    toolLookup,
    existingAgentsByName: agentsByName,
    duplicateAgentNames: duplicateNames,
  };
}

function loadPersonaRecords(options: ImportOptions): PersonaRecord[] {
  const personaDir = path.resolve(process.cwd(), options.personaDir);
  if (!fs.existsSync(personaDir)) {
    throw new Error(`Persona directory not found: ${personaDir}`);
  }

  const files = fs
    .readdirSync(personaDir)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort((left, right) => left.localeCompare(right));

  const records = files
    .map((file) => {
      try {
        return readPersonaRecord(path.join(personaDir, file));
      } catch (err) {
        logger.warn({ file, error: (err as Error).message }, 'Skipping persona file due to parse error');
        return null;
      }
    })
    .filter((record): record is PersonaRecord => record !== null && selectPersonaRecord(record, options));

  if (records.length === 0) {
    throw new Error('No persona files selected for import. Adjust --include/--exclude filters.');
  }

  logger.info({ personaDir, totalFiles: files.length, selectedFiles: records.length }, 'Loaded persona files for import planning');
  return records;
}

function readPersonaRecord(filePath: string): PersonaRecord {
  const fileName = path.basename(filePath);
  const fileStem = path.basename(filePath, path.extname(filePath));
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const perspective = readFirstString(doc, ['perspective']);
  const systemPrompt = readFirstString(doc, ['system_prompt', 'systemPrompt']);
  const description = readFirstString(doc, ['description']);
  const configGuide = readConfigGuide(doc.config_guide ?? doc.configGuide);

  return {
    filePath,
    fileName,
    fileStem,
    name: readFirstString(doc, ['name']) || fileStem,
    role: readFirstString(doc, ['role']) || 'specialist',
    legacyAgentId: readFirstString(doc, ['agent_id', 'agentId']),
    systemPrompt: buildLegacySystemPrompt({ perspective, systemPrompt, description }),
    perspective,
    description,
    capabilities: toStringArray(doc.capabilities),
    selectorDescriptor: readFirstString(doc, ['selector_descriptor', 'selectorDescriptor', 'description']),
    routingKeywords: toStringArray(doc.routing_keywords ?? doc.routingKeywords),
    authorizations: toStringMap(doc.authorizations),
    personality: toStringMap(doc.personality),
    sourceKeys: Object.keys(doc).sort((left, right) => left.localeCompare(right)),
    rawDocument: doc,
    scope: readFirstString(doc, ['scope']) || 'shared',
    ...(configGuide ? { configGuide } : {}),
  };
}

function buildLegacySystemPrompt(parts: {
  perspective: string;
  systemPrompt: string;
  description: string;
}): string {
  const sections = [
    parts.perspective ? `## Perspective\n${parts.perspective}` : '',
    parts.systemPrompt ? `## Operating Instructions\n${parts.systemPrompt}` : '',
    parts.description ? `## Description\n${parts.description}` : '',
  ].filter((section) => section.trim().length > 0);

  if (sections.length === 0) {
    return '';
  }

  return sections.join('\n\n').trim();
}

function selectPersonaRecord(record: PersonaRecord, options: ImportOptions): boolean {
  const normalizedName = normalizeNameToken(record.name);
  const normalizedStem = normalizeNameToken(record.fileStem);

  const includeMatch = options.include.size === 0 || options.include.has(normalizedName) || options.include.has(normalizedStem);
  if (!includeMatch) {
    return false;
  }

  return !options.exclude.has(normalizedName) && !options.exclude.has(normalizedStem);
}

async function loadEnabledTools(pool: Pool): Promise<ToolRow[]> {
  const result = await pool.query<{ tool_id: string; name: string }>(
    `
      SELECT tool_id, name
      FROM tools
      WHERE enabled = TRUE
      ORDER BY name ASC
    `,
  );

  const rows = result.rows.map((row) => ({
    toolId: row.tool_id,
    name: row.name,
  }));

  logger.info({ count: rows.length }, 'Loaded enabled tools for authorization mapping');
  return rows;
}

async function loadExistingAgents(pool: Pool): Promise<AgentRow[]> {
  const result = await pool.query<{
    agent_id: string;
    name: string;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT agent_id, name, metadata
      FROM agents
      ORDER BY updated_at DESC
    `,
  );

  return result.rows.map(mapAgentRow);
}

function mapAgentRow(row: {
  agent_id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}): AgentRow {
  return { agentId: row.agent_id, name: row.name, metadata: normalizeMetadata(row.metadata) };
}

function buildToolLookup(rows: ToolRow[]): Map<string, ToolRow[]> {
  const lookup = new Map<string, ToolRow[]>();

  for (const row of rows) {
    const key = normalizeToolName(row.name);
    const bucket = lookup.get(key) ?? [];
    bucket.push(row);
    lookup.set(key, bucket);
  }

  return lookup;
}

function buildAgentLookup(rows: AgentRow[]): { agentsByName: Map<string, AgentRow>; duplicateNames: string[] } {
  const agentsByName = new Map<string, AgentRow>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const key = normalizeNameToken(row.name);
    if (agentsByName.has(key)) {
      duplicates.add(row.name);
      continue;
    }
    agentsByName.set(key, row);
  }

  return {
    agentsByName,
    duplicateNames: Array.from(duplicates).sort((left, right) => left.localeCompare(right)),
  };
}

function buildImportPlans(
  personas: PersonaRecord[],
  existingAgentsByName: Map<string, AgentRow>,
  toolLookup: Map<string, ToolRow[]>,
): AgentImportPlan[] {
  return personas.map((persona) => {
    const key = normalizeNameToken(persona.name);
    const existingAgent = existingAgentsByName.get(key);
    const { assignments, unresolvedAuthorizationKeys } = buildToolAssignmentPlan(persona.authorizations, toolLookup);
    return {
      persona,
      action: existingAgent ? 'update' : 'create',
      existingAgent,
      assignments,
      unresolvedAuthorizationKeys,
    };
  });
}

function buildToolAssignmentPlan(
  authorizations: Record<string, string>,
  toolLookup: Map<string, ToolRow[]>,
): { assignments: ToolAssignmentPlan[]; unresolvedAuthorizationKeys: string[] } {
  const assignmentsByToolId = new Map<string, ToolAssignmentPlan>();
  const unresolved = new Set<string>();

  for (const [rawKey, rawValue] of Object.entries(authorizations)) {
    const normalizedKey = normalizeAuthorizationKey(rawKey);
    const authMode = normalizeAuthMode(rawValue);
    const tools = resolveToolsForAuthorizationKey(normalizedKey, toolLookup);

    if (tools.length === 0) {
      unresolved.add(rawKey);
      continue;
    }

    for (const tool of tools) {
      assignmentsByToolId.set(tool.toolId, {
        toolId: tool.toolId,
        toolName: tool.name,
        sourceKey: rawKey,
        rawValue: String(rawValue ?? '').trim(),
        authMode,
      });
    }
  }

  return {
    assignments: Array.from(assignmentsByToolId.values()).sort((left, right) => left.toolName.localeCompare(right.toolName)),
    unresolvedAuthorizationKeys: Array.from(unresolved).sort((left, right) => left.localeCompare(right)),
  };
}

function resolveToolsForAuthorizationKey(key: string, toolLookup: Map<string, ToolRow[]>): ToolRow[] {
  const candidateNames = buildCandidateNames(key);
  const resolved: ToolRow[] = [];
  const seenToolIds = new Set<string>();

  for (const candidate of candidateNames) {
    for (const tool of toolLookup.get(candidate) ?? []) {
      if (seenToolIds.has(tool.toolId)) {
        continue;
      }
      seenToolIds.add(tool.toolId);
      resolved.push(tool);
    }
  }

  return resolved;
}

function buildCandidateNames(key: string): Set<string> {
  const names = new Set<string>((AUTHORIZATION_TOOL_ALIASES[key] ?? []).map(normalizeToolName));
  names.add(normalizeToolName(key));
  return names;
}

function logImportPlan(plans: AgentImportPlan[], duplicateAgentNames: string[], options: ImportOptions): void {
  const summary = summarizePlans(plans);
  logger.info(
    {
      mode: options.mode,
      personaDir: options.personaDir,
      include: Array.from(options.include),
      exclude: Array.from(options.exclude),
      summary,
      sample: {
        create: plans.filter((plan) => plan.action === 'create').slice(0, 10).map((plan) => plan.persona.name),
        update: plans.filter((plan) => plan.action === 'update').slice(0, 10).map((plan) => plan.persona.name),
      },
      duplicateAgentNames,
    },
    'Legacy persona import plan built',
  );

  const unresolved = collectUnresolvedAuthorizations(plans);

  if (unresolved.length > 0) {
    logger.warn({ count: unresolved.length, sample: unresolved.slice(0, 20) }, 'Some authorization keys could not be mapped to enabled tools');
  }
}

function collectUnresolvedAuthorizations(plans: AgentImportPlan[]): Array<{ name: string; keys: string[] }> {
  return plans
    .filter((plan) => plan.unresolvedAuthorizationKeys.length > 0)
    .map((plan) => ({ name: plan.persona.name, keys: plan.unresolvedAuthorizationKeys }));
}

async function applyImportPlan(pool: Pool, plans: AgentImportPlan[]): Promise<ImportApplyResult> {
  const client = await pool.connect();
  const importedAt = new Date().toISOString();

  try {
    await client.query('BEGIN');
    const result: ImportApplyResult = {
      createdAgents: 0,
      updatedAgents: 0,
      upsertedToolAssignments: 0,
      unresolvedAuthorizationCount: 0,
    };

    for (const plan of plans) {
      const agentId = await upsertAgentRecord(client, plan, importedAt);
      const assignmentCount = await upsertAgentToolAssignments(client, agentId, plan.assignments);
      result.upsertedToolAssignments += assignmentCount;
      result.unresolvedAuthorizationCount += plan.unresolvedAuthorizationKeys.length;
      incrementActionCounters(result, plan.action);
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await rollbackTransaction(client);
    throw error;
  } finally {
    client.release();
  }
}

function incrementActionCounters(result: ImportApplyResult, action: 'create' | 'update'): void {
  if (action === 'create') result.createdAgents += 1;
  if (action === 'update') result.updatedAgents += 1;
}

async function upsertAgentRecord(client: PoolClient, plan: AgentImportPlan, importedAt: string): Promise<string> {
  if (plan.action === 'create') {
    return insertAgentRecord(client, plan, importedAt);
  }
  if (!plan.existingAgent) {
    throw new Error(`Missing existing agent for update plan: ${plan.persona.name}`);
  }
  return updateAgentRecord(client, plan, importedAt);
}

async function insertAgentRecord(client: PoolClient, plan: AgentImportPlan, importedAt: string): Promise<string> {
  const payload = buildPersistPayload(plan, importedAt, {});

  const result = await client.query<{ agent_id: string }>(
    `
      INSERT INTO agents (
        name,
        status,
        api_provider_id,
        model_id,
        persona,
        tools,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords
      ) VALUES ($1, 'active', $2, $3, $4::jsonb, $5::uuid[], $6::jsonb, $7::text[], $8, $9::text[])
      RETURNING agent_id
    `,
    [
      plan.persona.name,
      DEFAULT_PROVIDER_ID,
      DEFAULT_MODEL_ID,
      payload.persona,
      payload.enabledToolIds,
      payload.metadata,
      payload.capabilities,
      payload.selectorDescriptor,
      payload.routingKeywords,
    ],
  );

  const agentId = result.rows[0]?.agent_id;
  if (!agentId) throw new Error(`Failed to create agent row for persona: ${plan.persona.name}`);
  return agentId;
}

async function updateAgentRecord(client: PoolClient, plan: AgentImportPlan, importedAt: string): Promise<string> {
  if (!plan.existingAgent) {
    throw new Error(`Missing existing agent row while updating persona: ${plan.persona.name}`);
  }

  const payload = buildPersistPayload(plan, importedAt, plan.existingAgent.metadata);

  const result = await client.query<{ agent_id: string }>(
    `
      UPDATE agents
      SET
        name = $2,
        status = 'active',
        persona = $3::jsonb,
        tools = $4::uuid[],
        metadata = $5::jsonb,
        base_capabilities = $6::text[],
        base_selector_descriptor = $7,
        base_routing_keywords = $8::text[],
        updated_at = NOW()
      WHERE agent_id = $1
      RETURNING agent_id
    `,
    [
      plan.existingAgent.agentId,
      plan.persona.name,
      payload.persona,
      payload.enabledToolIds,
      payload.metadata,
      payload.capabilities,
      payload.selectorDescriptor,
      payload.routingKeywords,
    ],
  );

  const agentId = result.rows[0]?.agent_id;
  if (!agentId) throw new Error(`Failed to update agent row for persona: ${plan.persona.name}`);
  return agentId;
}

function buildPersistPayload(
  plan: AgentImportPlan,
  importedAt: string,
  existingMetadata: Record<string, unknown>,
): {
  persona: string;
  metadata: string;
  enabledToolIds: string[];
  capabilities: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
} {
  return {
    persona: JSON.stringify(buildPersonaPayload(plan.persona, importedAt)),
    metadata: JSON.stringify(buildAgentMetadata(existingMetadata, plan.persona, importedAt)),
    enabledToolIds: uniqueStrings(plan.assignments.filter((assignment) => assignment.authMode !== AuthMode.OFF).map((assignment) => assignment.toolId)),
    capabilities: uniqueStrings(plan.persona.capabilities),
    selectorDescriptor: plan.persona.selectorDescriptor,
    routingKeywords: uniqueStrings(plan.persona.routingKeywords),
  };
}

async function upsertAgentToolAssignments(
  client: PoolClient,
  agentId: string,
  assignments: ToolAssignmentPlan[],
): Promise<number> {
  let changed = 0;
  for (const assignment of assignments) {
    await client.query(
      `
        INSERT INTO agent_tools (agent_id, tool_id, auth_mode, installed, install_verified, tool_config)
        VALUES ($1, $2, $3, false, false, '{}'::jsonb)
        ON CONFLICT (agent_id, tool_id)
        DO UPDATE SET
          auth_mode = EXCLUDED.auth_mode,
          updated_at = NOW()
      `,
      [agentId, assignment.toolId, assignment.authMode],
    );
    changed += 1;
  }
  return changed;
}

function summarizePlans(plans: AgentImportPlan[]): Record<string, number> {
  const createCount = plans.filter(({ action }) => action === 'create').length;
  const totalAssignments = plans.reduce((sum, plan) => sum + plan.assignments.length, 0);
  const autoAssignments = countAssignmentsByMode(plans, AuthMode.AUTO);
  const askAssignments = countAssignmentsByMode(plans, AuthMode.ASK);
  const offAssignments = countAssignmentsByMode(plans, AuthMode.OFF);
  const unresolvedAgents = plans.filter((plan) => plan.unresolvedAuthorizationKeys.length > 0).length;

  return {
    totalPersonas: plans.length,
    createCount,
    updateCount: plans.length - createCount,
    totalAssignments,
    autoAssignments,
    askAssignments,
    offAssignments,
    unresolvedAgents,
  };
}

function countAssignmentsByMode(plans: AgentImportPlan[], mode: AuthMode): number {
  return plans.reduce(
    (sum, plan) => sum + plan.assignments.filter((assignment) => assignment.authMode === mode).length,
    0,
  );
}

function buildPersonaPayload(persona: PersonaRecord, importedAt: string): Record<string, unknown> {
  return {
    systemPrompt: persona.systemPrompt,
    role: persona.role,
    constraints: [],
    importedFromPersonaFile: persona.fileName,
    perspective: persona.perspective,
    description: persona.description,
    personality: persona.personality,
    authorizations: persona.authorizations,
    legacyPersonaDocument: persona.rawDocument,
    importedAt,
  };
}

function buildAgentMetadata(
  existingMetadata: Record<string, unknown>,
  persona: PersonaRecord,
  importedAt: string,
): Record<string, unknown> {
  return {
    ...existingMetadata,
    personaSourceFile: persona.fileName,
    legacyAgentId: persona.legacyAgentId,
    scope: persona.scope,
    importedBy: 'legacy-persona-import-script',
    ...(persona.configGuide ? { configGuide: persona.configGuide } : {}),
    legacyPersona: {
      fileName: persona.fileName,
      filePath: persona.filePath,
      legacyAgentId: persona.legacyAgentId,
      role: persona.role,
      capabilities: persona.capabilities,
      routingKeywords: persona.routingKeywords,
      selectorDescriptor: persona.selectorDescriptor,
      personality: persona.personality,
      perspective: persona.perspective,
      description: persona.description,
      configGuide: persona.configGuide,
      systemPromptLength: persona.systemPrompt.length,
      sourceKeys: persona.sourceKeys,
      rawDocument: persona.rawDocument,
      importedAt,
      authorizationKeys: Object.keys(persona.authorizations),
    },
  };
}

function normalizeAuthorizationKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function normalizeNameToken(value: string): string {
  return normalizeToolName(value);
}

function normalizeAuthMode(value: string): AuthMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === AuthMode.AUTO) return AuthMode.AUTO;
  if (normalized === AuthMode.ASK) return AuthMode.ASK;
  if (normalized === AuthMode.OFF) return AuthMode.OFF;
  if (['on', 'true', 'enabled', 'yes'].includes(normalized)) return AuthMode.AUTO;
  if (['false', 'disabled', 'none', 'no'].includes(normalized)) return AuthMode.OFF;
  return AuthMode.OFF;
}

function readFirstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [key, mapValue] of Object.entries(value as Record<string, unknown>)) {
    map[key] = String(mapValue ?? '').trim();
  }
  return map;
}

function readConfigGuide(
  value: unknown,
): PersonaRecord['configGuide'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const docPath = String(record.doc_path ?? record.docPath ?? record.path ?? '').trim();
  if (!docPath) {
    return undefined;
  }

  const title = String(record.title ?? '').trim();
  const summary = String(record.summary ?? '').trim();

  return {
    docPath,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

async function rollbackTransaction(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    logger.error({ err: error }, 'Failed to rollback legacy persona import transaction');
  }
}

async function closePool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, 'Failed to close Postgres pool after legacy persona import');
  }
}

function loadEnvironmentDefaults(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    logger.debug({ envPath }, 'No .env file found for legacy persona import defaults');
    return;
  }

  const result = loadDotenv({ path: envPath, override: false });
  if (result.error) {
    logger.warn({ err: result.error, envPath }, 'Failed to load .env defaults for legacy persona import');
    return;
  }

  logger.info({ envPath }, 'Loaded .env defaults for legacy persona import');
}

if (require.main === module) {
  void main();
}
