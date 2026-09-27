/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the per-turn tool-read classification (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §8): a declared workspace-read/-write stays pinned, a live tool is unpinned, an UNDECLARED tool is unpinned (fails closed), the registry retains the declared class, pinned results are stored redacted and content-addressed, pins are per frame (drained, not per run), and the capture lane turns an unpinned pin into replayable:false.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const provenance = requireModule('../../any-bot/server/services/token-chase/turn-provenance.js') as {
  TurnProvenance: new (o: { workspaceDir: string; redact: (t: string) => string }) => {
    record(call: Record<string, unknown>): Record<string, unknown>;
    drain(): Array<Record<string, unknown>>;
  };
  classifyTool(def: unknown): { replayClass: string; declared: boolean };
  createTurnProvenance(lane: { isEnabled: () => boolean; redact: (t: string) => string }, dir: string | null): unknown;
  isPinnedClass(c: string): boolean;
  REPLAY_CLASSES: string[];
};
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry.js') as new () => {
  register(def: Record<string, unknown>): void;
  get(name: string): { replayClass?: string } | undefined;
  getMetadata(name: string): { replayClass: string | null } | null;
};
const { fileToolDefinitions } = requireModule('../../any-bot/server/services/tools/fileTools.js') as {
  fileToolDefinitions(): Array<{ name: string; replayClass: string }>;
};

const identity = (t: string): string => t;
const scrub = (t: string): string => t.replace(/hunter2secret/g, '[REDACTED]');
const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-turns-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe('Token Chase turn provenance — replay classification', () => {
  it('classifies declared classes and fails an undeclared tool closed to live-read', () => {
    expect(provenance.classifyTool({ replayClass: 'workspace-read' })).toEqual({ replayClass: 'workspace-read', declared: true });
    expect(provenance.classifyTool({ replayClass: 'side-effect' })).toEqual({ replayClass: 'side-effect', declared: true });
    expect(provenance.classifyTool({ name: 'weather_now' })).toEqual({ replayClass: 'live-read', declared: false });
    expect(provenance.classifyTool({ replayClass: 'not-a-class' })).toEqual({ replayClass: 'live-read', declared: false });
    expect(provenance.classifyTool(null)).toEqual({ replayClass: 'live-read', declared: false });
    expect(provenance.REPLAY_CLASSES).toEqual(['workspace-read', 'workspace-write', 'pure', 'live-read', 'side-effect']);
    expect(provenance.isPinnedClass('pure')).toBe(true);
    expect(provenance.isPinnedClass('live-read')).toBe(false);
  });

  it('the registry retains a declared replayClass and the real file tools declare theirs', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'declared', description: '', inputSchema: {}, handler: async () => ({}), replayClass: 'pure', requiresApproval: false });
    registry.register({ name: 'undeclared', description: '', inputSchema: {}, handler: async () => ({}), requiresApproval: false });
    expect(registry.get('declared')?.replayClass).toBe('pure');
    expect(registry.getMetadata('declared')?.replayClass).toBe('pure');
    expect(registry.get('undeclared')?.replayClass).toBeUndefined();
    expect(provenance.classifyTool(registry.get('undeclared')).replayClass).toBe('live-read');
    const byName = Object.fromEntries(fileToolDefinitions().map((d) => [d.name, d.replayClass]));
    expect(byName).toEqual({ read_file: 'workspace-read', write_to_file: 'workspace-write', list_files: 'workspace-read', execute_command: 'side-effect' });
  });

  it('pins a workspace-read turn, unpins a live turn and an unknown tool, and drains per frame', async () => {
    const root = tempRoot();
    const turns = new provenance.TurnProvenance({ workspaceDir: root, redact: identity });
    const read = turns.record({ tool: 'read_file', callId: 'c1', toolDefinition: { replayClass: 'workspace-read' }, input: { path: 'a.txt' }, result: { content: 'x' }, success: true });
    expect(read).toMatchObject({ tool: 'read_file', callId: 'c1', replayClass: 'workspace-read', declared: true, pinned: true, success: true, stored: true });
    expect(read.resultSha256).toBe(crypto.createHash('sha256').update(JSON.stringify({ content: 'x' })).digest('hex'));
    // Frame boundary: everything recorded so far belongs to the NEXT frame and only that one.
    const frameOne = turns.drain();
    expect(frameOne).toHaveLength(1);
    expect(turns.drain()).toEqual([]);

    const live = turns.record({ tool: 'weather_now', callId: 'c2', toolDefinition: { replayClass: 'live-read' }, input: {}, result: { temp: 20 }, success: true });
    const unknown = turns.record({ tool: 'mystery', callId: 'c3', toolDefinition: {}, input: {}, result: { v: 1 }, success: true });
    const failed = turns.record({ tool: 'read_file', callId: 'c4', toolDefinition: { replayClass: 'workspace-read' }, input: { path: 'missing' }, success: false, error: 'File not found: missing' });
    expect(live).toMatchObject({ pinned: false, replayClass: 'live-read', declared: true });
    expect(unknown).toMatchObject({ pinned: false, replayClass: 'live-read', declared: false });
    expect(failed).toMatchObject({ pinned: false, success: false });
    expect(String(unknown.reason)).toContain('not reproducible');
    const frameTwo = turns.drain();
    expect(frameTwo.map((p) => p.callId)).toEqual(['c2', 'c3', 'c4']);

    await new Promise((r) => setImmediate(r));
    const objects = path.join(root, '.tokenchase', 'objects');
    expect(fs.readFileSync(path.join(objects, String(read.resultSha256)), 'utf8')).toBe(JSON.stringify({ content: 'x' }));
    // Unpinned results are never stored; only the pinned read produced an object.
    expect(fs.readdirSync(objects)).toEqual([String(read.resultSha256)]);
  });

  it('stores pinned results REDACTED and hashes the redacted bytes', async () => {
    const root = tempRoot();
    const turns = new provenance.TurnProvenance({ workspaceDir: root, redact: scrub });
    const pin = turns.record({ tool: 'read_file', callId: 'c1', toolDefinition: { replayClass: 'workspace-read' }, input: { path: 'creds.txt' }, result: { content: 'password: hunter2secret' }, success: true });
    await new Promise((r) => setImmediate(r));
    const stored = fs.readFileSync(path.join(root, '.tokenchase', 'objects', String(pin.resultSha256)), 'utf8');
    expect(stored).not.toContain('hunter2secret');
    expect(pin.resultSha256).toBe(crypto.createHash('sha256').update(stored).digest('hex'));
  });

  it('is absent when capture is off, so the loop stays byte-identical', () => {
    expect(provenance.createTurnProvenance({ isEnabled: () => false, redact: identity }, tempRoot())).toBeNull();
    expect(provenance.createTurnProvenance({ isEnabled: () => true, redact: identity }, null)).toBeNull();
    expect(provenance.createTurnProvenance({ isEnabled: () => true, redact: identity }, tempRoot())).toBeInstanceOf(provenance.TurnProvenance);
  });
});
