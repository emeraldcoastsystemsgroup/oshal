/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WS1: Created runtime trace analyzer — parses Cline runtime task folders to reconstruct per-ticket phase/round execution history and detect persona misbinding and missing review output
 */

import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'runtime-trace-analyzer-service' });

/**
 * @description Parsed representation of one Cline runtime task folder.
 */
export interface RuntimeTaskTrace {
  runtimeTaskId: string;
  taskFolderPath: string;
  agentId: string | null;
  originalTicketId: string | null;
  externalId: string | null;
  phase: number | null;
  round: number | null;
  role: string | null;
  filesInContext: string[];
  toolCalls: string[];
  completionType: 'completed' | 'blocked' | 'failed' | 'unknown';
  completionText: string | null;
  createdAt: string | null;
}

/**
 * @description Anomaly found during trace analysis.
 */
export interface TraceAnomaly {
  runtimeTaskId: string;
  type: 'wrong-persona' | 'missing-completion' | 'planning-sop-in-review' | 'no-verdict';
  detail: string;
}

/**
 * @description Full trace report for one ticket.
 */
export interface TicketTraceReport {
  originalTicketId: string;
  workspaceTaskId: string;
  traceCount: number;
  traces: RuntimeTaskTrace[];
  anomalies: TraceAnomaly[];
  regressionHandoffs: RegressionHandoffRecord[];
}

/**
 * @description One regression handoff record from .oshal/regression-trace.jsonl.
 */
export interface RegressionHandoffRecord {
  ticketId: string;
  sourcePhase: number;
  sourceExternalId: string;
  feedback: string | null;
  findings: string[];
  regressionCount: number;
  createdAt: string;
}

/**
 * @description Analyzes Cline runtime task folders for a given workspace and ticket.
 * Reads task_metadata.json, ui_messages.json, and regression-trace.jsonl from the
 * .oshal/cline-runtime folder to reconstruct what each bot did per phase/round.
 */
