/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extract parameterized dynamic UI queries from the activation orchestrator to preserve its code budget.
 */
/** Execute the manifest's existing allowlisted, parameterized dynamic UI lookup. */
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SwarmAppDynamicUi } from '../types';
import { parseSafeWhere } from './swarm-app-manifest-mapping';

const logger = createChildLogger({ module: 'dynamic-ui-query' });
export async function queryDynamicUiRows(pool: Pool, dyn: SwarmAppDynamicUi): Promise<Array<Record<string, unknown>>> {
  const safeSource = /^[a-z_][a-z0-9_]*$/i.test(dyn.source) ? dyn.source : null;
  if (!safeSource) { logger.warn({ source: dyn.source }, 'Rejected dynamic UI source'); return []; }
  const { whereSql, params } = parseSafeWhere(dyn.where);
  if (dyn.where && whereSql === null) { logger.warn({ source: safeSource }, 'Rejected dynamic UI where'); return []; }
  try {
    const { rows } = await pool.query(`SELECT * FROM ${safeSource} ${whereSql ?? ''}`.trim(), params);
    return rows as Array<Record<string, unknown>>;
  } catch (err) { logger.error({ err, source: safeSource }, 'Dynamic UI row query failed'); return []; }
}
