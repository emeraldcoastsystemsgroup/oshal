/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — gha-local CLI: take ANY GitHub Actions workflow and run the equivalent pipeline locally. list (workflows+jobs), plan (dry-run: every step + how it maps), run (execute: services, GITHUB_OUTPUT/ENV, if-conditions, artifacts), install (register a WINDOWLESS daily scheduled task via the wscript //B pattern — no console flash — or print a cron line). Secrets ONLY from --secrets-file / local env; NEVER fetched. Built after the GitHub-Actions billing retirement (ADR-090): the cloud pipeline's jobs, runnable for $0 on the operator's machine.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/gha-local.ts <command> [args]
 *
 * Commands:
 *   list [dir]                          workflows + their jobs (default .github/workflows)
 *   plan <workflow.yml> [--job <id>] [--input k=v]...   dry-run: every step and how it maps
 *   run  <workflow.yml> [--job <id>] [--strict] [--secrets-file <f>] [--input k=v]... [--in-tree]
 *        (default runs from a clean `git archive HEAD` export — commit first; a mutating job
 *         must never touch the live shared tree)
 *   install <workflow.yml> --at HH:MM [--task-name <n>]   register a daily windowless task (win32)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseWorkflow } from './lib/gha/parse';
import { buildPlan } from './lib/gha/plan';
import { runPlan } from './lib/gha/run';

const REPO = path.resolve(__dirname, '..');