export class RuntimeTraceAnalyzerService {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot ?? resolveWorkspaceRoot();
  }

  /**
   * @description Builds a full trace report for one ticket across all runtime task folders.
   * @param originalTicketId - The ticket external ID to filter traces by
   * @param workspaceTaskId - The workspace task folder UUID under workspace-shared/
   * @returns Structured trace report with anomaly detection
   */
  buildTicketTraceReport(originalTicketId: string, workspaceTaskId: string): TicketTraceReport {
    const tasksDir = path.join(this.workspaceRoot, workspaceTaskId, '.oshal', 'cline-runtime', 'data', 'tasks');
    const regressionHandoffs = this.readRegressionHandoffs(workspaceTaskId, originalTicketId);

    if (!fs.existsSync(tasksDir)) {
      logger.info({ originalTicketId, workspaceTaskId, tasksDir }, 'No cline-runtime tasks folder found — returning empty trace');
      return { originalTicketId, workspaceTaskId, traceCount: 0, traces: [], anomalies: [], regressionHandoffs };
    }

    const taskFolders = this.listTaskFolders(tasksDir);
    const allTraces = taskFolders.map((folder) => this.parseTaskFolder(folder));
    const related = allTraces.filter((t) => isRelatedTrace(t, originalTicketId));
    const sorted = related.sort(compareByCreatedAt);
    const anomalies = this.detectAnomalies(sorted);

    logger.info({ originalTicketId, workspaceTaskId, total: allTraces.length, related: related.length, anomalyCount: anomalies.length }, 'Built ticket trace report');
    return { originalTicketId, workspaceTaskId, traceCount: related.length, traces: sorted, anomalies, regressionHandoffs };
  }

  /**
   * @description Parses one Cline runtime task folder into a structured trace.
   * @param taskFolderPath - Absolute path to the task folder
   * @returns Parsed trace
   */
  parseTaskFolder(taskFolderPath: string): RuntimeTaskTrace {
    const runtimeTaskId = path.basename(taskFolderPath);
    const meta = readJsonSafe<Record<string, unknown>>(path.join(taskFolderPath, 'task_metadata.json'));
    const uiMessages = readJsonSafe<Array<Record<string, unknown>>>(path.join(taskFolderPath, 'ui_messages.json'));

    const filesInContext = extractFilesInContext(meta);
    const agentId = extractAgentIdFromContextFiles(filesInContext);
    const taskPrompt = extractTaskPrompt(uiMessages);
    const externalId = extractExternalId(taskPrompt);
    const { phase, round } = extractPhaseRound(externalId, taskPrompt);
    const role = extractRole(taskPrompt);
    const toolCalls = extractToolCalls(uiMessages);
    const { completionType, completionText } = extractCompletion(uiMessages);
    const createdAt = extractCreatedAt(uiMessages);

    return {
      runtimeTaskId, taskFolderPath, agentId,
      originalTicketId: extractOriginalTicketId(externalId),
      externalId, phase, round, role,
      filesInContext, toolCalls, completionType, completionText, createdAt,
    };
  }

  private listTaskFolders(tasksDir: string): string[] {
    try {
      return fs.readdirSync(tasksDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(tasksDir, d.name));
    } catch (err) {
      logger.warn({ err, tasksDir }, 'Failed to list task folders');
      return [];
    }
  }

  private detectAnomalies(traces: RuntimeTaskTrace[]): TraceAnomaly[] {
    const anomalies: TraceAnomaly[] = [];
    for (const t of traces) {
      if (t.phase === 6 && t.filesInContext.some((f) => /project-manager-context|planning/i.test(f))) {
        anomalies.push({ runtimeTaskId: t.runtimeTaskId, type: 'planning-sop-in-review', detail: `Review task loaded planning context: ${t.filesInContext.filter((f) => /planning/i.test(f)).join(', ')}` });
      }
      if (t.phase === 6 && t.completionType !== 'completed') {
        anomalies.push({ runtimeTaskId: t.runtimeTaskId, type: 'missing-completion', detail: `Review task did not complete — type: ${t.completionType}` });
      }
      if (t.phase === 6 && t.completionText && !/(verdict|approved|rejected|needs revision)/i.test(t.completionText)) {
        anomalies.push({ runtimeTaskId: t.runtimeTaskId, type: 'no-verdict', detail: 'Review completion text does not contain expected verdict keywords' });
      }
    }
    return anomalies;
  }

  private readRegressionHandoffs(workspaceTaskId: string, ticketId: string): RegressionHandoffRecord[] {
    const filePath = path.join(this.workspaceRoot, workspaceTaskId, '.oshal', 'regression-trace.jsonl');
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as RegressionHandoffRecord)
        .filter((r) => r.ticketId === ticketId || r.sourceExternalId?.includes(ticketId));
    } catch (err) {
      logger.warn({ err, filePath }, 'Failed to read regression-trace.jsonl');
      return [];
    }
  }
}

// ── Pure parsing helpers ──────────────────────────────────────────────────────

