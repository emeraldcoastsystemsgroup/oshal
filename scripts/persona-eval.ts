/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persona regression eval CLI (golden-task gate). Runs ai-lab/persona-evals suites through the SAME provider resolution the runtime uses: FORCE_LLM_PROVIDER=noop (or unset) = the free noop lane (structural tier only, semantic skipped-with-notice); any other value builds the real harness via createRuntimeProvider — exactly the lane a bot node would get. Exit 0 = all suites passed, 1 = a suite failed/errored, 2 = usage/config error.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: one suite throwing (load or run) no longer aborts the whole multi-suite run with exit 2 — the error is recorded per-suite, remaining suites still run, and the gate exits 1. Exit 2 stays reserved for usage/config errors (bad flags, lane build failure, zero runnable suites).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona email-summarizer
 *   npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona all --json
 *   FORCE_LLM_PROVIDER=noop npx ts-node -r tsconfig-paths/register scripts/persona-eval.ts --persona career-advisor
 *   (tsx also works: npx tsx scripts/persona-eval.ts --persona all)
 *
 * Flags:
 *   --persona <name|all>   which suite(s) to run (default: all)
 *   --suite-dir <dir>      override ai-lab/persona-evals
 *   --workspace <dir>      workspace root for `artifact-exists` assertions
 *   --json                 print the full report JSON instead of the text summary
 *   --no-save              do not persist the report to the results store
 */

import { createChildLogger } from '@/shared/logger';
import { NoopProvider, type LLMService } from '@/features/llm-provider';
import {
  PersonaEvalResultsStore,
  PersonaEvalRunner,
  listPersonaEvalSuites,
  loadPersonaEvalSuite,
  type PersonaEvalReport,
  type TaskResult,
} from '@/features/persona-evals';

const logger = createChildLogger({ module: 'persona-eval-cli' });

interface CliArgs {
  persona: string;
  suiteDir?: string;
  workspace?: string;
  json: boolean;
  save: boolean;
}

/**
 * @description Parses CLI flags. Unknown flags are a hard usage error (exit 2) — a typo like
 * `--personna` silently running everything would be a confusing gate.
 * @param argv - process.argv.slice(2).
 * @returns Parsed args.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { persona: 'all', json: false, save: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--persona': args.persona = requireValue(argv, ++i, flag); break;
      case '--suite-dir': args.suiteDir = requireValue(argv, ++i, flag); break;
      case '--workspace': args.workspace = requireValue(argv, ++i, flag); break;
      case '--json': args.json = true; break;
      case '--no-save': args.save = false; break;
      default:
        throw new Error(`unknown flag '${flag}' (see the usage block at the top of scripts/persona-eval.ts)`);
    }
  }
  return args;
}

/** Reads a flag's value or throws a usage error. */
function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (!v || v.startsWith('--')) throw new Error(`flag '${flag}' requires a value`);
  return v;
}

/**
 * @description Builds the execution lane exactly the way the runtime does: FORCE_LLM_PROVIDER
 * unset or 'noop' = the noop provider (free, structural tier only); anything else goes through
 * createRuntimeProvider — the HARNESS_FACTORIES registry lookup every bot node uses. The
 * provider-runtime module is imported lazily so the common noop path stays light.
 * @returns The lane LLMService plus its resolved name.
 */
async function buildLane(): Promise<{ service: LLMService; laneName: string }> {
  const forced = process.env.FORCE_LLM_PROVIDER?.trim().toLowerCase() ?? '';
  if (!forced || forced === 'noop') {
    return { service: new NoopProvider(), laneName: 'noop' };
  }
  const runtime = await import('@/app/composition/provider-runtime');
  const laneName = runtime.resolveRuntimeProviderName();
  return { service: runtime.createRuntimeProvider(laneName), laneName };
}

/** Renders one task's outcome as indented text lines. */
function renderTask(t: TaskResult): string[] {
  const mark = t.status === 'pass' ? 'PASS' : t.status === 'skipped' ? 'SKIP' : t.status.toUpperCase();
  const lines = [`  [${mark}] ${t.id} — ${t.title} (${t.durationMs}ms)`];
  for (const a of t.assertions) {
    lines.push(`      ${a.status.padEnd(7)} ${a.tier}/${a.type} ${a.id}: ${a.detail}`);
  }
  return lines;
}

/** Renders a full report as human-readable text. */
function renderReport(report: PersonaEvalReport): string {
  const s = report.summary;
  const lines = [
    '',
    `=== ${report.persona} — ${report.passed ? 'PASSED' : 'NOT PASSED'} ===`,
    `lane: ${report.lane.provider} | ${report.lane.laneNotice}`,
    `tasks: ${s.tasks.passed}/${s.tasks.total} passed, ${s.tasks.failed} failed, ${s.tasks.skipped} skipped, ${s.tasks.errored} errored`,
    `assertions: ${s.assertions.passed} passed, ${s.assertions.failed} failed, ${s.assertions.skipped} skipped, ${s.assertions.errored} errored`,
  ];
  for (const t of report.tasks) lines.push(...renderTask(t));
  return lines.join('\n');
}

/**
 * @description CLI entrypoint: resolve the lane, run the requested suites, print per-assertion
 * detail, persist reports, and exit with the gate verdict.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { service, laneName } = await buildLane();
  const runner = new PersonaEvalRunner({ executionService: service, workspaceDir: args.workspace });
  const store = args.save ? new PersonaEvalResultsStore() : null;

  const available = listPersonaEvalSuites(args.suiteDir);
  const broken = available.filter((s) => s.error);
  for (const b of broken) {
    process.stderr.write(`SUITE LOAD ERROR ${b.file}: ${b.error}\n`);
  }
  const personas = args.persona === 'all'
    ? available.filter((s) => !s.error).map((s) => s.persona)
    : [args.persona];
  if (personas.length === 0) throw new Error(`no runnable suites found in ${args.suiteDir ?? 'ai-lab/persona-evals'}`);

  logger.info({ personas, laneName }, 'persona-eval CLI starting');
  const reports: PersonaEvalReport[] = [];
  const suiteErrors: Array<{ persona: string; error: string }> = [];
  for (const persona of personas) {
    // A throwing suite (load or run) fails THAT suite, never the whole gate run — with
    // --persona all, the remaining suites must still execute and report.
    try {
      const suite = loadPersonaEvalSuite(persona, args.suiteDir);
      const report = await runner.runSuite(suite);
      reports.push(report);
      if (store) {
        const file = await store.save(report);
        process.stderr.write(`report saved: ${file}\n`);
      }
      process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`);
    } catch (err) {
      logger.error({ err, persona }, 'persona-eval suite errored');
      const message = err instanceof Error ? err.message : String(err);
      suiteErrors.push({ persona, error: message });
      process.stderr.write(`SUITE ERROR ${persona}: ${message}\n`);
    }
  }

  const failed = reports.filter((r) => !r.passed);
  const total = reports.length + suiteErrors.length;
  process.stdout.write(`\n${reports.length - failed.length}/${total} suite(s) passed on lane '${laneName}'.\n`);
  if (suiteErrors.length > 0) process.stdout.write(`${suiteErrors.length} suite(s) errored: ${suiteErrors.map((e) => e.persona).join(', ')}.\n`);
  if (broken.length > 0) process.stdout.write(`${broken.length} suite file(s) failed to load — fix them; a broken suite is a broken gate.\n`);
  process.exitCode = failed.length > 0 || broken.length > 0 || suiteErrors.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'persona-eval CLI failed');
  process.stderr.write(`persona-eval: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
