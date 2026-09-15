# Operating fluency — refusal as an event, and a concierge on every surface

> **Status:** Partly built — diagnosis measured 2026-09-14 against the trunk. **Stage 2 / P2 is
> DONE** (`tests/unit/access-check-undetermined.spec.ts`, proven red against the original defect);
> every other stage is still proposed. Roadmap stages carry done-when criteria and are intended to
> be taken one at a time.
>
> **Builds on:** [ADR-125](../adr/125-operations-stream-event-to-action-pipeline.md) (alerts got a
> durable memory), [ADR-122](../adr/122-model-is-untrusted-principal.md) (why the gates exist),
> [ADR-157](../adr/157-scheduled-application-services-run-under-an-activated-principal.md)
> (scheduled services and the principal that runs them).

## The question this answers

> *"Every application has its concierge and Jarvis has a ticket system, but we need a more fluent
> operating environment, don't we? This never works — no one is doing what they are supposed to,
> ever. Why?"*

The answer is not negligence and it is not a bug. **Everything refuses, correctly, and silently.**
The operator sees absence and reads it as failure. What is missing is not more enforcement and not
more concierges — it is a place where a refusal lands.

## Diagnosis

Measured against the trunk on 2026-09-14. Each figure is a command over `src/**`, reproducible.

| measurement | value | what it means |
|---|---|---|
| distinct refusal reason codes (`*_required`, `*_denied`, `*_blocked`, `*_unavailable`) | **125** | the system has 125 ways to say no |
| surfaces that aggregate them | **0** | and no place that shows a no |
| `catch { return false \| null \| undefined \| [] \| {} }` blocks | **45** | an internal error is returned as a negative answer |
| of those, inside access checks | **2** | [`jarvis-result-access.ts`](../../src/app/routes/jarvis-result-access.ts), [`protected-result-access.ts`](../../src/app/routes/protected-result-access.ts) — a thrown store error is indistinguishable from "you may not read this" |
| empty catch blocks | **12** | |
| total catch blocks | 2,072 | context: the silent ones are a small minority, and they are concentrated on the paths that decide whether work happens |

### The failure shape, from the record

Commit `8ae6a57b` is the archetype and diagnosed itself precisely:

- An operator question at 00:51:01Z became a ticket.
- `dispatch-manifest-worker` refused it with `authorization_recorded_delegation_required`.
- The refusal was **correct** — the delegation signing key was unset, and a protected dispatch
  without a recorded delegation would be a security defect.
- The ticket sat `escalated` with no answer. The reason reaching the cockpit was a bare code.
- `docker exec … env` reported the key as *set*; it was present-and-empty. As that commit put it:
  **"an unconfigured controller looks healthy right up to the first protected dispatch."**

The same shape recurs across the record: five deterministic service-route schedules refused since
2026-09-10 with `authorization_execution_identity_required` and discovered only by an audit;
Jarvis down for three days behind a bare `catch { return false }` that produced a 404 with nothing
logged; refused chat threads stranding at `chat_tasks.status = 'created'`.

In each case the gate was right. In each case the *no* was thrown away.

### Why this is precisely the ADR-125 problem, one layer up

ADR-125 opened by listing where alert state actually lived — "a request-handler local, gone on
error"; "an in-process counter that reset with the api"; "the evidence behind a grouping: nowhere"
— and concluded that **nothing was replayable** and the endpoint **"answered 200 for work it had
not durably accepted."**

Refusals are in that pre-ADR-125 state today. A refusal is a return value and a log line at best.
It is not a row, it is not replayable, it cannot be counted, tuned, or explained, and the operator
cannot ask "what did the platform decline to do today, and what would unblock it?"

## What "fluent" means

Three properties, in dependency order. Each is a precondition for the next.

1. **Legible** — when work does not happen, the reason is durable, attributable, and readable
   without a `docker exec`. A refusal names what is missing, not just that something is.
2. **Actionable** — the refusal carries its remedy: the setting to set, the principal to activate,
   the grant to make. `8ae6a57b` did this for exactly one code; it is the pattern, not the feature.
3. **Conversational** — a concierge on the surface where the work stalled can read the refusal and
   answer the operator's actual question, which is never "what is the error code" but "why did my
   thing not happen and what do I do."

