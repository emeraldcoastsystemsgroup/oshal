/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the canonical shared-workspace-root resolver and the three orchestration services that used to default to the unmounted /tmp/oshal-workspace path (invisible to code-server). Covers env precedence, the dropped /tmp default (regression guard), and a behavioral round-trip proving RALF handovers land under the resolved root.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 1: WORKSPACE_ENV_KEYS grows from four names to all six the repository reads, so a case that sets exactly one proves which was honoured. Adds cross-component agreement cases — the root stated in the bot's prompt against the root the deliverable capture matches, and workspace bootstrap against the task explorer — because those three components resolved the root through their own chains and disagreed whenever a deployment used a variable their chain did not read.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveSharedWorkspaceRoot } from '../../src/shared/workspace-root';
import { RALFHandoverManager } from '../../src/features/swarm-orchestration/services/ralf-handover-manager';

// ---------------------------------------------------------------------------
// Env helpers — these vars steer the resolver, so snapshot and restore them.
// ---------------------------------------------------------------------------

// Every workspace variable this repository reads, not only the four the canonical resolver
// consults. A case that sets exactly one can then prove which one was honoured: with the other
// five cleared, a component that still finds the configured root can only have read that one.
const WORKSPACE_ENV_KEYS = [
  'OSHAL_WORKSPACE_ROOT',
  'SHARED_WORKSPACE_ROOT',
  'CLINE_WORKSPACE_ROOT',
  'CLINE_SHARED_WORKSPACE_ROOT',
  'WORKSPACE_ROOT',
  'WORKSPACE_DIR',
] as const;

let savedEnv: Record<string, string | undefined> = {};

function clearWorkspaceEnv(): void {
  for (const key of WORKSPACE_ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  savedEnv = {};
  for (const key of WORKSPACE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearWorkspaceEnv();
});

afterEach(() => {
  for (const key of WORKSPACE_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// resolveSharedWorkspaceRoot — precedence
// ---------------------------------------------------------------------------

describe('resolveSharedWorkspaceRoot — env precedence', () => {
  it('honors OSHAL_WORKSPACE_ROOT first (explicit override)', () => {
    process.env.OSHAL_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'oshal-root');
    process.env.SHARED_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'shared-root');
    expect(resolveSharedWorkspaceRoot()).toBe(path.resolve(os.tmpdir(), 'oshal-root'));
  });

  it('falls through to SHARED_WORKSPACE_ROOT when OSHAL_WORKSPACE_ROOT is unset', () => {
    process.env.SHARED_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'shared-root');
    process.env.WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'generic-root');
    expect(resolveSharedWorkspaceRoot()).toBe(path.resolve(os.tmpdir(), 'shared-root'));
  });

  it('falls through to CLINE_WORKSPACE_ROOT, then WORKSPACE_ROOT', () => {
    process.env.CLINE_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'cline-root');
    process.env.WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'generic-root');
    expect(resolveSharedWorkspaceRoot()).toBe(path.resolve(os.tmpdir(), 'cline-root'));

    delete process.env.CLINE_WORKSPACE_ROOT;
    expect(resolveSharedWorkspaceRoot()).toBe(path.resolve(os.tmpdir(), 'generic-root'));
  });

  it('ignores empty/whitespace-only env values', () => {
    process.env.OSHAL_WORKSPACE_ROOT = '   ';
    process.env.SHARED_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'shared-root');
    expect(resolveSharedWorkspaceRoot()).toBe(path.resolve(os.tmpdir(), 'shared-root'));
  });

  it('returns an absolute path', () => {
    process.env.SHARED_WORKSPACE_ROOT = path.resolve(os.tmpdir(), 'shared-root');
    expect(path.isAbsolute(resolveSharedWorkspaceRoot())).toBe(true);
  });

  it('never resolves to the legacy /tmp/oshal-workspace default (regression guard)', () => {
    // No env set: must land on a real mounted/local root, not the old ephemeral default.
    const resolved = resolveSharedWorkspaceRoot();
    expect(resolved).not.toContain('oshal-workspace');
    // Local-dev fallback when no container mount exists.
    if (!fs.existsSync('/app/workspace-shared') && !fs.existsSync('/app/workspace')) {
      expect(resolved).toBe(path.resolve(process.cwd(), 'workspace-shared'));
    }
  });
});

// ---------------------------------------------------------------------------
// RALFHandoverManager — behavioral round-trip
// ---------------------------------------------------------------------------

