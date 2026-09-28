/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Register one explicit-only Test Lab card per automated live-acceptance case (scripts/lib/live-acceptance-cases.js): shared response renderer + Tutor, congressional disclosures + watchlist Add, developer workspace index in and out of dev mode, the ADR-160 Floater budget, the LinkedIn queue to a reviewed draft (never published), the commerce surfaces through the confirm gate (host runner only), the Little Monsters class-material hand-off and the Jarvis prompt-cache measurement (host runner only). Each writes only tagged synthetic fixtures and removes them, or spends a real model turn, so none runs from "Run live scenarios". Guard: tests/unit/test-lab-live-acceptance-registration.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The trading-parity card description: the parity readback card, the plan route and the two unconfirmed promotion paths, read-only.
 */
import type { Scenario } from './test-lab-scenarios';
import { LIVE_ACCEPTANCE_APP, LIVE_ACCEPTANCE_CASES, runLiveAcceptanceCase } from './test-lab-live-acceptance';

/** What each card does, by case key, in the words the Lab shows. */
const DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'response-renderer': 'Runs the Shared response renderer card, fetches the vendored Mermaid runtime from this origin (no redirect, exact version, JavaScript entry), and runs the installed Little Monsters Tutor renderer suite, which must execute tests rather than decline. Writes only the Lab run-history row.',
  congress: 'Runs the congressional disclosures readback, requires GET /api/trading/reports/congress to list dated rows (a ReportDate day and observed_at on every row), then adds a synthetic ZZT-XXXXX ticker to your watchlist the way the Add button does and deletes it again.',
  'dev-workspace': 'Turns your dev mode on, opens one tagged Jarvis conversation asking about the ADR (one real model turn; package-tool proposals must belong to a conversation you own), asks the Jarvis package tool for that ADR by number in it and requires the cited doc_id of the ADR, turns dev mode off and requires the same ask refused, then leaves dev mode as it found it and removes the conversation. A closed deployment gate (package, flags, super-admin, index) is reported by name; those need an api restart.',
  floater: 'Seeds the ADR-160 Floater through the installed aero-lab and requires evaluation 1 to show the mass budget RED at +274.3 g and the fabricable sentence verbatim. If you already have a Floater it is only read; one the card seeded is deleted and proven gone.',
  linkedin: 'Files one tagged synthetic LinkedIn content ticket, waits for the social-writer to produce a graded pending-approval draft that names the ticket and carries its citation, and requires publish-without-confirmation to be refused 428. It never approves or publishes; the draft is rejected and deleted and the ticket removed. Spends real model turns.',
  commerce: 'Drives the installed Rides, Eats and Shopping surfaces at 390 px in headless Chromium up to the confirm card and cancels it, counting any hand-off POST or window.open. Needs the host runner (Chromium); from the Lab it reports that gap without touching anything.',
  'lm-class-material': 'Creates a tagged synthetic Little Monsters class, sends one generated PDF to it through a Send-to handle and the class-material import, requires 201 approved and the material listed in the class, then deletes the material and the class.',
  'trading-parity': 'Runs the trading paper-to-live parity card (gap filter, exit plans, yield sleeve: each must be armed on the paper book), reads the trading package plan route for the paper book, and sends both promotion paths (plan amend, parity mix edit) a change WITHOUT confirm, requiring 428 from each. Read-only: nothing it sends carries confirm.',
  'jarvis-cache': 'Opens three fresh Jarvis conversations and reads the Jarvis bot call log for the invariant-preamble cache state (created, then hit with cached tokens) and token counts. Needs the host runner (docker logs); from the Lab it reports that gap before any model turn.',
});

/** Cards that belong beside Jarvis in the Lab; the rest sit with the tools. */
const JARVIS_GROUP = new Set(['response-renderer', 'dev-workspace', 'jarvis-cache']);

/**
 * @description One explicit-only Lab card per live-acceptance case, each running the same shared case
 * module the host runner runs. Spread into the Lab's scenario list by test-lab-scenarios.ts.
 */
export const LIVE_ACCEPTANCE_SCENARIOS: Scenario[] = LIVE_ACCEPTANCE_CASES.map((entry): Scenario => {
  const key = entry.module.KEY;
  return {
    id: `live-acceptance-${key}`,
    title: `Live acceptance: ${entry.module.TITLE}`,
    group: JARVIS_GROUP.has(key) ? 'jarvis' : 'tool',
    explicitOnly: true,
    description: `${DESCRIPTIONS[key] ?? entry.module.TITLE} Same case as node scripts/operations/live-acceptance.js ${key}. Backlog: "${entry.backlog}".`,
    regressionTests: [
      { level: 'unit', path: `tests/unit/live-acceptance-${key}.spec.ts` },
      { level: 'unit', path: 'tests/unit/live-acceptance-runner.spec.ts' },
      { level: 'unit', path: 'tests/unit/test-lab-live-acceptance-registration.spec.ts' },
    ],
    steps: [{ id: key, app: LIVE_ACCEPTANCE_APP, label: entry.module.TITLE,
      run: (cookie, _prior, runtime) => runLiveAcceptanceCase(key, cookie, runtime) }],
  };
});
