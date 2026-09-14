# Artifact exchange — what is done, and how to continue it

Handover for [ADR-139](../adr/139-artifact-exchange-send-to-registry.md), the swarm-wide
"Send to…" exchange. Written at the close of the session that shipped Amendment D, so the next
person starts from what is true rather than from the ADR's design intent.

The per-application inventory lives in
[artifact-exchange-coverage.md](../apps/artifact-exchange-coverage.md); the five tracked work items
live in [BACKLOG.md](../BACKLOG.md) under `### ADR-139`. This page is the connective tissue: what
shipped, what is half-landed, and the three recurrence risks the rollout exposed that are *not*
artifact-exchange bugs.

## The mechanism, in one pass

Four parts, and nothing else crosses an app boundary:

| Part | Where | What it does |
|---|---|---|
| Registry | `src/shared/artifact-exchange/registry.ts` | apps declare `artifacts:` (`accepts:` / `provides:`) in `oshal-app.yaml`; kernel built-ins register through the *same* interface at boot |
| Handles | `src/shared/artifact-exchange/handles.ts` | short-TTL, owner-bound claim tickets — the only thing that travels |
| Menu | `GET /api/artifacts/actions?type=` | "what can I do with this?", caller-scoped, answered as data |
| Component | `src/pages/cockpit/js/components/send-to.js` | one script + the standard tag; the chip and right-click are injected centrally |

Dispatch is `open` (navigate pre-loaded), `post` (headless + toast), or `overlay` (in-place modal,
**kernel-reserved** — a manifest declaring it fails the load).

**A handle has two kinds and they redeem identically.** A *locator* holds a path and is re-fetched
server-side as the minting caller, so ownership is enforced at mint *and* at use. A *bytes* handle
carries the payload in memory for a source with no byte-serving URL (Amendment D). One helper,
`readArtifactBytes`, serves both — which is why every destination inherited Amendment D without a
line of its own. **Do not write per-destination handling for the two kinds.**

## Done and live

- The spine: registry, handles, menu, `send-to.js`, the cockpit `artifact=` forward.
- The standard UX tag (Amendment C) — declarative `data-artifact-*`, presentation decided centrally.
- The shared package-side redeem (`redeemArtifactViaRelay`), which makes a new destination ~30 lines.
- **Amendment D, mint-with-bytes** (D4c): `POST /api/artifacts/handles/upload`, per-handle and
  per-sub byte caps, authorization ahead of the parser. Live-verified end to end; the task-explorer
  Files tab is the proof surface, and it is the 11th tagged source.
- Twelve destinations, eleven tagged sources. The per-app detail is in the coverage audit.
- Documentation for both audiences: `docs/guides/send-to.md` for users, and the
  "Joining the artifact exchange" section of `BUILDING-EXTENSIONS.md` in the store repo for app
  authors — the `artifacts:` block had shipped with no author documentation at all.

## Half-landed — check this first

Stage 4a (the shared picker that finally *consumes* `provides:`) and a Jarvis artifact-handoff leg
are **written but were not on `main`** at handover. They were last seen on
`feat/store-compatibility-gate` as `src/app/routes/artifact-picker-routes.ts` (`/sources`,
`/storage`) reading the registry through `registeredArtifactActionApps()`.

**Before building either, confirm where they are**, because rebuilding them would be waste:

```bash
git log --oneline --all -- src/app/routes/artifact-picker-routes.ts
git branch -a --contains <the commit>
```

If they are still unmerged, landing them is the highest-value next move: it closes the source
direction, which is the half of the ADR that has been open longest.

## Continuing the rollout

Cheapest first. Each is the standard tag over a URL that already exists and is already
owner-scoped — no endpoint, no auth work:

1. **`storage`** — `res.download(path.join(LOCAL_ROOT, userKey(sub), dir, name), name)`
2. **`aero-lab`** — `res.download(path.join(record.dir, file), file)`
3. **`payroll`** — `Content-Disposition: attachment; filename="W2REPORT-<year>.txt"`

Then four packages whose existing import route could back an `accepts:` block with the ~30-line
redeem adapter: `marketing-engine`, `payroll`, `switchboard`, `video`. One package, `lora`, needs an
ingest route that does not exist yet — that is a package feature, not an exchange gap.

**Roughly half the store has no artifact to exchange, and that absence is correct.** Do not treat
the untagged remainder as a backlog.