**Property 3 is the capability the operator asked to expand, and it is inert without 1 and 2.** A
concierge that cannot see refusals can only apologize. That is the current behavior and it is why
adding concierges has not made the environment feel more fluent.

## Pressure points — what is claimed, and what would validate it

The claims below are the load-bearing ones. Each names the proof that exists today and the proof
that would close it. Tier vocabulary follows the competitive-evidence board: **live** means a real
run against real infrastructure; **contract** means a unit or manifest-level assertion.

| # | claim | proof today | what closes it | done-when |
|---|---|---|---|---|
| P1 | A refusal is discoverable without shell access | none — 125 codes, 0 aggregating surfaces | a durable refusal store plus one read surface | a query answers "every refusal in the last 24h, by code, actor, package and target" and the cockpit renders it |
| P2 **DONE** | An access check reports a fault instead of reporting it as a denial | `tests/unit/access-check-undetermined.spec.ts` — 14 cases, proven red against the original `catch { return false; }` | separate "denied" from "could not determine" and report the latter at ERROR; the fail-closed return stays (see Stage 2 for why propagating would break the stream callback) | a store that throws returns the same fail-closed value as a denial AND logs, while a genuine denial stays quiet; both call sites covered |
| P3 | A refusal names its remedy | one code (`authorization_recorded_delegation_required`, `8ae6a57b`) | extend the message contract to every code that is operator-remediable | a guard enumerates operator-remediable codes and fails when one carries no remedy text |
| P4 | Refusals do not strand work | none — observed stranding at `escalated` and at `chat_tasks.status='created'` | a reaper or a terminal state with a reason | a spec drives a refused dispatch end-to-end and asserts the ticket reaches a terminal state carrying the reason |
| P5 | Cheaper per-step routing is real | capture lane built; the cross-framework benchmark does not yet include an oshal leg | wire the oshal leg to a real dispatch and read `chat_tasks` token columns | the benchmark reports oshal alongside the others from measured rows, at stated n |
| P6 | One bot with an embedded gate beats a review pipeline | `$1.30` vs `$4.05` from real cost rows, small n | repeat across more than one workload | a documented n, more than one ticket type, the honest limits kept |
| P7 | The platform is reachable over MCP | **false** — consumer only, no server surface, MCP executors gated to one runtime | either build the server surface or retire the claim | the claim appears nowhere until a server surface exists |
| P8 | Every application has a concierge | 5 of 10 kernel manifests declare one; **26 of 61** store packages declare none | a manifest-level requirement plus a coverage gate | the repo-separation style check fails a package that registers a surface and declares no concierge |

**P1 and P4 are the remaining fluency blockers** (P2 is closed). P3 is the multiplier. P7 is a copy correction, not
engineering. P5 and P6 are marketing debts that do not block operation.

## Roadmap

Two tracks that converge. Track A is the substrate; Track B is the capability the operator asked
to expand; the payoff is that B becomes useful only once A exists.

### Stage 1 — A refusal is a row (Track A)

Give refusals what ADR-125 gave alerts. Reuse that pipeline's shape rather than inventing one.

- One durable `refusals` store: code, actor, owning package, target agent or route, prepared
  execution id where one exists, remedy text, timestamp. Owner-scoped under the same RLS contract
  as every other table.
- One choke point that records. Refusals are raised from many places; they should land in one.
- `GET /api/ops/refusals`, auth-gated and caller-scoped.
- **Done when:** the box can answer "what refused in the last 24h and why" from a query, and the
  five known schedule refusals appear in it without anyone running `docker exec`.
- **Guard:** an integration spec that drives a real refusal through the recording path and reads
  it back from the store as the enforcing role — not a mocked store (integration-boundary
  corollary, CLAUDE.md).

### Stage 2 — A denial is not an error (Track A) — DONE

- Split "denied" from "could not determine" in the two access checks, then sweep the remaining
  bare-return catches on decision paths.
- **Corrected while building this stage.** The original prescription here read "a
  could-not-determine logs at ERROR with the stack and surfaces as a 5xx, never as a 403/404."
  Reading the call sites showed the 5xx half is not safe as written:
  `callerCanReadStoredTaskResult` is registered with `streamManager` as the **per-event**
  callback (`stream-routes.ts:95,112`), so throwing lands as an unhandled rejection once per
  streamed event rather than a clean 5xx. `canReadJarvisSession` has six call sites that render
  `false` as an empty list. **The defect was the silence, not the denial** — fail-closed is the
  correct security posture and is preserved unchanged. What was missing is that a thrown
  store/authority error was indistinguishable from a real refusal, with nothing logged.
