/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial demo data seeder — seeds Little Monsters classes, student, flashcards, assignments when the app boots in DEMO/MOCK_OIDC mode
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 LM carve-out: the entire seed set was Little Monsters data (lm_classes/students/flashcards/assignments), which no longer exists in core. seedDemoData is now a documented no-op preserving the exported API; demo data becomes each installed app package's responsibility (its own migrations/seeds).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { DemoSeedSummary } from '../types';

const logger = createChildLogger({ module: 'demo-data-seeder' });

/**
 * @description Demo-mode seeding hook. Historically this seeded the Little Monsters
 * education tables; LM was carved out to the oshal-applications store (ADR-085), so
 * core no longer owns any demo domain data. Kept as a no-op so the boot path and
 * MOCK_OIDC/DEMO_MODE wiring stay stable — installed app packages own their own demo
 * seeds (via their bundled migrations) going forward.
 *
 * @param _pool - Postgres connection pool (unused in the no-op)
 * @returns a skipped-seed summary
 */
export async function seedDemoData(_pool: Pool): Promise<DemoSeedSummary> {
  logger.info('Demo seeding skipped — core owns no demo domain data (app packages seed their own, ADR-085)');
  return {
    executed: false,
    reason: 'no core demo data — installed app packages own their own seeds (ADR-085)',
    classIds: [],
    studentId: '',
  };
}

/**
 * @description Whether the boot path should invoke the demo seeding hook — true in
 * demo/mock-auth environments. Unchanged by the LM carve-out (the hook itself no-ops).
 * @returns true when DEMO_MODE or MOCK_OIDC is enabled
 */
export function shouldSeedDemoData(): boolean {
  const flag = (v?: string) => ['1', 'true', 'yes'].includes((v || '').toLowerCase());
  return flag(process.env.DEMO_MODE) || flag(process.env.MOCK_OIDC);
}