**RAG Center stays out.** A retrieved corpus chunk is not a file, so what a handle would even carry
is an open product question. Recorded in D4c so nobody re-attempts it as plumbing.

## Two traps this rollout paid for

- **Never tag a truncated preview.** Where a surface holds only part of a long file, the send is
  withheld deliberately — ingesting half a document into a corpus is a defect nobody sees.
- **Measuring coverage by grep over-counts badly.** A bare
  `res.sendFile|res.download|Content-Disposition` scan reports ~26 packages "serving artifacts";
  almost all are the shared `serveFile(surfaceDir, fileName)` helper returning each package's own
  tool HTML. Filter `sendFile` to arguments that are neither a literal `.html` nor
  `surfaceDir`/`assetRoot` and the real number is three. `type="file"` proves an upload control,
  not a gap.

## Three recurrence risks this rollout exposed

None of these is an artifact-exchange bug. All three were found while diagnosing why a Portrait
Studio render failed, and each will recur on its own schedule. Proposed as backlog items with
done-when criteria; none has been started.

### 1. The codex model default is a hardcoded time bomb

`gpt-5.5` is hardcoded as the fallback default in roughly eight core source files plus
`docker-compose.oshal-local.yml` (about twenty literal per-bot `FORCE_LLM_MODEL:` entries that are
**not** env-substituted), `deploy/helm/oshal/values.yaml`, the terraform example tfvars and
`.env.example`. When a model is retired, a fresh install ships broken and this box needs a
multi-file change rather than one `.env` line.

Substituting today's model name just sets the next bomb. The design question worth answering is
whether an unset `CODEX_MODEL` should fall back to the **codex CLI's own configured model** (the
host `~/.codex/config.toml`) instead of a name compiled into the repo — which is also what
[the no-hardcoded-config rule](../../CLAUDE.md) asks for.

- **Done when:** a fresh install with no `CODEX_MODEL` set starts on a model the account actually
  has, proven on a box whose `config.toml` names something other than the repo default; and
  `tests/unit/codex-default-floor.spec.ts` asserts the resolution order rather than an exact model
  string. Changing the fleet model is a plan/burn decision for the operator, never an agent's.

### 2. A dead model is retried without backoff

During a ~2.5-hour OpenAI-side outage on 2026-09-10, `gpt-5.5` returned
`404 … does not exist or you do not have access to it`. The fleet retried it **49 times in 24 hours**
across three containers (email-bot 36, api 7, general-bot 6) with no backoff and no alert. A
model-level 404 is not a transient network error and will not fix itself inside one task, yet each
task burned its full failover path (`openai-codex` → `cline-cli`, where the fallback can never
succeed because unattended Cline is disabled by design).

- **Done when:** repeated model-level 404s from one provider trip a short circuit that stops
  re-dispatching that model, surfaces one operator-visible alert naming the model, and clears on
  the next success; a unit spec drives the breaker with a stubbed provider returning the exact 404
  shape, and the fallback chain is not entered for a failure the fallback cannot fix.

### 3. Nothing catches a dated-test time bomb

`tests/unit/trading-dated-orders.spec.ts` pinned a fixture to a hardcoded `2026-09-09` while
ticking the clock at `Date.now() + 3 days`. It passed for five days and went red on the date it
named, with no code change behind it — and it reads exactly like a regression in safety-adjacent
trading code. Fixed and recorded as [BUG-24](../operations/bug-log.md); the *class* has no guard.

The tell is mechanical: a hardcoded future date compared against `Date.now()` in the same
assertion. That is greppable.

- **Done when:** a lint or spec flags a literal `YYYY-MM-DD` in a test file that is compared
  against `Date.now()` / `new Date()` without an injected clock, proven red on the exact shape
  BUG-24 describes and green on a spec that passes its clock explicitly.

## State at handover

- Everything listed under **Done and live** is on `origin/main` and verified there **by content**,
  not by commit SHA. That distinction matters here: a history rewrite retired the original merge
  SHAs, so `git merge-base --is-ancestor <sha> origin/main` reports every one of them missing while
  the work is present. Check content — `git show origin/main:<path> | grep <marker>` — before
  concluding anything was lost.
- Stage 4a and the Jarvis leg were unmerged at handover. See **Half-landed** above.