/** Parses a dotenv-style secrets file (k=v lines; # comments). Never logged. */
function readSecrets(file?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) out.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!file) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Collects repeatable `--input k=v` flags (workflow_dispatch inputs). */
function inputFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--input') continue;
    const m = /^([^=]+)=(.*)$/.exec(argv[i + 1] ?? '');
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function cmdList(dir: string): void {
  const wfDir = dir || path.join(REPO, '.github', 'workflows');
  const files = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (files.length === 0) { process.stdout.write(`no workflows under ${wfDir}\n`); return; }
  for (const f of files) {
    try {
      const wf = parseWorkflow(path.join(wfDir, f));
      process.stdout.write(`${f}  (${wf.name})  triggers: ${wf.triggers.join(', ') || '—'}\n`);
      for (const j of wf.jobs) process.stdout.write(`   - ${j.id}${j.needs.length ? `  needs: ${j.needs.join(', ')}` : ''}\n`);
    } catch (err) {
      process.stdout.write(`${f}  PARSE ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

function cmdPlan(file: string, argv: string[]): void {
  const wf = parseWorkflow(file);
  const plan = buildPlan(wf, { onlyJob: flag(argv, '--job'), secrets: readSecrets(flag(argv, '--secrets-file')), inputs: inputFlags(argv), cwd: REPO });
  process.stdout.write(`Workflow: ${plan.workflow}   (${plan.file})\n`);
  for (const job of plan.jobs) {
    process.stdout.write(`\nJOB ${job.id}${job.needs.length ? `  needs: ${job.needs.join(', ')}` : ''}${job.if ? `  if: ${job.if}` : ''}\n`);
    for (const svc of job.services) process.stdout.write(`  service: ${svc.name} = ${svc.image}  ports: ${svc.ports.join(', ') || '—'}\n`);
    for (const s of job.steps) {
      const head = `  [${s.kind}]`.padEnd(12);
      process.stdout.write(`${head}${s.name}${s.if ? `  (if: ${s.if})` : ''}\n`);
      if (s.cmd) process.stdout.write(`${' '.repeat(12)}$ ${s.cmd.split('\n').join(`\n${' '.repeat(14)}`)}\n`);
      else if (s.kind !== 'run') process.stdout.write(`${' '.repeat(12)}${s.note}\n`);
    }
  }
  const stats = Object.entries(plan.stats).map(([k, v]) => `${k}:${v}`).join('  ');
  process.stdout.write(`\nSummary: ${plan.jobs.length} job(s)   ${stats}\n`);
  if (plan.warnings.length > 0) {
    process.stdout.write(`Warnings (${plan.warnings.length}):\n${[...new Set(plan.warnings)].map((w) => `  - ${w}`).join('\n')}\n`);
  }
}

/** Exports committed HEAD to a clean directory (ci-local's --head pattern) and returns it.
 *  Jobs that mutate the workspace (npm ci deletes node_modules!) must never run in the LIVE
 *  shared tree — a failed npm ci here partially destroyed node_modules on 2026-07-12. */
function exportHead(wfName: string): string {
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'oshal', 'gha-local-export', wfName);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const res = spawnSync('bash', ['-c', `git archive HEAD | tar -x -C '${dir.replace(/\\/g, '/')}'`], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) throw new Error(`git archive HEAD export failed: ${String(res.stderr ?? '').trim().slice(0, 200)}`);
  return dir;
}

function cmdRun(file: string, argv: string[]): void {
  const wf = parseWorkflow(file);
  const secrets = readSecrets(flag(argv, '--secrets-file'));
  // Default: run from a clean HEAD export so a job can never trash the live shared tree.
  const inTree = argv.includes('--in-tree');
  const cwd = inTree ? REPO : exportHead(path.basename(file).replace(/\.ya?ml$/, ''));
  if (inTree) process.stdout.write('WARNING: --in-tree — jobs run in the LIVE working tree; a mutating step (npm ci, builds) can destroy shared state.\n');
  else process.stdout.write(`(running from HEAD export: ${cwd} — commit first for changes to be seen; --in-tree to override)\n`);
  const plan = buildPlan(wf, { onlyJob: flag(argv, '--job'), secrets, inputs: inputFlags(argv), cwd });
  const summary = runPlan(plan, { cwd, secrets, strict: argv.includes('--strict') });
  process.stdout.write('\n=== gha-local summary ===\n');
  for (const j of summary.jobs) {
    process.stdout.write(`  ${j.status.toUpperCase().padEnd(8)} ${j.id}\n`);
    for (const s of j.steps.filter((x) => x.status === 'fail')) process.stdout.write(`           failed: ${s.name}\n`);
  }
  if (summary.warnings.length > 0) {
    process.stdout.write(`  warnings: ${[...new Set(summary.warnings)].length} (run \`plan\` to list)\n`);
  }
  process.exitCode = summary.ok ? 0 : 1;
}

/** Registers a daily windowless scheduled task (win32) or prints the cron line (POSIX). */
function cmdInstall(file: string, argv: string[]): void {
  const at = flag(argv, '--at') || '10:30';
  const wfName = path.basename(file).replace(/\.ya?ml$/, '');
  const taskName = flag(argv, '--task-name') || `OSHAL gha-local ${wfName}`;
  const stateDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'oshal');
  const logFile = path.join(stateDir, `gha-local-${wfName}.log`);

  if (process.platform !== 'win32') {
    const m = at.split(':');
    process.stdout.write(`Add to crontab:\n  ${m[1] ?? 0} ${m[0]} * * * cd ${REPO} && npx ts-node -r tsconfig-paths/register --transpile-only scripts/gha-local.ts run ${file} >> ${logFile} 2>&1\n`);
    return;
  }

  // Windows: the wscript //B pattern — a scheduled task that NEVER flashes a console window
  // (a bare powershell/cmd action still flashes the console host before it hides; root-caused
  // 2026-07-12 when the token-keepalive task's flash was mistaken for a rogue DOS popup).
  fs.mkdirSync(stateDir, { recursive: true });
  const vbsPath = path.join(REPO, 'scripts', `gha-local-${wfName}-hidden.vbs`);
  const bashCmd = `cd '${REPO.replace(/\\/g, '/')}' && npx ts-node -r tsconfig-paths/register --transpile-only scripts/gha-local.ts run '${file.replace(/\\/g, '/')}' >> '${logFile.replace(/\\/g, '/')}' 2>&1`;
  const vbs = [
    `' Windowless launcher for the "${taskName}" scheduled task — generated by gha-local install.`,
    `' wscript Run(..., 0, False) starts it with no window at all (bare powershell/cmd flashes the console host).`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """C:\\Program Files\\Git\\bin\\bash.exe"" -c ""${bashCmd.replace(/"/g, '""')}""", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, 'utf-8');

  const tr = `wscript.exe //B //Nologo "${vbsPath}"`;
  const res = spawnSync('schtasks', ['/create', '/tn', taskName, '/sc', 'daily', '/st', at, '/f', '/tr', tr], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status === 0) {
    process.stdout.write(`Installed: "${taskName}" daily at ${at} (windowless)\n  launcher: ${vbsPath}\n  log:      ${logFile}\n  remove:   schtasks /delete /tn "${taskName}" /f\n`);
  } else {
    process.stdout.write(`schtasks failed (${String(res.stderr ?? '').trim()}).\nRegister manually:\n  schtasks /create /tn "${taskName}" /sc daily /st ${at} /f /tr '${tr}'\n`);
    process.exitCode = 1;
  }
}

function main(): void {
  const [cmd, target, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'list') { cmdList(target); return; }
    if (cmd === 'plan' && target) { cmdPlan(target, rest); return; }
    if (cmd === 'run' && target) { cmdRun(target, rest); return; }
    if (cmd === 'install' && target) { cmdInstall(target, rest); return; }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write([
    'gha-local — run any GitHub Actions workflow locally ($0, no cloud runners)',
    'Usage:',
    '  gha-local list [workflows-dir]',
    '  gha-local plan <workflow.yml> [--job <id>]',
    '  gha-local run  <workflow.yml> [--job <id>] [--strict] [--secrets-file <f>]',
    '  gha-local install <workflow.yml> --at HH:MM [--task-name <n>]',
    '',
  ].join('\n'));
  process.exitCode = cmd ? 1 : 0;
}

main();