- **Shipped:** every catch in `jarvis-result-access.ts` and `protected-result-access.ts` keeps its
  fail-closed return and logs at ERROR with the error, its stack and the task being decided.
  Turning a denial into a 5xx is a separate, larger change and is not required to close P2.
- **Done when:** P2's spec is green for both access-check call sites. — `tests/unit/access-check-undetermined.spec.ts`, 14 cases.
- **Guard:** a store that throws. Asserts the pair that matters — the fail-closed return is
  preserved AND the undetermined case is reported while a genuine denial stays quiet. Proven red
  by reinstating the original `catch { return false; }`: 3 cases fail (the "REPORTS it" half)
  while the 11 fail-closed assertions stay green, which is what shows the fix changes reporting
  and not what is allowed.
- **Not touched:** `canReadProtectedResult` in `@/shared/protected-results` has the same catch
  shape, but there a throw from `assertResultAccess` *is* the denial mechanism, so catch-and-deny
  is the intended contract. Distinguishing infrastructure faults from denials there needs a typed
  error on the authority ports — a separate change.

### Stage 3 — A refusal carries its remedy (Track A)

- Enumerate the operator-remediable subset of the 125 codes. Not all are — some are correct hard
  denials with no operator action.
- Each remediable code names what is unset and what to set, in the message, with the setting names
  in one exported constant so the check and the message cannot drift (`8ae6a57b`'s pattern).
- **Done when:** a guard enumerates the remediable set and fails when a member carries no remedy.
- **Note:** this is the cheapest high-leverage stage. It is message work over an existing contract.

### Stage 4 — Concierge coverage becomes a contract (Track B)

- A package that registers a cockpit surface declares a concierge. Today 26 of 61 do not.
- Concierge declaration is manifest-level, validated at load, and checked by the same gate family
  as repo separation.
- Backfill is per-package work in the store repo and does not touch the core.
- **Done when:** the coverage gate is green with no allowlist, and a package that registers a
  surface with no concierge fails to load.
- **Sequencing:** this stage is the one to resist starting first. Without Stages 1–3 it produces
  concierges that can only apologize.

### Stage 5 — The concierge reads the refusal stream (the payoff)

- The surface bridge already tells the assistant which screen the operator is on. Extend the
  surface context to include refusals scoped to that surface's package.
- The operator's real question — "why did my thing not happen" — becomes answerable in place,
  with the remedy from Stage 3.
- **Done when:** a refused dispatch on a package surface is explained by that package's concierge,
  naming the remedy, without the operator leaving the screen.

### Stage 6 — Close the marketing debts (independent)

P5 (wire the oshal benchmark leg), P6 (widen the cost sample), P7 (retire the MCP claim and fix
the MIT/AGPL drift in `WHY_OSHAL.md`). None of these block operation; all of them block a slide.

## What this deliberately does not do

- **It does not weaken a gate.** Every refusal measured here is correct. Nothing in this roadmap
  makes work proceed that is currently declined; Stage 2 narrows a denial to actual denials, which
  is a correctness change in the enforcing direction.
- **It does not add a second orchestration path.** The recording choke point sits beside the
  existing dispatch, as ADR-125's pipeline sits beside the ticket store.
- **It does not backfill concierges before the substrate exists.** Stage 4 before Stage 1 is the
  failure mode this document exists to prevent.
- **It does not propose a core refactor.** Stages 1–3 are additive; Stage 4 is a manifest contract
  plus store-repo work; Stage 5 extends an existing context payload.

## Reproducing the diagnosis

```bash
# 125 refusal reason codes
grep -rohE "'[a-z_]+_(required|denied|refused|forbidden|unavailable|not_allowed|blocked)'" \
  src --include=*.ts | sort -u | wc -l

# 45 silent returns from catch
grep -rnE "catch\s*(\([^)]*\))?\s*\{\s*return (false|null|undefined|\[\]|\{\})" \
  src --include=*.ts | wc -l

# concierge coverage across the store repo
cd ../oshal-applications && for d in */; do
  [ -f "$d/oshal-app.yaml" ] && echo "$(grep -ci 'concierge\|inline' "$d/oshal-app.yaml") $d"
done | sort -rn
```
