/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial unit coverage for batch Job telemetry CPU quantity parsing and terminal record assembly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Restored batch telemetry env overrides after record assembly assertions to avoid cross-test contamination.
 */

import { describe, expect, it } from 'vitest';
import { buildBatchTelemetryRecord, captureBatchTelemetryStart, parseCpuCores } from '../../src/app/bot-node-batch-telemetry';

describe('parseCpuCores', () => {
  it('parses Kubernetes CPU quantities into cores', () => {
    expect(parseCpuCores('500m')).toBe(0.5);
    expect(parseCpuCores('2')).toBe(2);
    expect(parseCpuCores('250000u')).toBe(0.25);
    expect(parseCpuCores('1000000000n')).toBe(1);
  });

  it('returns null for max, empty, or invalid values', () => {
    expect(parseCpuCores('max')).toBeNull();
    expect(parseCpuCores('')).toBeNull();
    expect(parseCpuCores('not-cpu')).toBeNull();
  });
});

describe('buildBatchTelemetryRecord', () => {
  it('builds a persisted telemetry shape with sanitized backend errors', () => {
    withBatchEnv({
      CPU_REQUEST: '250m',
      CPU_LIMIT: '1',
      JOB_NAME: 'job-123',
      QUEUE_NAME: 'queue-a',
    }, () => {
      const args = { ticketId: 'T-1', agentId: 'A-1', phase: 'investigate', workspaceDir: '/tmp', title: '', description: '' };
      const start = captureBatchTelemetryStart(args);
      const record = buildBatchTelemetryRecord(args, start, {
        status: 'failed',
        provider: 'codex',
        model: 'gpt',
        costUsd: 0.1,
        backendError: 'provider failed token=abc123',
      });

      expect(record).toMatchObject({
        jobId: 'job-123',
        ticketId: 'T-1',
        agentId: 'A-1',
        phase: 'investigate',
        queueName: 'queue-a',
        status: 'failed',
        processorCount: expect.any(Number),
        cpuRequestCores: 0.25,
        cpuLimitCores: 1,
        provider: 'codex',
        model: 'gpt',
        costUsd: 0.1,
      });
      expect(record.backendError).toBe('provider failed token=[REDACTED]');
    });
  });
});

function withBatchEnv(overrides: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
