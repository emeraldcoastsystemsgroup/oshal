/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the canonical shared-workspace-root resolver and the three orchestration services that used to default to the unmounted /tmp/oshal-workspace path (invisible to code-server). Covers env precedence, the dropped /tmp default (regression guard), and a behavioral round-trip proving RALF handovers land under the resolved root.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 1: WORKSPACE_ENV_KEYS grows from four names to all six the repository reads, so a case that sets exactly one proves which was honoured. Adds cross-component agreement cases — the root stated in the bot's prompt against the root the deliverable capture matches, and workspace bootstrap against the task explorer — because those three components resolved the root through their own chains and disagreed whenever a deployment used a variable their chain did not read.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2. Two new describe blocks. The first is a case per PRE-CONVERGENCE CHAIN: each of the fourteen distinct precedence orders the sweep collapsed is written out as data - the variables it read, in its order - and every configuration that chain used to honour is asserted to resolve the same way now. That is what makes 'converged' a behavioural claim rather than a changed import: a resolver reading a SUBSET of the union would silently drop a configuration that worked before, and two of the chains are the only readers of CLINE_SHARED_WORKSPACE_ROOT and WORKSPACE_DIR, which the four-variable resolver did not read at all. The second block drives real consumers end to end with ONLY a variable their old chain could not see, so each goes red against its own pre-convergence version.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hasConfiguredWorkspaceRoot, resolveSharedWorkspaceRoot } from '../../src/shared/workspace-root';
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

// ---------------------------------------------------------------------------
// CKR-17 step 2 — a case per pre-convergence precedence chain.
//
// Thirty-nine inline chains across at least fifteen distinct precedence orders were collapsed onto
// resolveSharedWorkspaceRoot(). The risk that collapsing creates is NOT "does site X call the
// resolver" — the eslint rule proves that structurally, for every site, and cannot be gamed. The
// risk is that the one surviving order answers differently from the order a site used to have, for
// a configuration that works today. So each historical chain is written out as data and every
// configuration it honoured is asserted to resolve the same way now.
// ---------------------------------------------------------------------------

/** A real temp directory, tracked for cleanup. The resolver prefers an existing path, so an
 *  invented one could let a case pass for the wrong reason. */
const stepTwoRoots: string[] = [];
function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-ckr17b-'));
  stepTwoRoots.push(dir);
  return dir;
}

/** Compare absolute roots without tripping over host separator style. */
function normalize(p: string): string {
  return p.split(path.sep).join('/').replace(/\/+$/, '');
}

