# The live-datastore gate and the spec that proves the knob is ignored

**Status:** open, needs one decision. Found 2026-09-20 by running the full suite against merged `main`.
**Red today:** `tests/unit/ci-local-spec-database-default.spec.ts` fails, because the gate it asserts
now reports FAIL.

## What happened

Two changes that were each correct alone became a red gate when both landed.

- The gate (`scripts/ci/check-spec-database-default.sh`) flags any tree file mentioning
  `process.env.OSHAL_PG_PORT`, `OSHAL_TSDB_PORT` or `OSHAL_REDIS_PORT`. It flags the **variable name**,
  not the value, and it does so deliberately: its own change log records that it was written to judge
  the rule rather than to maintain an allowlist.
- `tests/unit/disposable-redis-isolation.spec.ts` mentions `OSHAL_REDIS_PORT` four times — save, set,
  and two restores — because its whole purpose is to prove `DisposableRedis` **ignores** that variable.
  Its negative control sets the variable to the live address and asserts the fixture chose a different
  port anyway.

So the gate is flagging the one file whose reason for existing is the behaviour the gate wants.

## Why the obvious fixes are not obviously right

| Option | Cost | Why it is not free |
|---|---|---|
| Allowlist the spec | minutes | The gate's author explicitly rejected allowlists, and recorded that a helper which *looks* like an exception "is NOT an exception and is not allowlisted — it passes on the rule as written". An allowlist is the first thing that erodes. |
| Refine the rule so a save/set/restore triple is not a "reach" | hours | It has to stay strict enough to catch the original defect: a spec resolving `OSHAL_REDIS_PORT` and writing to the running swarm's scheduler store. A rule that tolerates assignment tolerates that. |
| Change the control to a non-live address | minutes | **Does not work.** The gate matches the variable name, so the value is irrelevant. It would also be a workaround, and this spec's own suite asserts the gate "ALLOWS the legitimate uses, so it does not have to be worked around". |

A fourth option is to leave it red and record why, which is what this entry does until the decision is made.

## One thing worth noting either way

The spec's comment justifies its control value with "6379 is not published on this box". That is a
box-specific assumption. On a machine where 6379 **is** published — a default Redis install — a
regression in `DisposableRedis` would make this spec write to a live Redis rather than fail to connect.
Whichever option is chosen, that assumption should stop being load-bearing.

## Done when

The gate and the spec are both green, by a change that a reader can tell was not a workaround: either
the rule distinguishes a negative control from a reach, or the exception is named, narrow and justified
in the gate's own change log. Proven by a fixture that still goes red for the original defect — a spec
that resolves the knob and writes to the live store.
