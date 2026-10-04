# Door authorization — 2026-10-04

This increment makes every door that accepts a ticket's authority-carrying fields check them, gives
`/api/tickets` and the cockpit one ticket read verdict, retires a ticket chat route that bypassed bot
admission, authorizes ticket pins at dispatch, and stops the Windows installer from writing the session
secret of an existing install. It shipped on the shared `fix/guards-measure-again` branch through PRs
#1050–#1054. The same PRs also carried other lanes' fleet-metrics, preferences, overview, project-modal
and queue-health fixes; those are recorded in their own review receipts, not here.

## Behavior changes

| Change | Where | PR | Guard |
|---|---|---|---|
| A non-super-admin filer cannot create a privileged ticket type. A non-operator's `metadata.targetAgentId` pin must pass the direct-call entitlement. A parent the caller cannot read is refused with the missing-ticket 404 and nothing is written. All three are checked on create and on update. | `src/app/routes/ticket-filing-guard.ts` | #1050 | `ticket-filing-integrity.spec.ts` |
| Parent selection uses the same read verdict as `GET /api/tickets/:id`, current protected-result rights included. | `ticket-application-access.ts` (`canReadTicket`) | #1050 | `ticket-filing-protected-parent.spec.ts` |
| `PUT /api/tickets/:id/state` decides access like `/status`. Before this, its bare-task branch had no ownership check. | `ticket-routes.ts` | #1050 | `ticket-state-compat-access.spec.ts` |
| `POST /api/tickets/:id/chat` is retired with `410 legacy_execution_route_retired`. It ran bot turns without execute entitlement, budget, owner attribution or a task ownership check. | `ticket-routes.ts`; [ADR-161](../adr/161-one-bot-invocation-chokepoint.md) amendment | #1050 | `ticket-chat-retired.spec.ts` |
| Global project registry create, rename and archive are operator administration. | `cockpit-project-routes.ts` | #1050 | `cockpit-project-administration-http.spec.ts` |
| The Windows installer mints `SESSION_SECRET` only into a `.env` it created. An existing `.env` is never written for that key, because an empty value there may mean a fallback key already signs sessions. | `installer/lib/install-swarm.ps1` | #1050 | `installer-session-secret.spec.ts` (real PowerShell) |
| One exact-principal ticket verdict for `/api/tickets` and the cockpit: owner or operator, an active verified actor, the recorded owner issuer for a non-operator, and current result rights. | `record-ownership.ts`, `ticket-application-access.ts`, `cockpit-resource-access.ts` | #1051 | `ticket-exact-principal-ownership.spec.ts` |
| A ticket pin is authorized at dispatch against the owner's current direct entitlement. An undecidable check is refused under its own reason, never as an entitlement verdict. | `dispatch-ticket-gates.ts` | #1053 | `pinned-ticket-dispatch-gate.spec.ts` |
| A signed guest reads its own guest-stamped tickets by id and in its list, and nothing else. The ticket LIST uses the full verdict, with one actor lookup per request. | `record-ownership.ts`, `ticket-application-access.ts`, `ticket-routes.ts` | #1054 | `ticket-guest-own-read.spec.ts` |

## Verification

Each guard was run against the change and against the prior source. "Red" counts the cases that fail
on the prior source, which shows the guard tests the change rather than its own fixtures. Fixtures are
isolated: synthetic sessions, in-memory stores and real HTTP through the real routers.

