/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial batch runtime telemetry helpers for capturing Job identity, CPU/memory snapshots, and cgroup CPU request/limit without coupling the Job runner to Kubernetes APIs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BatchJobStatus, BatchJobTelemetryInput } from '@/features/batch-job-telemetry';
import type { BatchPhaseArgs } from './bot-node-batch';

const CPU_LIMIT_FILES = [
  '/sys/fs/cgroup/cpu.max',
  '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
];
const CPU_PERIOD_FILE = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';
const MEMORY_CURRENT_FILES = [
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
];

export interface BatchTelemetryStartSnapshot {
  jobId: string;
  workerId: string;
  queueName: string;
  startedAt: Date;
  startedHrtime: bigint;
  cpuStart: NodeJS.CpuUsage;
  processorCount: number;
  cpuRequestCores: number | null;
  cpuLimitCores: number | null;
  memoryUsageBytes: number | null;
  memoryRssBytes: number | null;
}

export interface BatchTelemetryFinishInput {
  status: BatchJobStatus;
  ownerSub?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  backendError?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * @description Capture immutable and start-of-run telemetry for a one-shot batch Job.
 * @param args - Batch phase arguments.
 * @returns the start snapshot used to build the final persisted row.
 */
export function captureBatchTelemetryStart(args: BatchPhaseArgs): BatchTelemetryStartSnapshot {
  return {
    jobId: resolveJobId(args),
    workerId: process.env.HOSTNAME || os.hostname(),
    queueName: process.env.ARGO_WORKFLOW_NAME || process.env.QUEUE_NAME || 'incident-rca-argo',
    startedAt: new Date(),
    startedHrtime: process.hrtime.bigint(),
    cpuStart: process.cpuUsage(),
    processorCount: availableProcessors(),
    cpuRequestCores: parseCpuCores(process.env.CPU_REQUEST || process.env.K8S_CPU_REQUEST),
    cpuLimitCores: parseCpuCores(process.env.CPU_LIMIT || process.env.K8S_CPU_LIMIT) ?? readCgroupCpuLimit(),
    memoryUsageBytes: readFirstNumericFile(MEMORY_CURRENT_FILES),
    memoryRssBytes: process.memoryUsage().rss,
  };
}

/**
 * @description Build the final telemetry payload for persistence after execution completes.
 * @param args - Batch phase arguments.
 * @param snapshot - Start snapshot captured before runtime bootstrap/execution.
 * @param finish - Terminal status and optional execution output fields.
 * @returns a complete telemetry row.
 */
export function buildBatchTelemetryRecord(
  args: BatchPhaseArgs,
  snapshot: BatchTelemetryStartSnapshot,
  finish: BatchTelemetryFinishInput,
): BatchJobTelemetryInput {
  const cpuDelta = process.cpuUsage(snapshot.cpuStart);
  const endedAt = new Date();
  return {
    jobId: snapshot.jobId,
    ticketId: args.ticketId,
    ownerSub: finish.ownerSub ?? null,
    agentId: args.agentId,
    phase: args.phase,
    queueName: snapshot.queueName,
    workerId: snapshot.workerId,
    status: finish.status,
    startedAt: snapshot.startedAt,
    endedAt,
    durationMs: Number((process.hrtime.bigint() - snapshot.startedHrtime) / BigInt(1_000_000)),
    processorCount: snapshot.processorCount,
    cpuRequestCores: snapshot.cpuRequestCores,
    cpuLimitCores: snapshot.cpuLimitCores,
    cpuUsageUserMicros: cpuDelta.user,
    cpuUsageSystemMicros: cpuDelta.system,
    memoryUsageBytes: readFirstNumericFile(MEMORY_CURRENT_FILES) ?? snapshot.memoryUsageBytes,
    memoryRssBytes: process.memoryUsage().rss,
    backendError: finish.backendError ? sanitizeError(finish.backendError) : null,
    provider: finish.provider ?? null,
    model: finish.model ?? null,
    costUsd: finish.costUsd ?? null,
    metadata: { ...finish.metadata, elapsedWallMs: endedAt.getTime() - snapshot.startedAt.getTime() },
  };
}

/**
 * @description Parse Kubernetes CPU quantities such as 500m, 1, or 250000u into cores.
 * @param value - CPU quantity text.
 * @returns CPU cores, or null when unavailable/unparseable.
 */
export function parseCpuCores(value?: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'max') return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/.exec(trimmed);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === 'n') return amount / 1_000_000_000;
  if (match[2] === 'u') return amount / 1_000_000;
  if (match[2] === 'm') return amount / 1_000;
  return amount;
}

function resolveJobId(args: BatchPhaseArgs): string {
  return process.env.ARGO_NODE_ID || process.env.JOB_NAME || `batch-${args.ticketId}-${args.phase}-${Date.now()}`;
}

function availableProcessors(): number {
  const fn = (os as typeof os & { availableParallelism?: () => number }).availableParallelism;
  return typeof fn === 'function' ? fn() : os.cpus().length;
}

function readCgroupCpuLimit(): number | null {
  const cpuMax = readText(CPU_LIMIT_FILES[0]);
  if (cpuMax) {
    const [quotaText, periodText] = cpuMax.trim().split(/\s+/);
    if (quotaText && quotaText !== 'max' && periodText) return Number(quotaText) / Number(periodText);
  }
  const quota = readNumericFile(CPU_LIMIT_FILES[1]);
  const period = readNumericFile(CPU_PERIOD_FILE);
  if (quota && quota > 0 && period && period > 0) return quota / period;
  return null;
}

function readFirstNumericFile(files: string[]): number | null {
  for (const file of files) {
    const value = readNumericFile(file);
    if (value !== null) return value;
  }
  return null;
}

function readNumericFile(file: string): number | null {
  const text = readText(file);
  if (!text) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(path.normalize(file), 'utf8');
  } catch {
    return null;
  }
}

function sanitizeError(error: string): string {
  return error.replace(/(token|secret|password|api[-_]?key)=\S+/gi, '$1=[REDACTED]').slice(0, 2000);
}
