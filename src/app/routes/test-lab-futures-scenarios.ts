/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register isolated Futures study/review proof without claiming live nightly or provider acceptance.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register source-age and per-window sample guards, including real archive refusal before optimization.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register durable queued-review guards without claiming installed provider or nightly proof.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register real archive and private PostgreSQL forward receipt guards without deployed acceptance claims.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register frozen forward-context/RLS guards and settled-evidence admission without claiming provider acceptance.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Register real archive/worker/transaction/RLS import proofs, distinct from installed-data acceptance.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Register real-source pre-optimizer reuse and invalidation guards.
 */
import type { Scenario } from './test-lab-scenarios';

/** @description Discover the bounded Futures research checks. @returns Local-runner scenarios, not live proof. */
export const FUTURES_RESEARCH_SCENARIOS: Scenario[] = [{
  id: 'futures-research-loop', title: 'Futures research studies and review', group: 'tool',
  description: 'Bounded study workers, evidence fingerprints, caller-owned review/proposal contracts and forced-RLS durable state. Synthetic market data and fixture inference do not establish installed, nightly, prediction or paper-book acceptance.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/futures-research-config.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-research-quality.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-research-reuse.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-research-ledger-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/futures-research-review.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-research-review-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-research-queue-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-prediction-evidence.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-prediction-ledger-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-review-forward-context-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-archive-source.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-archive-import-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/futures-archive-cli.spec.ts' },
    { level: 'unit', path: 'tests/unit/futures-research-test-lab.spec.ts' },
  ],
  steps: [{ id: 'isolated', app: 'intelligent-trades', label: 'Isolated research regression runner', run: async () => ({
    app: 'intelligent-trades', label: 'Isolated research regression runner', state: 'degraded',
    detail: 'No tests ran from this browser step. Run npx vitest run --no-file-parallelism futures-research- futures-prediction- futures-review-forward- futures-archive- from the framework checkout with Docker available. Follow docs/apps/trading/futures-research-loop.md for console acceptance; no live provider or nightly completion is claimed.',
  }) }],
}];
