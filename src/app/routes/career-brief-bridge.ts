/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 (career-hunter carve): the morning brief's career section used to deep-import findNewHits/listStoreUsers from career-digest/career-hunter-routes — impossible once those modules ship in the store package. This bridge resolves the INSTALLED package's compiled module at runtime (same deployed-apps convention the swarm-app loader uses, with the legacy core path as a transition fallback) and degrades to "no career store" when the app isn't installed, so the brief composes its other sections unchanged. Kernel-side deliberately: the morning brief is a framework concern; which apps feed it is not.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'career-brief-bridge' });

/** Structural mirror of the career package's DigestHit — kept here so the kernel
 *  compiles with zero imports from the (possibly absent) package. */
export interface CareerBriefHit {
  id: number;
  title: string;
  company: string;
  fit: number;
  location?: string | null;
  url?: string | null;
  salaryMax?: number | null;
}

interface CareerBriefModule {
  listStoreUsers(): string[];
  findNewHits(userSub: string, sinceIso: string | null): CareerBriefHit[];
}

/** Candidate module locations, most-specific first: the installed store package
 *  (loader convention: <workspace>/deployed-apps/<app>/), then the legacy core
 *  module (pre-carve transition — resolves until the rip lands, never after). */
function candidatePaths(): string[] {
  const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
  return [
    path.join(workspaceRoot, 'deployed-apps', 'career-hunter', 'routes', 'career-hunter-routes.js'),
    path.join(__dirname, 'career-hunter-routes.js'), // compiled core sibling (transition only)
  ];
}

let cached: { mod: CareerBriefModule | null; at: number } | null = null;
const RESOLVE_TTL_MS = 60_000; // re-probe once a minute so a fresh install is picked up without a restart

/**
 * @description Resolves the career package's brief API (listStoreUsers + findNewHits)
 * from the installed package, caching the result briefly. Returns null when the app
 * is not installed — callers treat that as "user has no career store".
 * @returns The resolved module facade, or null when career-hunter is absent.
 */
export function resolveCareerBrief(): CareerBriefModule | null {
  const now = Date.now();
  if (cached && now - cached.at < RESOLVE_TTL_MS) return cached.mod;
  let mod: CareerBriefModule | null = null;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(p) as Partial<CareerBriefModule>;
      if (typeof m.listStoreUsers === 'function' && typeof m.findNewHits === 'function') {
        mod = m as CareerBriefModule;
        break;
      }
      logger.warn({ p }, 'career module found but missing brief exports — skipping');
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, p }, 'career brief module resolution failed at candidate');
    }
  }
  cached = { mod, at: now };
  return mod;
}

/** @description True when the user has a career store in the installed app (false when the app is absent). */
export function briefHasCareerStore(userSub: string): boolean {
  const mod = resolveCareerBrief();
  if (!mod) return false;
  try { return mod.listStoreUsers().includes(userSub); }
  catch (err) { logger.error({ err, stack: (err as Error).stack, userSub }, 'listStoreUsers failed'); return false; }
}

/** @description New high-fit career hits since the cursor, or [] when the app is absent/errors. */
export function briefFindCareerHits(userSub: string, sinceIso: string | null): CareerBriefHit[] {
  const mod = resolveCareerBrief();
  if (!mod) return [];
  try { return mod.findNewHits(userSub, sinceIso); }
  catch (err) { logger.error({ err, stack: (err as Error).stack, userSub }, 'findNewHits failed'); return []; }
}
