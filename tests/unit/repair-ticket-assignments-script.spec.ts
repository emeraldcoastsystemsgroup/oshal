import { describe, expect, it } from 'vitest';
import { buildCandidateSql, parseArgs } from '../../scripts/operations/repair-ticket-assignments';

describe('repair-ticket-assignments script', () => {
  it('defaults to dry-run with workerBot evidence enabled', () => {
    expect(parseArgs([])).toMatchObject({
      mode: 'dry-run',
      limit: 5000,
      includeWorkerBot: true,
      allowMissingAgent: false,
      showHelp: false,
    });
  });

  it('parses apply and safety toggles', () => {
    expect(parseArgs(['--apply', '--limit=25', '--no-worker-bot', '--allow-missing-agent'])).toMatchObject({
      mode: 'apply',
      limit: 25,
      includeWorkerBot: false,
      allowMissingAgent: true,
    });
  });

  it('builds candidate SQL that can include or exclude workerBot name resolution', () => {
    expect(buildCandidateSql(true)).toContain('ticket_status_history.metadata.workerBot');
    expect(buildCandidateSql(true)).toContain('JOIN agents a ON lower(a.name)');
    expect(buildCandidateSql(true)).toContain("work_items.execution_output.agentId");
    expect(buildCandidateSql(false)).toContain('WHERE false');
  });
});
