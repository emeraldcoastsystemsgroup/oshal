/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CLI driver for the Dev Session Engine (ADR-077 Phase 2). The host/sidecar node uses this to open an isolated worktree, apply an edit, review the diff, verify, and commit to a session branch.
 */

/**
 * Dev Session CLI — drive the isolated-worktree edit governance from the host/sidecar node.
 *
 * Subcommands (state persists in <worktreesRoot>/sessions.json so steps span invocations):
 *   create   [--label <text>]                 open a session (worktree + branch)
 *   apply    <id> <changeset.json>            write a reviewed change set ([{path,content},...])
 *   agent-edit <id> -- <cmd...>               run an agent command in the SANDBOX; apply its edits
 *   diff     <id>                             print the reviewable diff
 *   verify   <id> [-- <cmd...>]               run the verify gate (default: npm run typecheck)
 *   commit   <id> <message>                   commit staged changes to the session branch (verify must have passed)
 *   teardown <id> [--keep-branch]             dispose the worktree (and branch)
 *   list                                      list sessions
 *
 * The agentic edit runs via `agent-edit`, which executes the agent command inside a LOCKED-DOWN
 * container (SandboxedAgentRunner) and applies its result through the governed engine — a cwd is
 * not a sandbox. For a real LLM agent the command is e.g. `claude -p "<instruction>"` with a
 * read-only creds mount + a narrow provider-egress network (see the orchestrator options).
 *
 * Repo root: $OSHAL_REPO_ROOT or cwd.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DevSessionEngine, DevSessionOrchestrator, SandboxedAgentRunner, type DevSession } from '@/features/dev-console';

const repoRoot = path.resolve(process.env.OSHAL_REPO_ROOT ?? process.cwd());
const worktreesRoot = path.resolve(process.env.OSHAL_DEV_WORKTREES ?? path.join(repoRoot, '..', 'oshal-dev-sessions'));
const registryPath = path.join(worktreesRoot, 'sessions.json');
const engine = new DevSessionEngine({ repoRoot, worktreesRoot });

type Registry = Record<string, DevSession>;

function loadRegistry(): Registry {
  if (!existsSync(registryPath)) return {};
  try { return JSON.parse(readFileSync(registryPath, 'utf8')) as Registry; } catch { return {}; }
}

function saveRegistry(reg: Registry): void {
  mkdirSync(worktreesRoot, { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
}

function requireSession(id: string): DevSession {
  const session = loadRegistry()[id];
  if (!session) throw new Error(`unknown session '${id}' (run: dev-session list)`);
  return session;
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function splitAtDashes(args: string[]): { head: string[]; rest: string[] } {
  const idx = args.indexOf('--');
  return idx === -1 ? { head: args, rest: [] } : { head: args.slice(0, idx), rest: args.slice(idx + 1) };
}

function run(): void {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'create': {
      const label = flag(args, '--label');
      const session = engine.create(label);
      const reg = loadRegistry();
      reg[session.id] = session;
      saveRegistry(reg);
      out({ ok: true, session });
      return;
    }
    case 'apply': {
      const [id, changesetPath] = args;
      const edits = JSON.parse(readFileSync(path.resolve(changesetPath), 'utf8'));
      const written = engine.applyChangeSet(requireSession(id), edits);
      out({ ok: true, written });
      return;
    }
    case 'agent-edit': {
      const { head, rest } = splitAtDashes(args);
      const session = requireSession(head[0]);
      if (rest.length === 0) throw new Error('usage: agent-edit <id> -- <cmd...>  (the command runs inside the sandbox)');
      const orchestrator = new DevSessionOrchestrator(
        engine,
        new SandboxedAgentRunner(),
        path.join(worktreesRoot, '..', 'oshal-dev-scratch'),
      );
      const result = orchestrator.runAgentEdit(session, rest);
      out({
        ok: true,
        agentExitCode: result.agentExitCode,
        filesChanged: result.filesChanged,
        deleted: result.deleted,
        skippedBinary: result.skippedBinary,
        diffFiles: result.diff.files,
      });
      return;
    }
    case 'diff': {
      out(engine.diff(requireSession(args[0])));
      return;
    }
    case 'verify': {
      const { head, rest } = splitAtDashes(args);
      const session = requireSession(head[0]);
      const result = engine.verify(session, rest.length ? rest : undefined);
      const reg = loadRegistry();
      reg[session.id] = session; // persist the verify-token so a later `commit` can bind to it
      saveRegistry(reg);
      out(result);
      return;
    }
    case 'commit': {
      const [id, ...msg] = args;
      out({ ok: true, ...engine.commit(requireSession(id), msg.join(' ') || 'dev-session change') });
      return;
    }
    case 'teardown': {
      const [id] = args;
      const session = requireSession(id);
      engine.teardown(session, { keepBranch: args.includes('--keep-branch') });
      const reg = loadRegistry();
      delete reg[id];
      saveRegistry(reg);
      out({ ok: true, torndown: id });
      return;
    }
    case 'list': {
      out(Object.values(loadRegistry()).map((s) => ({ id: s.id, branch: s.branch, worktreePath: s.worktreePath })));
      return;
    }
    default:
      process.stdout.write('Usage: dev-session <create|apply|agent-edit|diff|verify|commit|teardown|list>\n');
      process.exitCode = command ? 1 : 0;
  }
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