describe('RALFHandoverManager — uses the resolved shared root', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-ws-'));
    process.env.OSHAL_WORKSPACE_ROOT = tmpRoot;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('writes handovers under the resolved root and reads them back', () => {
    const mgr = new RALFHandoverManager(); // no-arg → must resolve to OSHAL_WORKSPACE_ROOT
    const taskId = 'task_codeserver_demo';

    const written = mgr.writeHandover(taskId, 'code-developer', 4, 1, 'Implemented the fix.');
    expect(written).toBeTruthy();

    // The file must physically exist under the resolved root, not /tmp/oshal-workspace.
    const expectedPath = path.join(
      tmpRoot, taskId, 'developer-handovers', 'code-developer_PHASE_4_ROUND_1.md',
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

    const handovers = mgr.readHandovers(taskId);
    expect(handovers).toHaveLength(1);
    expect(handovers[0].agentId).toBe('code-developer');
    expect(handovers[0].phase).toBe(4);
  });

  it('honors an explicit constructor root over the env default', () => {
    const explicitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-explicit-'));
    try {
      const mgr = new RALFHandoverManager(explicitRoot);
      mgr.writeHandover('task_x', 'agent-1', 2, 1, 'note');
      expect(fs.existsSync(path.join(explicitRoot, 'task_x', 'developer-handovers'))).toBe(true);
      // The env-derived tmpRoot must NOT have been used.
      expect(fs.existsSync(path.join(tmpRoot, 'task_x'))).toBe(false);
    } finally {
      fs.rmSync(explicitRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Source regression guard — the three services must not reintroduce /tmp.
// ---------------------------------------------------------------------------

describe('orchestration services — no /tmp/oshal-workspace default', () => {
  const services = [
    'ralf-handover-manager.ts',
    'workspace-artifact-enforcer.ts',
    'failure-governance-service.ts',
  ];

  for (const file of services) {
    it(`${file} resolves via resolveSharedWorkspaceRoot and drops the /tmp default`, () => {
      const filePath = path.resolve(
        __dirname,
        '../../src/features/swarm-orchestration/services',
        file,
      );
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('resolveSharedWorkspaceRoot');
      expect(content).not.toContain("'/tmp/oshal-workspace'");
    });
  }
});

// ---------------------------------------------------------------------------
// CKR-17 — components must agree on the root, not merely resolve one each.
//
// The cases above prove the canonical resolver behaves. These prove the
// components USE it. Three of them did not: two containment boundaries and the
// path the bot is instructed to write everything into each read their own
// subset of the six variables, so a deployment configured through a variable
// their chain did not read sent them to different directories.
//
// Each case imports AFTER setting the variable. A module-scope const freezes
// the root at import, so a statically imported module would answer with a root
// from before the case ran and the assertion would pass without proving
// anything — which is why the deliverable module had to move to call-time
// resolution rather than merely calling the resolver at module scope.
// ---------------------------------------------------------------------------

describe('CKR-17 — components resolve the same shared workspace root', () => {
  const ckrTempRoots: string[] = [];

  /** A real directory: the resolver prefers an existing container path, so an
   *  invented one could let a case pass for the wrong reason. */
  function makeRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-ckr17-'));
    ckrTempRoots.push(dir);
    return dir;
  }

  /** Compare absolute roots without tripping over host separator style. */
  function normalize(p: string): string {
    return p.split(path.sep).join('/').replace(/\/+$/, '');
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterAll(() => {
    for (const dir of ckrTempRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('the root stated in the bot prompt is the root the deliverable capture matches', async () => {
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;

    const { buildUserMessage } = await import(
      '../../src/features/swarm-orchestration/services/llm-execution-handler'
    );
    const { extractWorkspacePaths } = await import('../../src/app/routes/jarvis-deliverable-files');

    const message = buildUserMessage({
      correlationId: 'ckr17-guard',
      fromAgentId: 'ckr17-sender',
      toAgentId: 'ckr17-agent',
      type: 'execution-request',
      payload: { type: 'execution-request', description: 'probe' },
    } as never);
    const promptRoot = /Your workspace directory is: (.+)/.exec(message)?.[1]?.trim();
    expect(promptRoot, 'the prompt stated no workspace directory').toBeTruthy();
    expect(normalize(promptRoot as string)).toBe(normalize(root));

    // Forward slashes: the text under extraction is written by a bot in a Linux container.
    const probe = `${normalize(root)}/t1/deliverables/report.md`;
    expect(extractWorkspacePaths(`The report is at ${probe} and that is all.`)).toEqual([probe]);
  });

  it('workspace bootstrap and the task explorer resolve the same root', async () => {
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;

    const { WorkspaceBootstrapService } = await import(
      '../../src/features/workspace-bootstrap/services/workspace-bootstrap-service'
    );
    const { TaskExplorerWorkspaceService } = await import(
      '../../src/features/task-explorer/services/task-explorer-workspace-service'
    );

    // Bootstrap exposes its root through the path it reports for a task.
    const status = await new WorkspaceBootstrapService().getTaskWorkspaceStatus('probe-task');
    const bootstrapRoot = normalize(status.workspacePath).replace(/\/probe-task$/, '');

    // The explorer resolves its root once, in the constructor. Read that field rather than
    // fabricating a principal: the root is what is under test, not the authorization path.
    const explorer = new TaskExplorerWorkspaceService({} as never);
    const explorerRoot = normalize((explorer as unknown as { workspaceRoot: string }).workspaceRoot);

    expect(bootstrapRoot).toBe(normalize(root));
    expect(explorerRoot).toBe(normalize(root));
  });
});
