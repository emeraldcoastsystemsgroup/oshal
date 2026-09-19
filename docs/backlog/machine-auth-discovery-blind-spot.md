# The machine-auth discovery scan cannot see two of the helpers routes actually use

**Found 2026-09-19 while diagnosing three failures in `tests/unit/machine-write-identity.spec.ts`
that are red on `origin/main`.** Evidence below is command output, not reading.

## What the guard is for

`machine-write-identity.spec.ts` exists so that *"a new webhook cannot arrive unnoticed"*. It scans
`src/app/routes`, `src/app/connectors/webhooks` and `src/app/extensions/swarm/routes` for markers
that mean **a machine caller is being authenticated**, and requires every such file to be declared
in `tests/helpers/machine-write-inventory.ts` with the tables it writes and the identity it
establishes before the first write.

## The hole

`MACHINE_AUTH_MARKERS` (`tests/unit/machine-write-identity.spec.ts:100-121`) lists `serviceSecretOk`
but **not `serviceSecretOr`**, and does not list `getTrustedServiceUserSub` at all. Both are in
current use:

```
$ grep -rln "serviceSecretOr\b" src/ | wc -l          # 8+ files
$ grep -rln "getTrustedServiceUserSub" src/ | wc -l   # 8+ files
```

So a route that authenticates a machine caller through `serviceSecretOr(...)`, or resolves the
acting service caller with `getTrustedServiceUserSub(req)`, is **invisible to the scan**. It is
never required to be declared, and its identity handling is never asserted.

This is how the failure presents: `artifact-exchange-routes.ts` IS declared in the inventory, still
authenticates a machine caller, and the stale-entry guard nevertheless reports

```
artifact-exchange-core: src/app/routes/artifact-exchange-routes.ts no longer authenticates
a machine caller — remove the entry
```

The entry is correct. The scan is what is wrong, and the instinct that reading suggests — deleting
the entry — would have removed a true record to silence a false alarm.

## How much is currently unseen

Files under the discovery roots using either helper, against what the inventory declares:

```
NOT DECLARED: src/app/extensions/swarm/routes/agent-provider-mount.ts
NOT DECLARED: src/app/routes/connector-liveness.ts
NOT DECLARED: src/app/routes/files-routes.ts
NOT DECLARED: src/app/routes/jarvis-brief-routes.ts
NOT DECLARED: src/app/routes/jarvis-visual-response.ts
NOT DECLARED: src/app/routes/protected-result-access.ts
NOT DECLARED: src/app/routes/tool-routes.ts
NOT DECLARED: src/app/routes/voice-routes.ts
```

Eight of eighteen. Being undeclared is not itself a defect — several of these may write no
owner-scoped table at all, which is a legitimate inventory answer (`kind: 'no-owner-scoped-write'`,
as `artifact-exchange-core` already records). The defect is that **nobody has had to answer the
question**, because the gate never asked.

## Done when

1. **`serviceSecretOr` and `getTrustedServiceUserSub` are markers**, and the stale-entry failure for
   `artifact-exchange-core` clears without touching the inventory entry.
2. **Each of the eight is declared** with its `ownerScopedTables` and its `identity`, derived by
   reading what it writes — not assumed. Any that writes an owner-scoped table must establish an
   accountable identity before the first write, which is the rule the gate already enforces for the
   declared set.
3. **A mutation proves the widened scan bites**: renaming a marker helper at one call site, or
   adding a new route that authenticates a machine caller and declaring nothing, turns the
   discovery case red. Without that, widening the list is just more text.
4. **The marker list stops being hand-maintained where it can be derived.** The rename that opened
   this hole (`serviceSecretOk` → a second helper `serviceSecretOr`, both still in the tree) is the
   recurrence shape: the list names helpers by string, so every new or renamed helper silently
   shrinks the scan's coverage. If the middleware exports can be enumerated instead, enumerate them.

## Two other failures in the same spec, same run, probably unrelated

```
× jarvis-service-callers: the write runs under the declared identity
    the driver produced no owner-scoped write to observe: expected 0 to be greater than 0
× local-auth: the write runs under the declared identity
    the driver produced no owner-scoped write to observe: expected 0 to be greater than 0
```

These are the BEHAVIOUR half: a driver runs the entry point and the spec observes what the
connection actually carried. Producing **zero** writes to observe means the driver no longer
exercises the path, so the assertion is vacuous rather than wrong. Diagnose before fixing — a
driver that silently stopped driving is the same class of problem as a guard that stopped
scanning, and "make it green" is the wrong instinct for both.

## Scope note

Do NOT delete the `artifact-exchange-core` entry to clear the stale-entry failure. It is a true
record of a route that does authenticate a machine caller; removing it would trade a visible red
for an invisible gap.
