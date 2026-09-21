# bench — cost/determinism benchmark

A reproducible, **no-fabrication** benchmark that runs the **same task** on the **same free model**
across agent frameworks and records **real** token/round counts. It exists to convert a claim we used
to *assert* — "our review-gated cluster isn't wasteful" — into
something we *measured*. It is the follow-through on the 2026-07-17 adversarial study
([../docs/business/competitive-claims-honest.md](../docs/business/competitive-claims-honest.md)),
whose one un-earned finding was: everyone can run agent clusters; nobody had shown the **bill**.

## The task

A messy invoice → strict JSON, graded by a **deterministic arithmetic gate** (the sum of the line
items must equal the total). The arithmetic is non-trivial (quantity × unit price, plus a percentage
tax on a running subtotal) so a small model slips often enough that a review loop can engage. The
same `check()` grades every framework, so the comparison is of *orchestration cost to reach a passing
answer* — never of grading luck. This is deliberately the "quality gate before advancement" axis the
study contested.

## What it measures (all real, none estimated)

`passed`, `rounds`, `llm_calls`, `input_tokens`, `output_tokens`, `cost_usd`, `wall_ms`, `model` — per
runner, at a stated `n` (`--n`, default 1): every leg runs `n` times, each result keeps its per-run
records under `runs`, the headline numbers are the **median over the runs that ran**, and `passed`
counts passing runs (the table reads `k/n`).

A leg that can't run (missing package, rate-limited, stack unreachable, not configured) reports
`status: not-run` with the reason. A leg that ran on a **different model** than the benchmark model
reports `status: off-model` with its real numbers and the reason, because those numbers are a
measurement and not the comparison this benchmark makes. **It never invents a number** — that would
be the exact sin the study punished.

### The oshal leg is measured from the ledger, not from the answer

`run_oshal` (`runners.py` → `oshal_leg.py`) POSTs the task through the controller's **real
dispatch**: `POST /api/send-message` as a service-secret machine caller bound to a user sub, which is
the one-chokepoint path every interactive turn takes (`executeBotOrInline` → the bot node's
`/api/swarm-execute`, or the inline orchestrator for a controller-hosted concierge). It then reads
the run's spend out of `chat_tasks` — `total_input_tokens`, `total_output_tokens`, `total_cost`,
`total_requests`, and the model ids in `usage_by_model` — inside a `READ ONLY` transaction, under
both ids a run can be recorded as (the thread id, and `<thread>::<agent>` for a bot node). The HTTP
response's usage block is the node's claim about itself; it is carried in the result as
`response_usage` for cross-checking and is never the number. On the live cluster the inline path
answers with `usage` all zero, which is exactly why the ledger is the source.

## Measured result (2026-09-20, `nvidia/nemotron-3-ultra-550b-a55b:free`, n=3 per leg)

The run's own output, verbatim (medians over the 3 runs; `passed` = passing runs / n):

```
runner                      status       n  passed  rounds  llm_calls  input_tokens  output_tokens  wall_ms  model
------------------------------------------------------------------------------------------------------------------
vanilla (no framework)      ran          3     3/3       1          1           284            614     9875  nvidia/nemotron-3-ultra-550b-a55b:free
langgraph (supervisor loop  ran          3     3/3       1          1           284            601    12066  nvidia/nemotron-3-ultra-550b-a55b:free
oshal (live cluster)        ran          3     3/3       1          1          9663            492    46519  nvidia/nemotron-3-ultra-550b-a55b:free
```

The full per-run records are in [`results/latest.json`](results/latest.json).

**Read:** every leg passed first try on every run, so no review loop ever engaged — LangGraph's
supervisor matched the vanilla baseline, and oshal's persona quality gate never had to fire. What the
oshal leg *does* pay for on a one-shot task is the prompt it carries: 9663 input tokens against 284,
the cluster's own prompt assembly around the same user message. What is in those tokens (the persona,
a tool catalog) is not something this run measured; only their count is. On this task the cluster is
not cheaper than a bare call; it is the same single call with a much larger prompt. A review gate is only
as expensive as the failures it has to fix, and a run where nothing fails proves the gate costs
nothing, not that it is worth having — and it cannot show cheaper routing, because there was nothing
to route around.

The `wall_ms` gap is real but not clean latency: the oshal leg's request includes the controller hop
and the caller's hosted-brain resolution before the model call (both run inside the same request);
the other two legs include the `BENCH_MIN_INTERVAL_S` call spacing, and the free tier's own variance
is large (one langgraph run took 148 s, the median 12 s).

## Honesty / limits (do not over-read this)