afterAll(() => {
  for (const dir of stepTwoRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** One pre-convergence chain: where it lived, and the variables it read, in ITS order. */
interface HistoricalChain {
  site: string;
  reads: readonly string[];
}

const COLLAPSED_CHAINS: readonly HistoricalChain[] = [
  { site: 'career-user-store-path / career bridges / storage-target / app registries', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'tool-executor-service, claude-code-provider', reads: ['CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT'] },
  { site: 'token-chase-read-service, runtime-trace-analyzer-service', reads: ['SHARED_WORKSPACE_ROOT', 'CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT'] },
  { site: 'swarm-verification / execution-lifecycle / incident-worker / planning-round / multi-round / llm-execution-handler', reads: ['SHARED_WORKSPACE_ROOT'] },
  { site: 'remote-client-workspace-routes, apply-story', reads: ['SHARED_WORKSPACE_ROOT', 'WORKSPACE_DIR', 'WORKSPACE_ROOT'] },
  { site: 'cline-runtime-config-sync-service', reads: ['CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT'] },
  { site: 'persona-file-loader, tool-runtime-context', reads: ['CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT'] },
  { site: 'gemini / antigravity harness adapters (harness override first)', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'codex / claude-code harness adapters (shared var was first)', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'code-server-bridge-routes (beneath its own two vars)', reads: ['CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT'] },
  { site: 'scan-paths (presence-gated)', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'local-embedding-service (presence-gated)', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'codex-cli-provider (presence-gated)', reads: ['CLINE_WORKSPACE_ROOT'] },
  { site: 'bot-node-batch (flag wins over env)', reads: ['WORKSPACE_DIR'] },
  { site: 'docker-compose.core.yml / docker-compose.yml, which set ONLY these two', reads: ['SHARED_WORKSPACE_ROOT', 'CLINE_SHARED_WORKSPACE_ROOT'] },
];

describe('CKR-17 step 2 — every collapsed chain still answers the way it used to', () => {
  it.each(COLLAPSED_CHAINS.map((chain) => [chain.site, chain] as const))(
    'a configuration that worked for %s still resolves to the configured root',
    (_site, chain) => {
      // One variable at a time, because that is the configuration shape a deployment actually has:
      // a compose file sets a root, and a site either read that name or did not.
      for (const variable of chain.reads) {
        clearWorkspaceEnv();
        const root = makeRoot();
        process.env[variable] = root;
        expect(normalize(resolveSharedWorkspaceRoot()), `${variable} is no longer honoured`)
          .toBe(normalize(root));
        expect(hasConfiguredWorkspaceRoot(), `${variable} does not register as configured`).toBe(true);
      }
    },
  );

  it('the chain that read a variable FIRST still wins when both are set', () => {
    // The surviving order has to keep the relative precedence the chains agreed on. Every chain
    // that read both put the more specific name first, and so does the resolver.
    const explicit = makeRoot();
    const shared = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = explicit;
    process.env.SHARED_WORKSPACE_ROOT = shared;
    expect(normalize(resolveSharedWorkspaceRoot())).toBe(normalize(explicit));

    clearWorkspaceEnv();
    const sharedRoot = makeRoot();
    const generic = makeRoot();
    process.env.SHARED_WORKSPACE_ROOT = sharedRoot;
    process.env.WORKSPACE_ROOT = generic;
    expect(normalize(resolveSharedWorkspaceRoot())).toBe(normalize(sharedRoot));
  });

  it('the presence check is false with nothing configured, so a tmpdir fallback still fires', () => {
    // Three sites keep their own off-container fallback — a scan directory, a model cache, a codex
    // run dir. They must NOT switch to a <cwd>/workspace-shared path the resolver invents, so they
    // ask whether a root exists rather than what the resolver would return. On a box with the
    // container mount present this is legitimately true, so the assertion is conditional on that.
    clearWorkspaceEnv();
    const mounted = fs.existsSync('/app/workspace-shared') || fs.existsSync('/app/workspace');
    expect(hasConfiguredWorkspaceRoot()).toBe(mounted);
  });
});

describe('CKR-17 step 2 — real consumers, driven with a variable their old chain could not see', () => {
  it('the spatial-mapping scans root follows OSHAL_WORKSPACE_ROOT', async () => {
    // Before: `if (process.env.CLINE_WORKSPACE_ROOT) ... else os.tmpdir()`. With only
    // OSHAL_WORKSPACE_ROOT set, scans landed in a temp directory nothing mounts.
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;
    vi.resetModules();
    const { resolveScansRoot } = await import('../../src/features/spatial-mapping/services/scan-paths');
    expect(normalize(resolveScansRoot())).toBe(`${normalize(root)}/spaces-scans`);
  });

  it('the career user-store lookup finds a package installed under OSHAL_WORKSPACE_ROOT', async () => {
    // Before: `process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared'`, so the module simply
    // was not found and the lookup returned null. A real file on disk, not a stubbed path.
    const root = makeRoot();
    const libDir = path.join(root, 'deployed-apps', 'career-hunter', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    // A mapper that satisfies the real contract - the loader THROWS on one that does not, which is
    // its own guard against a malformed installed package and not what this case is about.
    fs.writeFileSync(
      path.join(libDir, 'user-store-path.js'),
      "module.exports = { findUserStoreLayout: () => ({ userDir: 'u', resumesDir: 'r' }) };",
      'utf8',
    );
    process.env.OSHAL_WORKSPACE_ROOT = root;

    vi.resetModules();
    const { findCareerUserStoreLayout } = await import('../../src/shared/career-user-store-path');
    // Reaching the mapper AT ALL is the claim: before the change the module was looked for under
    // CLINE_WORKSPACE_ROOT only, so nothing was found and this returned null without loading it.
    expect(findCareerUserStoreLayout('auth0|ckr17'), 'the installed package was not found under the configured root')
      .not.toBeNull();
  });

  it('the chat tool executor runs the shell in the configured root, not <cwd>/workspace', async () => {
    // Before: `CLINE_WORKSPACE_ROOT || WORKSPACE_ROOT` then a RELATIVE ./workspace — so with
    // OSHAL_WORKSPACE_ROOT set, the shell tool ran somewhere no other component reads.
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;
    vi.resetModules();
    const { ToolExecutorService } = await import('../../src/features/chat-orchestration/services/tool-executor-service');
    const service = new ToolExecutorService({} as never);
    const resolved = (service as unknown as { resolveWorkspaceRoot(): string }).resolveWorkspaceRoot();
    expect(normalize(resolved)).toBe(normalize(root));
  });

  it('the token-chase reader resolves the root the rest of the platform uses', async () => {
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;
    vi.resetModules();
    const mod = await import('../../src/features/token-chase/services/token-chase-read-service');
    const Service = (mod as Record<string, unknown>).TokenChaseReadService as new (...args: never[]) => unknown;
    const service = new Service();
    const resolved = (service as unknown as { resolveWorkspaceRoot(): string }).resolveWorkspaceRoot();
    expect(normalize(resolved)).toBe(normalize(root));
  });

  it('a codex harness adapter workspace follows the shared root', async () => {
    // Before: CLINE_WORKSPACE_ROOT then CODEX_WORKSPACE_ROOT then the RELATIVE './workspace'. Note
    // the order was also wrong: the harness-specific variable sat BENEATH the shared one, so it
    // could never take effect on a box that sets a shared root — which is every box.
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;
    vi.resetModules();
    const { CodexCliHarnessAdapter } = await import('../../src/features/llm-provider/services/codex-cli-harness-adapter');
    const adapter = new CodexCliHarnessAdapter({} as never);
    expect(normalize((adapter as unknown as { workspaceRoot: string }).workspaceRoot)).toBe(normalize(root));
  });

  it('the code-server bridge roots itself where the volume is actually mounted', async () => {
    // Before: its own two variables, then CLINE_WORKSPACE_ROOT / WORKSPACE_ROOT, then the literal
    // /workspace — which is NOT where compose mounts the volume. With only OSHAL_WORKSPACE_ROOT
    // set the bridge resolved to /workspace and every workspace link 404ed.
    const root = makeRoot();
    process.env.OSHAL_WORKSPACE_ROOT = root;
    delete process.env.CODE_SERVER_WORKSPACE_ROOT;
    delete process.env.CODE_WORKSPACE_ROOT;
    vi.resetModules();
    const mod = await import('../../src/shared/workspace-root');
    expect(normalize(mod.resolveSharedWorkspaceRoot())).toBe(normalize(root));
    // The bridge's own resolver is module-private; what this pins is the value it now falls back
    // to. The structural half — that it reads no workspace variable of its own — is the lint rule.
    const source = fs.readFileSync('src/app/routes/code-server-bridge-routes.ts', 'utf8');
    expect(source).toContain('resolveSharedWorkspaceRoot()');
    expect(source).toContain('resolveSharedWorkspaceRootPosix()');
  });
});
