/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Register one explicit-only Test Lab card per automated live-acceptance case (scripts/lib/live-acceptance-cases.js): shared response renderer + Tutor, congressional disclosures + watchlist Add, developer workspace index in and out of dev mode, the ADR-160 Floater budget, the LinkedIn queue to a reviewed draft (never published), the commerce surfaces through the confirm gate (host runner only), the Little Monsters class-material hand-off and the Jarvis prompt-cache measurement (host runner only). Each writes only tagged synthetic fixtures and removes them, or spends a real model turn, so none runs from "Run live scenarios". Guard: tests/unit/test-lab-live-acceptance-registration.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The trading-parity card description: the parity readback card, the plan route and the two unconfirmed promotion paths, read-only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The dev-workspace card description: four cited asks (ADR, BACKLOG entry title, runbook, local-notes handover) in dev mode, all four refused outside it, the unauthenticated query refused, and the two named preconditions (a handover probe, an index built with --notes-dir).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The dev-workspace card's handover ask is host-runner-only. The description used to send the operator to the api's environment for OSHAL_VERIFY_DEV_NOTES_PROBE, and compose forwards no OSHAL_VERIFY_* variable to the api, so that step could never work. It now names the host command that supplies the words and says the card reports that step as a gap, before any model turn, and never passes.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The vids-publish card description: the job list and a confirmed publish refused 401 by the /api/vids mount's own sign-in gate, the owner's reviewed publish serving exactly the uploaded MP4 anonymously, 404 for a malformed token and after revoke, and the tagged job, export, publication and MP4 removed.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | The token-chase-replay card description: a file-tools-only captured run reproduced on its bot node through the real tail-replay route (or one tagged run started, replayed and removed), a live-read run stopped at the calling frame and non-replayable from the consuming frame, each missing precondition a named gap, and the store-bound requirement host-runner-only (--expect-store-bound).
 */
import type { Scenario } from './test-lab-scenarios';
import { LIVE_ACCEPTANCE_APP, LIVE_ACCEPTANCE_CASES, runLiveAcceptanceCase } from './test-lab-live-acceptance';

/** What each card does, by case key, in the words the Lab shows. */
const DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'response-renderer': 'Runs the Shared response renderer card, fetches the vendored Mermaid runtime from this origin (no redirect, exact version, JavaScript entry), and runs the installed Little Monsters Tutor renderer suite, which must execute tests rather than decline. Writes only the Lab run-history row.',
  congress: 'Runs the congressional disclosures readback, requires GET /api/trading/reports/congress to list dated rows (a ReportDate day and observed_at on every row), then adds a synthetic ZZT-XXXXX ticker to your watchlist the way the Add button does and deletes it again.',
  'dev-workspace': 'The full case runs on the host: OSHAL_VERIFY_DEV_NOTES_PROBE="<words from the handover for tonight>" node scripts/operations/live-acceptance.js dev-workspace. It turns your dev mode on, requires an unauthenticated GET of the index query route to answer 401 or 403, opens one tagged Jarvis conversation (one real model turn; package-tool proposals must belong to a conversation you own) and asks the Jarvis package tool four things in it: ADR-077 by number, a docs/BACKLOG.md entry title, a runbook, and the handover for tonight from the local notes the index was built with. Each must return a cited doc_id of its path family (docs/adr/077-*, docs/BACKLOG.md, docs/runbooks/*, local-notes/*). Then it turns dev mode off, requires all four asks refused, leaves dev mode as it found it and removes the conversation. The handover words exist only in the environment of the host runner, and compose forwards no OSHAL_VERIFY_* variable to the api, so this card has no source for them. From the Lab it reads the deployment gate and the index sources, puts dev mode back, and reports the handover ask as a host-runner step before any model turn. It never passes. It also names an index that holds no local-notes documents (build it with --notes-dir) and a closed deployment gate (package, flags, super-admin, index); a closed gate needs an api restart.',
  floater: 'Seeds the ADR-160 Floater through the installed aero-lab and requires evaluation 1 to show the mass budget RED at +274.3 g and the fabricable sentence verbatim. If you already have a Floater it is only read; one the card seeded is deleted and proven gone.',
  linkedin: 'Files one tagged synthetic LinkedIn content ticket, waits for the social-writer to produce a graded pending-approval draft that names the ticket and carries its citation, and requires publish-without-confirmation to be refused 428. It never approves or publishes; the draft is rejected and deleted and the ticket removed. Spends real model turns.',
  commerce: 'Drives the installed Rides, Eats and Shopping surfaces at 390 px in headless Chromium up to the confirm card and cancels it, counting any hand-off POST or window.open. Needs the host runner (Chromium); from the Lab it reports that gap without touching anything.',
  'lm-class-material': 'Creates a tagged synthetic Little Monsters class, sends one generated PDF to it through a Send-to handle and the class-material import, requires 201 approved and the material listed in the class, then deletes the material and the class.',
  'trading-parity': 'Runs the trading paper-to-live parity card (gap filter, exit plans, yield sleeve: each must be armed on the paper book), reads the trading package plan route for the paper book, and sends both promotion paths (plan amend, parity mix edit) a change WITHOUT confirm, requiring 428 from each. Read-only: nothing it sends carries confirm.',
  'vids-publish': 'Creates one tagged finished Vids job for you and attaches a real one-frame MP4 carrying the run tag. An unauthenticated GET /api/vids/jobs and an unauthenticated confirmed publish of that job must each be refused 401 by the sign-in gate of the /api/vids mount itself, and nothing may become public. Your confirmed publish with the reviewed digest must yield a link whose anonymous read returns exactly the uploaded bytes as video/mp4; a malformed token answers 404, and after you revoke the link answers 404. It then removes the export through the Vids DELETE route, checks its MP4 is gone from disk, deletes the tagged job and reads the residue back as zero. Needs vids 1.5.0 or later.',
  'jarvis-cache': 'Opens three fresh Jarvis conversations and reads the Jarvis bot call log for the invariant-preamble cache state (created, then hit with cached tokens) and token counts. Needs the host runner (docker logs); from the Lab it reports that gap before any model turn.',
  'token-chase-replay': 'Replays captured Token Chase runs on the bot nodes that produced them through POST /api/token-chase/runs/<id>/tail-replay. The newest captured run of yours whose frames consumed only workspace file-tool results (with a completed final checkpoint), replayed from its first frame, must come back reproduced: artifacts reproduced, no differing path, replayTreeSha equal to the final checkpoint\'s treeSha read through GET /api/token-chase/runs/<id>/final, and no paid call. When no such run exists it starts one tagged file-tools turn on general-bot through POST /api/tasks/<tag>/messages (one model turn), waits for its capture, replays it and removes it (chat task and messages, ask workspace, residue read as zero). A separate captured run whose tail consumed a live-read or side-effect result must, from its first frame, stop at the frame that called the tool with status live-tool after reproducing every earlier frame, and from the consuming frame answer non-replayable. A leg with no suitable run is a gap naming what produces one (capture on a bot node, a bot that answers with its file tools, a conversation that reads live data), never a pass; a producing bot with no reachable node is a gap naming the bot. The store-bound requirement is host-runner-only: node scripts/operations/live-acceptance.js token-chase-replay --expect-store-bound also requires a store-bound run and storeVersion bound and reproduced (TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on on one bot).',
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
