# The live-datastore gate and the spec that proves the knob is ignored

**Status: RESOLVED 2026-09-20.** Fixed in the spec, not in the gate. No rule was changed and no
allowlist was added. Kept as a record because the way this was first framed was wrong, and the
correction is the useful part.

## What was actually wrong

`scripts/ci/check-spec-database-default.sh` flags any tree file naming `OSHAL_PG_PORT`,
`OSHAL_TSDB_PORT` or `OSHAL_REDIS_PORT`. It matches the variable name rather than the value, and its
change log records that this was deliberate: a rule instead of an allowlist.

`tests/unit/disposable-redis-isolation.spec.ts` named `OSHAL_REDIS_PORT` four times — a read to save
it, a write to set it, and two writes to restore it — because its negative control proves
`DisposableRedis` ignores that variable.

The gate was right and the spec was wrong. **A control proving a variable is ignored has no reason to
resolve that variable.** The save-and-restore was hand-rolled, and the read it required is exactly what
the gate forbids.

## The fix

Two changes to the spec. Neither touches the gate.

1. **`vi.stubEnv` / `vi.unstubAllEnvs` instead of a hand-rolled save and restore.** Vitest restores the
   values itself, so the spec never reads the variables at all. The gate's remaining `process.env`
   matches for that file drop to zero and it passes on the rule as written.
2. **The decoy address is no longer the live default `6379`.** The old comment justified that value with
   "6379 is not published on this box" — a property of this machine, not of the test. On a box running a
   default Redis, a regression in `DisposableRedis` would have quietly connected to a real datastore.
   The decoy is now an unassigned port, so a regression fails to connect and the spec goes red instead
   of writing somewhere real.

## What was wrong with how this was first written up

The original entry presented three options — allowlist the spec, refine the rule, or change the control
value — and called the choice an operator decision because "weakening a security guard is not a wrap-up
decision to take alone."

That framing manufactured a dilemma. The operator said so, and was right. Two of the three options were
about changing the gate, when the gate was behaving correctly; the third was dismissed as ineffective
because the value is not what matches, which was true but missed that the *read* could be removed
entirely. The gate's own failure message already points at the sanctioned path for a spec that
legitimately needs an address. Nothing here needed a decision.

**The lesson worth keeping: when a good guard fires, check whether the guarded code is wrong before
proposing to change the guard.** Presenting the guard's options first makes weakening it look like one
reasonable choice among several.

## Verification

- `bash scripts/ci/check-spec-database-default.sh` — `OK — 1237 test files`.
- `tests/unit/ci-local-spec-database-default.spec.ts` — 21 passed, including the case asserting the gate
  is green on the tree it ships in.
- `tests/unit/disposable-redis-isolation.spec.ts` — 4 passed, so the control still proves what it did.
- eslint clean on the changed spec.
