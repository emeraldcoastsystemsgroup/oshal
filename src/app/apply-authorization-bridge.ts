/**
 * Career auto-submit authorization bridge — dynamically resolves the installed Career Hunter
 * package's settings reader. The package owns its table and SQL; the kernel supplies only the
 * already-authenticated, RLS-aware pool and exact request subject. Missing or malformed packages and
 * all reader failures return `unavailable`, which the bulk enqueuer treats as a stable denial.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial fail-closed installed-app bridge. No Career
 *   table name is compiled into the kernel and no environment value can grant submit authorization.
 *
 * @module app/apply-authorization-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'apply-authorization-bridge' });

export type CareerAutoSubmitDecision =
  | { authorized: true; reason: 'enabled' }
  | { authorized: false; reason: 'disabled' | 'unavailable' };

type CareerAutoSubmitReader = (pool: Pool, userSub: string) => Promise<unknown>;

/** Candidate module locations, most-specific first. */
function candidatePaths(): string[] {
  const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
  const paths = [path.join(workspaceRoot, 'deployed-apps', 'career-hunter', 'lib', 'apply-authorization.js')];
  const storeDir = (process.env.OSHAL_STORE_DIR || '').trim();
  if (storeDir) paths.push(path.join(storeDir, 'career-hunter', 'lib', 'apply-authorization.js'));
  return paths;
}

/** @description Resolve the installed package reader without importing app-owned schema into core. */
export function resolveCareerAutoSubmitReader(): CareerAutoSubmitReader | null {
  for (const modulePath of candidatePaths()) {
    try {
      if (!fs.existsSync(modulePath)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(modulePath) as { readAutoSubmitAuthorization?: CareerAutoSubmitReader };
      if (typeof mod.readAutoSubmitAuthorization === 'function') return mod.readAutoSubmitAuthorization;
      logger.warn({ modulePath }, 'Career authorization module is missing its reader export');
    } catch (error) {
      logger.error({ err: error, modulePath }, 'Career authorization module resolution failed');
    }
  }
  return null;
}

/** @description Read one strict package decision; every invalid/unavailable outcome denies. */
export async function readCareerAutoSubmitAuthorization(pool: Pool, userSub: string): Promise<CareerAutoSubmitDecision> {
  const reader = resolveCareerAutoSubmitReader();
  if (!reader) return { authorized: false, reason: 'unavailable' };
  try {
    const raw = await reader(pool, userSub) as Record<string, unknown> | null;
    if (raw?.authorized === true && raw.reason === 'enabled') return { authorized: true, reason: 'enabled' };
    if (raw?.authorized === false && raw.reason === 'disabled') return { authorized: false, reason: 'disabled' };
  } catch (error) {
    logger.error({ err: error }, 'Career auto-submit authorization read failed');
  }
  return { authorized: false, reason: 'unavailable' };
}