- **n = 3, one task, one free model.** This is a *harness with a first like-for-like data point*, not
  a statistically robust benchmark. Real conclusions need many tasks and repeated runs — the harness
  is built to do that; the numbers above are three runs each.
- **The benchmark model is a parameter, and free rosters rotate.** The originally pinned
  `openai/gpt-oss-20b:free` returned HTTP 404 from OpenRouter on 2026-09-20 (measured: both the
  vanilla and langgraph legs reported it), so this run set `OPENROUTER_FREE_MODEL` to a `:free` model
  that exists. The oshal leg's model is chosen by the cluster's own hosted-brain ladder for the bench
  user (a non-operator sub, so the platform free lanes apply); when that lane answers on a different
  model the leg says `off-model` rather than pretending parity. A first run before the override did
  exactly that — the cluster answered on the nemotron lane while the benchmark still named the dead
  model — and is the reason the override was set.
- **`wall_ms` is not clean latency** — see above; trust `tokens`, `rounds`, `llm_calls`.
- **The oshal leg's chat_tasks rows are real rows on the cluster it ran against**, attributed to the
  bench user sub, keyed `bench-oshal-<hex>`. They are not curated out of any census.

## Run it

```bash
pip install -r bench/requirements.txt          # requests, langgraph, psycopg2-binary
# OPENROUTER_API_KEY + OPENROUTER_FREE_MODEL are read from the repo .env (a :free model is enforced)
python bench/run.py --runners vanilla,langgraph,oshal --rounds 4 --n 3
```

The oshal leg reads these, from the environment or the repo `.env` (cwd), and names whichever is
missing in its `reason` instead of guessing:

| setting | meaning |
|---|---|
| `SWARM_SERVICE_SECRET` | the machine identity `POST /api/send-message` trusts (required) |
| `OSHAL_BENCH_DSN`, else `OSHAL_COST_CENSUS_DSN`, else `BOOTSTRAP_DATABASE_URL` rewritten to `127.0.0.1:$OSHAL_PG_PORT` | an **owner-capable** DSN for the `chat_tasks` read (required). `chat_tasks` is FORCE row-level security: measured on the live cluster, the app role (`DATABASE_URL`) reads 0 rows and the owner role reads every row, so `DATABASE_URL` is deliberately not a fallback |
| `OSHAL_BENCH_API_URL` | the controller; default `http://127.0.0.1:35457` (the compose default) |
| `OSHAL_BENCH_USER_SUB` | the sub the spend is attributed to; default `bench-oshal-leg`, a synthetic non-operator subject so the operator's own paid-provider exemption never selects the model |
| `OSHAL_BENCH_AGENT_ID` | the target bot; omitted → the controller's default chat agent (an inline concierge), which is what the result above measured. A node-backed bot takes the controller's node branch to that node's `/api/swarm-execute`; on 2026-09-20 the box's `general-bot` answered that dispatch with HTTP 500 (`Failed to process message`) and the leg reported it as `not-run` with that reason — the cause was not diagnosed here |
| `OSHAL_BENCH_AGENTIC` | `true` (default, the product's chat default) or `false` for a single direct call |
| `OSHAL_BENCH_LEDGER_WAIT_S` | how long to keep re-reading the ledger for the node's write (default 20) |

Results are printed and written to `bench/results/latest.json`.

## Guard

`tests/unit/bench-oshal-leg.spec.ts` runs the real `run.py` (real Python, the real `oshal_leg`
module, the real `psycopg2` driver) against a real HTTP seam standing in for `POST /api/send-message`
and a disposable PostgreSQL carrying the real `chat_tasks` schema. The seam answers with one set of
token numbers and writes a **different** set into `chat_tasks`, so the row can only match by reading
the ledger's columns; the refusal cases (rejected secret, no ledger row, off-model answer, missing
setting) each assert a reason and no number. Run it alone:

```bash
npx vitest run tests/unit/bench-oshal-leg.spec.ts --no-file-parallelism --reporter=verbose
```

## Files

- `model.py` — the shared OpenRouter free-model client (identical model for every leg; enforces the
  `:free`-only guard; spaces calls and retries on 429 so the multi-call legs survive the free tier).
- `task.py` — the fixed task + the deterministic checker.
- `runners.py` — one function per framework (vanilla / langgraph / oshal), all `(model, rounds)`;
  unavailable legs degrade to `not-run`.
- `oshal_leg.py` — the oshal leg: the real dispatch, the ledger read, the model-parity check.
- `run.py` — the entrypoint: runs the requested legs `n` times each, prints the table, writes the JSON.
