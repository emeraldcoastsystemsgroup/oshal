/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | File-backed results store for persona regression evals (ai-lab/persona-evals/results/*.json). Chosen over a DB table so the golden gate needs zero migrations and the reports travel with the suites in the repo tree; reads are traversal-guarded and unparseable reports are listed as broken, never dropped.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: report file names gain millisecond precision + a random 4-hex suffix and save writes with the 'wx' no-clobber flag, so two runs of the same persona finishing within the same second can no longer silently overwrite each other's report. REPORT_FILE_RE still accepts the old second-granularity names so existing local reports keep listing.
 */

import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { basename, join, resolve, sep } from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveSuiteDir } from './suite-loader';
import type { PersonaEvalReport } from '../types';

const logger = createChildLogger({ module: 'persona-eval-results-store' });

/**
 * Report file names: <persona>-<UTC compact timestamp>[-<4-hex nonce>].json (persona chars
 * normalised). The timestamp is millisecond-precision and the nonce de-collides concurrent
 * saves; the optional groups keep old second-granularity names (pre-2026-07-15) listable.
 */
const REPORT_FILE_RE = /^[a-z0-9][a-z0-9-]*-\d{8}T\d{6}(?:\d{3})?Z(?:-[a-f0-9]{4})?\.json$/;

/** Strips the timestamp/nonce tail off a report file name, leaving the persona slug. */
const REPORT_TAIL_RE = /-\d{8}T\d{6}(?:\d{3})?Z(?:-[a-f0-9]{4})?\.json$/;

/**
 * @description Summary row for the results listing — enough to render a green-wall style list
 * without loading every full report body.
 */
export interface StoredReportSummary {
  file: string;
  persona: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  lane: string;
  tasks: { total: number; passed: number; failed: number; skipped: number; errored: number };
  /** Set when the stored file no longer parses — a broken report is surfaced, not hidden. */
  error?: string;
}

/**
 * @description File-backed store for persona-eval reports. Reports live next to the suites
 * (`ai-lab/persona-evals/results/`) by default so the gate is fully repo-local: no DB, no
 * migration, and a failing report can be attached to a commit or diffed like any other file.
 */
export class PersonaEvalResultsStore {
  private readonly dir: string;

  /**
   * @description Creates a store rooted at `dir`, `PERSONA_EVAL_RESULTS_DIR`, or the default
   * `<suite dir>/results`. The directory is created eagerly so the first save cannot race.
   * @param dir - Optional explicit results directory.
   */
  constructor(dir?: string) {
    const fromEnv = process.env.PERSONA_EVAL_RESULTS_DIR?.trim();
    this.dir = resolve(dir ?? fromEnv ?? join(resolveSuiteDir(), 'results'));
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /**
   * @description Persists one report as JSON. The file name embeds the persona, a
   * millisecond-precision UTC timestamp (listings sort newest-first lexically), and a random
   * 4-hex nonce; the write uses the 'wx' no-clobber flag and retries with a fresh nonce so two
   * runs of the same persona finishing in the same instant can never overwrite each other.
   * @param report - The finished report.
   * @returns The stored file name (basename).
   */
  async save(report: PersonaEvalReport): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const personaSlug = report.persona.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'persona';
    const body = JSON.stringify(report, null, 2);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = `${personaSlug}-${stamp}-${randomUUID().slice(0, 4)}.json`;
      try {
        await fs.writeFile(join(this.dir, file), body, { encoding: 'utf8', flag: 'wx' });
        logger.info({ file, persona: report.persona, passed: report.passed }, 'Persona eval report saved');
        return file;
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        logger.error({ err, file, persona: report.persona }, 'Persona eval report name collided; retrying with a fresh nonce');
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * @description Lists stored reports (newest first), optionally filtered by persona. Files
   * that no longer parse are returned with an `error` field so a corrupted history is visible.
   * @param persona - Optional persona filter.
   * @param limit - Max rows (default 100).
   * @returns Summary rows.
   */
  async list(persona?: string, limit = 100): Promise<StoredReportSummary[]> {
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => REPORT_FILE_RE.test(f)).sort().reverse();
    } catch (err) {
      logger.error({ err, dir: this.dir }, 'persona-eval results directory is not readable');
      return [];
    }
    const rows: StoredReportSummary[] = [];
    for (const file of files) {
      if (rows.length >= limit) break;
      const row = await this.summarizeFile(file);
      if (persona && row.persona !== persona) continue;
      rows.push(row);
    }
    return rows;
  }

  /**
   * @description Reads one full report by file name. The name is traversal-guarded (basename
   * only, must match the report-file shape, resolved path must stay in the results dir) so the
   * route can pass it through from a URL param safely.
   * @param fileName - The stored report's file name.
   * @returns The report, or null when absent/invalid.
   */
  async read(fileName: string): Promise<PersonaEvalReport | null> {
    const name = basename(fileName);
    if (!REPORT_FILE_RE.test(name)) return null;
    const target = resolve(this.dir, name);
    if (!target.startsWith(resolve(this.dir) + sep)) return null;
    try {
      return JSON.parse(await fs.readFile(target, 'utf8')) as PersonaEvalReport;
    } catch (err) {
      logger.error({ err, fileName: name }, 'persona-eval report read failed');
      return null;
    }
  }

  /** Builds one listing row, marking unparseable files instead of dropping them. */
  private async summarizeFile(file: string): Promise<StoredReportSummary> {
    try {
      const report = JSON.parse(await fs.readFile(join(this.dir, file), 'utf8')) as PersonaEvalReport;
      return {
        file,
        persona: report.persona,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        passed: report.passed,
        lane: report.lane?.provider ?? 'unknown',
        tasks: report.summary?.tasks ?? { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
      };
    } catch (err) {
      logger.error({ err, file }, 'persona-eval report summary parse failed');
      return {
        file,
        persona: file.replace(REPORT_TAIL_RE, ''),
        startedAt: '', finishedAt: '', passed: false, lane: 'unknown',
        tasks: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