| Guard | With the change | Against the prior source |
|---|---|---|
| `ticket-filing-protected-parent` | 7/7 | 6 red (ownership-only parent check) |
| `installer-session-secret` | 9/9 | 3 red (the earlier installer function rewrote an existing `.env`) |
| `cockpit-project-administration-http` | 4/4 | 2 red |
| `ticket-chat-retired` | 5/5 | 5 red. The old handler accepted one user's message into another user's task with 200. |
| `ticket-state-compat-access` | 5/5 | 3 red |
| `ticket-exact-principal-ownership` | 7/7 (#1051) | 5 red, 2 unchanged positives |
| `pinned-ticket-dispatch-gate` | 10/10; 13 dispatch and provider neighbor files, 124 tests | 4 red |
| guest own-read plus principal LIST (#1054 combined run) | 41/41 initial | 2 red, 11 unchanged positives |

Every push passed the publish gate and the pre-push typecheck of the exported committed HEAD.
`npm run test:remote-authorization` was 505/507 at `15bf7464`. Both failures predated this increment:
two specs still looked for the Token Chase replay route that commit `4b4a7f50` moved out of
`bot-node-server.ts`. Commit `daf78ab8` (#1056) repoints them. This record makes no claim of a
full-suite pass.

## Publication and deployment

| PR | Merged (UTC) | Deployed with |
|---|---|---|
| #1050 | 07:53 | `9f568e13`, standard deployment 08:09 |
| #1051, #1053 | 09:37, 10:02 | `23fa4263`, standard deployment completed 10:30 |
| #1054 | 11:42 | `e1e0d764` (the #1060 merge, which carried it), standard deployment 19:17–19:33, API started 19:24, product probes 19:32 |

After the earlier deployments, the coordinator's live checks on a genuine ordinary session showed the
user's own ticket loading, an operator's ticket refused, and global fleet counts omitted. The coordinator
accepted the `e1e0d764` deployment at 19:40 on its standard, preservation and persistence checks. These
were standard product probes, not acceptance of every user journey. No guest session was used for any of
them.

## Qualifications

- **Guest demo tickets are not stamped in the deployed revision.** At `e1e0d764`,
  `src/app/routes/guest-demo-seed.ts` inserts each guest's demo tickets with raw SQL, without the guest
  issuer, so the guest rule refuses them.
  - By source inference, the guest has been refused them by id since the `23fa4263` deployment, and
    they have been missing from its list since the `e1e0d764` deployment. No guest session has been
    used to observe either.
  - The fix stamps the guest issuer at seeding. It passed independent source review, and passed
    locally: 41 isolated cases in five suites, with lint and whitespace checks. Those cases use a stub
    pool and in-memory stores, so there is no PostgreSQL or guest UI evidence. Deployment and a fresh
    guest-session check remain. Tracked in the backlog.
  - Both compatibility alerts on guest access arrived after their rollouts had started.
- **Personal access tokens without a recorded issuer** are refused by the exact-principal verdict on
  ticket routes, as they already were in the cockpit. This is source inference; no such token was used.
  Tracked in the backlog.
- **Unstamped guest rows stay refused.** A guest reads a row only when the row recorded the guest issuer.
  Unstamped rows are refused, including demo rows seeded before the fix, among them rows of guests whose
  sessions may still be active.

  These rows are not modified: there is no backfill and no exception for the demo marker. A guest with
  unstamped demo rows sees demo tickets again only in a new guest session, started after the fix is
  deployed. Guest sessions last `GUEST_SESSION_TTL_HOURS`, 12 hours by default. This record makes no
  claim about which rows exist on the live box.
- Exact-principal ownership binds the issuer only where a row recorded one. Rows without a recorded
  issuer bind by owner sub.
- The pin gate's guard drives the real dispatcher with in-memory dependencies. A PostgreSQL-backed
  variant has not run.
- `ops/scripts/incident-approval-remediation-loop.sh` still calls the retired chat route and sends no
  credentials. Tracked in the backlog.

## Backlog

This work closes "POST /api/tickets accepts any parentTicketId", now in the closed ledger. Its done-when
holds:
- A non-operator naming an unreadable parent is refused, and nothing is created.
- The owner and an operator can still file a child.
- Specs cover all three callers.

It opens three entries:
- the guest demo seeder (in progress);
- personal access tokens without a recorded issuer;
- the remediation loop.

The same review also recorded:
- the bot LLM budget pre-flight, which never authenticates on the shipped compose;
- the per-leg detail that `/api/readiness` gives anonymous callers;
- a note on the other roles of `SESSION_SECRET`, added to the connector-token key custody entry.
