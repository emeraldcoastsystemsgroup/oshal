/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the one-shot bot-node batch runner (ADR-078 §1): arg parsing, envelope shape (must satisfy the REAL MeshEnvelope contract — correlationId/channel, not id/type), MODE extraction, and the output accessor. The accessor is load-bearing: EnvelopeExecutionResult exposes only { success, output?, error? }, so reading `result.response` silently yields mode='unknown' forever.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cleared batch arg environment variables around missing-argument assertions so the test remains valid inside real bot containers that export AGENT_ID/PHASE.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseBatchArgs,
  buildPhaseEnvelope,
  extractMode,
  readPhaseOutput,
  writeModeFile,
} from '../../src/app/bot-node-batch';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseBatchArgs', () => {
  it('parses the flags Argo passes', () => {
    const args = parseBatchArgs(['--ticket-id=T-1', '--agent-id=A-1', '--phase=investigate']);
    expect(args).toMatchObject({ ticketId: 'T-1', agentId: 'A-1', phase: 'investigate' });
    expect(args.workspaceDir).toBeTruthy();
  });

  it('throws rather than silently no-op when a required arg is missing', () => {
    // A Job pod that quietly does nothing is worse than one that fails the DAG task.
    withClearedBatchEnv(() => {
      expect(() => parseBatchArgs(['--ticket-id=T-1'])).toThrow(/--agent-id/);
      expect(() => parseBatchArgs([])).toThrow(/--ticket-id/);
    });
  });

  it('accepts values containing = signs', () => {
    const args = parseBatchArgs(['--ticket-id=a=b', '--agent-id=A', '--phase=p']);
    expect(args.ticketId).toBe('a=b');
  });
});

function withClearedBatchEnv(fn: () => void): void {
  const saved = {
    TICKET_ID: process.env.TICKET_ID,
    AGENT_ID: process.env.AGENT_ID,
    PHASE: process.env.PHASE,
  };
  delete process.env.TICKET_ID;
  delete process.env.AGENT_ID;
  delete process.env.PHASE;
  try {
    fn();
  } finally {
    restoreEnv('TICKET_ID', saved.TICKET_ID);
    restoreEnv('AGENT_ID', saved.AGENT_ID);
    restoreEnv('PHASE', saved.PHASE);
  }
}

function restoreEnv(key: 'TICKET_ID' | 'AGENT_ID' | 'PHASE', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('buildPhaseEnvelope', () => {
  const args = { ticketId: 'T-1', agentId: 'A-1', phase: 'investigate', workspaceDir: '/w', title: 'DB down', description: 'Primary Postgres is refusing connections since 09:00.' };

  it('satisfies the real MeshEnvelope contract (correlationId + channel)', () => {
    const env = buildPhaseEnvelope(args);
    expect(env.correlationId).toContain('T-1');
    expect(env.toAgentId).toBe('A-1');
    expect(env.channel).toContain('A-1');
    expect(env.fromAgentId).toBe('argo-workflow');
  });

  it('marks the phase as swarm work, not a direct reasoning call', () => {
    const env = buildPhaseEnvelope(args);
    expect(env.payload.direct).toBe(false);
    expect(env.payload.ticketId).toBe('T-1');
  });

  // Double-check findings 2026-07-08 — each of these was live-traced through
  // buildExecutionUserMessage and was WRONG in the first version:
  it('carries the work content as workUnits (the only carrier on the non-direct path)', () => {
    const env = buildPhaseEnvelope(args);
    const workUnits = env.payload.workUnits as Array<Record<string, unknown>>;
    expect(workUnits).toHaveLength(1);
    expect(workUnits[0].title).toBe('DB down');
    expect(String(workUnits[0].description)).toContain('Primary Postgres is refusing connections');
    // The RCA mode contract must reach the persona: line 1 of RCA-REPORT.md.
    expect(String(workUnits[0].description)).toContain('RCA-REPORT.md');
    expect(String(workUnits[0].description)).toContain('MODE: A');
  });

  it('sets externalId — the key that drives ticket attribution (cost rows + ticket links)', () => {
    expect(buildPhaseEnvelope(args).payload.externalId).toBe('T-1');
  });

  it('never puts the phase NAME in the numeric phase slot (Number("investigate") = NaN)', () => {
    const env = buildPhaseEnvelope(args);
    expect(env.payload.phase).toBeUndefined();
    expect(env.payload.phaseName).toBe('investigate');
  });

  it('falls back to a usable title when the submitter passed none', () => {
    const env = buildPhaseEnvelope({ ...args, title: '' });
    const workUnits = env.payload.workUnits as Array<Record<string, unknown>>;
    expect(String(workUnits[0].title)).toContain('T-1');
  });
});

describe('extractMode', () => {
  it('lifts the classified MODE the DAG branches on', () => {
    expect(extractMode('Root cause found. MODE: B — remediation proposed.')).toBe('B');
    expect(extractMode('mode a')).toBe('A');
    expect(extractMode('...\nMODE C\n')).toBe('C');
  });

  it('returns unknown when the persona classified nothing', () => {
    expect(extractMode('no classification here')).toBe('unknown');
    expect(extractMode('')).toBe('unknown');
    expect(extractMode('MODE: Z')).toBe('unknown');
  });
});

describe('readPhaseOutput', () => {
  // EnvelopeExecutionResult is { success, output?, error? } — the text is INSIDE output.
  it('reads the response text out of the handler output payload', () => {
    const out = readPhaseOutput({ response: 'MODE: A', content: 'MODE: A', cost: 0.01, model: 'm', provider: 'p' });
    expect(out.response).toBe('MODE: A');
    expect(out.cost).toBe(0.01);
  });

  it('degrades safely on a missing or non-object payload', () => {
    expect(readPhaseOutput(undefined)).toEqual({});
    expect(readPhaseOutput('a string')).toEqual({});
    expect(readPhaseOutput(null)).toEqual({});
  });

  it('composes with extractMode the way runPhase does', () => {
    const result = { success: true, output: { response: 'Verdict. MODE: B' } };
    const mode = extractMode(readPhaseOutput(result.output).response ?? '');
    expect(mode).toBe('B');
  });
});

describe('writeModeFile', () => {
  const base = { agentId: 'A', phase: 'p', title: '', description: '' };
  it('writes mode.txt where the Argo output parameter points', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-batch-'));
    tmpDirs.push(workspaceDir);
    const modePath = writeModeFile({ ...base, ticketId: 'T-9', workspaceDir }, 'B');
    expect(modePath).toBe(path.join(workspaceDir, 'T-9', 'mode.txt'));
    expect(fs.readFileSync(modePath, 'utf8')).toBe('B');
  });

  it('creates the ticket directory when the phase produced no classification', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-batch-'));
    tmpDirs.push(workspaceDir);
    const modePath = writeModeFile({ ...base, ticketId: 'T-x', workspaceDir }, 'unknown');
    expect(fs.existsSync(modePath)).toBe(true);
    expect(fs.readFileSync(modePath, 'utf8')).toBe('unknown');
  });
});