function resolveWorkspaceRoot(): string {
  const configured = process.env.SHARED_WORKSPACE_ROOT || process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
  if (configured?.trim()) return path.resolve(configured.trim());
  return fs.existsSync('/app/workspace') ? '/app/workspace' : path.resolve(process.cwd(), 'workspace-shared');
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function extractFilesInContext(meta: Record<string, unknown> | null): string[] {
  if (!meta || !Array.isArray(meta.files_in_context)) return [];
  return (meta.files_in_context as Array<Record<string, unknown>>)
    .map((f) => typeof f.path === 'string' ? f.path : '')
    .filter((p) => p.length > 0);
}

function extractAgentIdFromContextFiles(files: string[]): string | null {
  const contextFile = files.find((f) => /^[a-f0-9-]{36}-context\.md$/.test(f));
  return contextFile ? contextFile.replace(/-context\.md$/, '') : null;
}

function extractTaskPrompt(msgs: Array<Record<string, unknown>> | null): string {
  if (!msgs) return '';
  const taskMsg = msgs.find((m) => m.say === 'task');
  return typeof taskMsg?.text === 'string' ? taskMsg.text : '';
}

function extractExternalId(prompt: string): string | null {
  const reviewMatch = prompt.match(/\b(review:[a-zA-Z0-9:_-]+)/);
  if (reviewMatch) return reviewMatch[1];
  const verifyMatch = prompt.match(/\b(verify:[a-zA-Z0-9:_-]+)/);
  if (verifyMatch) return verifyMatch[1];
  const idMatch = prompt.match(/Ticket:\s*([a-zA-Z0-9_-]{8,})/);
  return idMatch ? idMatch[1] : null;
}

function extractOriginalTicketId(externalId: string | null): string | null {
  if (!externalId) return null;
  const m = externalId.match(/^(?:review|verify):([^:]+)/);
  return m ? m[1] : externalId;
}

function extractPhaseRound(externalId: string | null, prompt: string): { phase: number | null; round: number | null } {
  if (externalId?.startsWith('review:')) {
    const roundMatch = externalId.match(/:r(\d+)$/);
    return { phase: 6, round: roundMatch ? Number(roundMatch[1]) : 1 };
  }
  if (externalId?.startsWith('verify:')) return { phase: 5, round: 1 };
  const phaseMatch = prompt.match(/Phase\s*(\d+)/i);
  return { phase: phaseMatch ? Number(phaseMatch[1]) : null, round: null };
}

function extractRole(prompt: string): string | null {
  const roleMatch = prompt.match(/acting as \*\*([^*]+)\*\*/i) || prompt.match(/role[:\s]+([a-z-]+)/i);
  return roleMatch ? roleMatch[1].trim() : null;
}

function extractToolCalls(msgs: Array<Record<string, unknown>> | null): string[] {
  if (!msgs) return [];
  return msgs
    .filter((m) => m.say === 'tool' && typeof m.text === 'string')
    .map((m) => {
      try { return (JSON.parse(m.text as string) as Record<string, unknown>).tool as string ?? 'unknown'; } catch { return 'unknown'; }
    })
    .filter((t) => t !== 'unknown');
}

function extractCompletion(msgs: Array<Record<string, unknown>> | null): { completionType: RuntimeTaskTrace['completionType']; completionText: string | null } {
  if (!msgs) return { completionType: 'unknown', completionText: null };
  const completion = [...msgs].reverse().find((m) => ['completion_result', 'error', 'task_completed'].includes(String(m.say ?? '')));
  if (!completion) return { completionType: 'unknown', completionText: null };
  const text = typeof completion.text === 'string' ? completion.text : null;
  const type = completion.say === 'error' ? 'failed'
    : (text ?? '').toLowerCase().includes('blocked') ? 'blocked'
    : 'completed';
  return { completionType: type, completionText: text?.slice(0, 500) ?? null };
}

function extractCreatedAt(msgs: Array<Record<string, unknown>> | null): string | null {
  if (!msgs || msgs.length === 0) return null;
  const ts = msgs[0].ts;
  return typeof ts === 'number' ? new Date(ts).toISOString() : null;
}

function isRelatedTrace(trace: RuntimeTaskTrace, ticketId: string): boolean {
  return trace.originalTicketId === ticketId
    || trace.externalId === ticketId
    || trace.externalId?.includes(ticketId) === true;
}

function compareByCreatedAt(a: RuntimeTaskTrace, b: RuntimeTaskTrace): number {
  if (!a.createdAt && !b.createdAt) return 0;
  if (!a.createdAt) return 1;
  if (!b.createdAt) return -1;
  return a.createdAt.localeCompare(b.createdAt);
}
