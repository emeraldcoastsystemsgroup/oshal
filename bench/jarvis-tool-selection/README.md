# bench/jarvis-tool-selection — is a narrower tool block, or a wider fast lane, safe?

Jarvis answers a turn one of two ways. Either `detectProviderBoundHandoff` recognises the message
and the turn is answered deterministically with no model tokens at all, or it does not — and then
the whole tool block rides the turn. Two changes suggest themselves, and **they fail in opposite
directions, so they cannot share a gate**:

- **Cutting the tool block** fails by dropping a tool the model needed. It is judged on **recall**.
- **Widening the fast lane** fails by firing the wrong deterministic handler with the model bypassed
  entirely. It is judged on **false matches**, and that failure is worse than the status quo.

This harness races candidate selectors against the shipped one and reports both axes plus the real
token delta, so the question stops being argued and starts being measured. It is the same
no-fabrication discipline as [`../README.md`](../README.md): a leg that cannot run says `not-run`
and why, instead of inventing a number.

## Zero core delta, by construction

`buildToolsBlock` and `detectProviderBoundHandoff` are exported, so the harness imports them
**read-only** and every byte it counts is a byte the `/ask` route would really have sent — off the
real `jarvis-tools.yaml` and the real mounted `scripts/` directory. The candidates live entirely in
`selectors.ts`. Core imports nothing from here, so racing a candidate cannot change what production
does. That also means this harness on its own changes nothing: **a candidate that earns adoption
still has to reach core behind a shadow step** that computes both selectors, logs the delta and
uses the baseline, so real traffic validates it before it decides anything.

## The gate is binary

`regressions` counts only items the **baseline answered correctly and the candidate did not**. The
gate is `regressions == 0`. A candidate that trims twenty turns and breaks one is rejected, because
the average is not what the user experiences — the one broken turn is. A candidate is never charged
for a fault it inherited from the baseline.

## First measured result (2026-09-15, 34 items, n=1)

`tokens` are real BPE counts from `gpt-tokenizer@4.0.0`; Δ is against the baseline over the whole
corpus. Baseline totals: **167,484 bytes / 40,324 tokens across 34 turns — about 1,186 tokens of
tool block per model turn.**

| candidate | recall | false matches | Δ bytes | Δ tokens | regressions | verdict |
|---|--:|--:|--:|--:|--:|:--|
| baseline (shipped) | 100% | 0 | 0 | 0 | 0 | neutral |
| top-3 | 86% | 0 | −127,387 | −31,294 | 3 | **reject** |
| top-6 | 86% | 0 | −105,980 | −26,210 | 3 | **reject** |
| scored-floor-3 | 86% | 0 | −127,187 | −31,247 | 3 | **reject** |
| fast-lane-calendar | 100% | 1 | −4,926 | −1,186 | 1 | **reject** |

**Read:** every tool cut tried here saves a lot — roughly three quarters of the tool tokens — and
every one of them is rejected, all three on the *same* turns: `tool-jazz`, `tool-spend`,
`tool-balance`. Those are the corpus items deliberately worded so the needed tool's own keywords do
not appear ("put on some jazz", "how much did I spend on groceries" — where `groceries` is another
tool's keyword). The shipped scorer ranks on keyword containment, so on exactly those turns the
needed tool is not near the top, and a cut by rank drops it. That is the finding: **a cut that keys
off the existing keyword score is not adoptable, and a better selector has to beat keyword
containment first.** `top-6` regresses on the same three turns as `top-3`, so the fix is not a
bigger `k`.

`fast-lane-calendar` is the precision control: it widens the shortcut to any message mentioning a
calendar, and the corpus records `What is on my calendar tomorrow?` as model-owned. It is rejected
on one false match even though bypassing the model is the largest saving available.

## Honesty / limits (do not over-read this)

- **n = 1, 34 items.** This is a harness with a first data point, not a statistically robust
  benchmark.
- **The corpus is labelled by provenance and the report prints the mix.** 13 items are `contract` —
  verbatim from `tests/unit/jarvis-provider-intent-routing.spec.ts`, so their expected outcome is
  the committed behaviour contract. 21 are `synthetic` — hand-authored, and their `expectedTool` is
  a judgement about what the answer needs, not a recorded invocation. **Synthetic recall is not
  production recall.** Point `JARVIS_BENCH_CORPUS` at a JSONL of real traffic whose ground truth is
  the invocation that actually happened, and the report says `recorded`.
- **The token axis needs a real tokenizer and never estimates.** With no `JARVIS_BENCH_TOKENIZER`
  the Δ-token column is `—` and the report says `not-run` with the reason. Bytes are always exact.
- **The committed `results/latest.json` is the tokenizer-less run** — what a fresh clone reproduces.
  The token figures above came from the `JARVIS_BENCH_TOKENIZER` run below.
- **Nothing here has run against live traffic.** A shadow step in core is what would change that,
  and no candidate has earned one yet.

## Run it

```bash
npm run bench:jarvis-tools                       # bytes only; tokens report not-run
npx tsx bench/jarvis-tool-selection/run.ts --json

# with a real tokenizer (any module exporting encode(text); install it anywhere you like)
npm install --prefix /tmp/tok gpt-tokenizer
JARVIS_BENCH_TOKENIZER=/tmp/tok/node_modules/gpt-tokenizer/esm/main.js npm run bench:jarvis-tools

# against recorded traffic instead of the built-in corpus
JARVIS_BENCH_CORPUS=./real-turns.jsonl npm run bench:jarvis-tools
```

A recorded corpus is JSONL, one object per line:
`{"id":"…","message":"…","surface":null,"expectedIntent":null,"expectedTool":"oshal-spotify.js"}`.
A path that does not exist, or a line that does not parse, **fails the run** — it never silently
falls back to the synthetic corpus.

Exit status is 1 only when the run itself could not happen. A rejected candidate is a result, not a
harness failure, so the run still exits 0 and the table says `reject`.

## Files

- `corpus.ts` — the graded items and their provenance, plus the recorded-corpus loader.
- `selectors.ts` — the read-only baseline over the real selector, and the candidates.
- `measure.ts` — recall, false matches, byte/token deltas, the binary regressions gate.
- `run.ts` — the entrypoint; prints the table and writes `results/latest.json`.
- `../../tests/unit/jarvis-tool-selection-bench.spec.ts` — the guard: proves the baseline is the
  real block byte-for-byte, that the gate rejects a big average saving with one regression, that a
  wrong deterministic fire counts as a false match, and that a missing tokenizer reports `not-run`
  rather than an estimate.
