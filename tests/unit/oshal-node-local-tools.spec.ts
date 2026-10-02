/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | OSHAL Node local tools, the node side of "the node runs its own chat" (2026-10-01): a CLI executor is advertised only while its CLI is installed and signed in here (the swarm checks the advertised list before handing the node its own chat turn); antigravity.exec runs the Antigravity executor and reports its usage in the shape the swarm reads; swarm.exec falls back to Antigravity after codex and claude; and the worker marks quiet only a node-chat run of a chat executor, never another tool wearing the origin. The executors are intercepted at their module boundary, so no CLI runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({ codex: false, claude: false, agy: false, runs: [] as Array<{ which: string; prompt: string; model?: string }> }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (p: string) => {
    const s = String(p).replace(/\\/g, '/');
    if (s.endsWith('/.codex/auth.json')) return probes.codex;
    if (s.endsWith('/.claude/.credentials.json')) return probes.claude;
    return actual.existsSync(p);
  } };
});
vi.mock('../../packages/oshal-chat/src/main/executors', () => ({
  runCodex: async (prompt: string, opts: { model?: string } = {}) => { probes.runs.push({ which: 'codex', prompt, model: opts.model }); return ok('from codex'); },
  runClaude: async (prompt: string, opts: { model?: string } = {}) => { probes.runs.push({ which: 'claude', prompt, model: opts.model }); return ok('from claude'); },
}));
vi.mock('../../packages/oshal-chat/src/main/antigravity-executor', () => ({
  antigravityInstalled: () => probes.agy,
  runAntigravity: async (prompt: string, opts: { model?: string } = {}) => { probes.runs.push({ which: 'agy', prompt, model: opts.model }); return ok('from agy', { inputTokens: 25290, outputTokens: 1, totalTokens: 25291 }); },
}));
function ok(text: string, usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }) {
  return { success: true, text, costUSD: 0, usage, durationMs: 5, exitCode: 0, stderr: '' };
}

import { localCapabilities, localToolList, runLocalTool } from '../../packages/oshal-chat/src/main/local-tools';

beforeEach(() => { probes.codex = false; probes.claude = false; probes.agy = false; probes.runs.length = 0; });
afterEach(() => { probes.runs.length = 0; });

describe('what the node advertises', () => {
  it('offers a CLI executor only while that CLI is installed and signed in here; swarm.exec and the system tools are not gated by it', () => {
    expect(localCapabilities()).toEqual(['swarm.exec']);
    probes.agy = true;
    expect(localCapabilities()).toEqual(['antigravity.exec', 'swarm.exec']);
    probes.codex = true; probes.claude = true;
    expect(localCapabilities()).toEqual(['codex.exec', 'claude.exec', 'antigravity.exec', 'swarm.exec']);
    expect(localCapabilities({ allowSystemControl: true })).toEqual(['codex.exec', 'claude.exec', 'antigravity.exec', 'swarm.exec', 'screen.capture', 'shell.exec', 'desktop.control', 'app.open']);
    expect(localToolList().map((t) => t.name)).toEqual(['codex.exec', 'claude.exec', 'antigravity.exec', 'swarm.exec']);
  });
});

describe('running the executors', () => {
  it('antigravity.exec runs agy with the prompt and the model the swarm named, and reports usage the swarm reads', async () => {
    probes.agy = true;
    const outcome = await runLocalTool('antigravity.exec', { prompt: 'hello', model: 'gemini-3.8-flash-low' }, {});
    expect(outcome).toMatchObject({ success: true, text: 'from agy', output: { response: 'from agy', provider: 'antigravity-cli', usage: { inputTokens: 25290, outputTokens: 1 } } });
    expect(probes.runs).toEqual([{ which: 'agy', prompt: 'hello', model: 'gemini-3.8-flash-low' }]);
    expect(await runLocalTool('antigravity.exec', {}, {})).toMatchObject({ success: false, error: 'antigravity.exec requires a prompt' });
  });

  it('swarm.exec prefers codex, then claude, then Antigravity, and says so when none is signed in', async () => {
    expect(await runLocalTool('swarm.exec', { prompt: 'p' }, {})).toMatchObject({ success: false, error: expect.stringContaining('codex/claude/Antigravity') });
    probes.agy = true;
    expect((await runLocalTool('swarm.exec', { prompt: 'p' }, {})).output).toMatchObject({ provider: 'antigravity-cli' });
    probes.claude = true;
    expect((await runLocalTool('swarm.exec', { prompt: 'p' }, {})).output).toMatchObject({ provider: 'claude-code' });
    probes.codex = true;
    expect((await runLocalTool('swarm.exec', { prompt: 'p' }, {})).output).toMatchObject({ provider: 'openai-codex' });
  });
});
