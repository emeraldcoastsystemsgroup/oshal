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

`passed`, `rounds`, `llm_calls`, `input_tokens`, `output_tokens`, `cost_usd`, `wall_ms` — per runner.
A leg that can't run (missing package, rate-limited, stack unreachable) reports `status: not-run` with
the reason. **It never invents a number** — that would be the exact sin the study punished.

## First measured result (2026-07-17, `openai/gpt-oss-20b:free`, n=1)

| runner | llm_calls | total tokens | passed |
|---|--:|--:|:--:|
| vanilla (no framework) | 1 | 679 | yes |
| langgraph (supervisor loop) | 1 | 679 | yes |
| oshal (live cluster) | — | — | not-run |

**Read:** LangGraph's supervisor loop matched the vanilla baseline exactly, because the model passed
first try and the loop never engaged — an honest point in *both* directions: a review loop is only as
expensive as the failures it has to fix, and a run where nothing fails proves the gate costs nothing,
not that it is worth having.

## Honesty / limits (do not over-read this)

- **n = 1, one task, one free model.** This is a *harness with a first data point*, not a
  statistically robust benchmark. Real conclusions need many tasks and repeated runs — the harness is
  built to do that; the numbers above are one run.
- **`wall_ms` is not clean latency** — free-tier rate limits force call spacing
  (`BENCH_MIN_INTERVAL_S`, default 6s) plus 429 backoff. Trust `tokens`, `rounds`, `llm_calls`; treat
  `wall_ms` as indicative only.
- **The `oshal` leg is not wired yet.** So this measures competitors, not us — the comparison is
  incomplete until the OSHAL leg runs the same task through a live review-gated cluster and reads
  `total_input_tokens` / `total_output_tokens` / `total_cost` from `chat_tasks`. That is the next step.

## Run it

```bash
pip install -r bench/requirements.txt          # requests, langgraph
# OPENROUTER_API_KEY + OPENROUTER_FREE_MODEL are read from the repo .env (a :free model is enforced)
python bench/run.py --runners vanilla,langgraph,oshal --rounds 4
```

Results are printed and written to `bench/results/latest.json`.

## Files

- `model.py` — the shared OpenRouter free-model client (identical model for every leg; enforces the
  `:free`-only guard; spaces calls and retries on 429 so the multi-call legs survive the free tier).
- `task.py` — the fixed task + the deterministic checker.
- `runners.py` — one function per framework (vanilla / langgraph / oshal); unavailable legs
  degrade to `not-run`.
- `run.py` — the entrypoint: runs the requested legs, prints the table, writes the JSON.
