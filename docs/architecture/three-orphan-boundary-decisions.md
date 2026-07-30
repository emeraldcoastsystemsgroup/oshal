# Three orphan-boundary decisions — evidence and options

**Status:** awaiting an operator decision. Nothing here is a to-do for a bot; each item is a
boundary call with a real trade-off, which is why the 2026-07-29 orphan sweep (PR #26) deliberately
left the code in place rather than guess.

All three surfaced from the same audit and share one shape: **code that nothing in this repo imports,
but which is not safely deletable for a reason outside this repo.** That is exactly the class where
"delete it, it's dead" is wrong and "leave it, someone might need it" is also wrong. Each needs a
yes/no.

Evidence below was re-verified against `main` on 2026-07-29. Reproduce any line with the command
shown.

---

## 1. `world-data` reaches the graph tier without being a kernel skill

**The situation.** `src/features/world-data/world-intelligence-service.ts:24` imports
`@/features/graph` and calls `getTenantGraph`. The `world` store package reaches the graph
*transitively* through it. But `world-data` is **not** one of the registered kernel skills:

```bash
grep -oE "id: '[a-z-]+'" src/shared/kernel-skills/registry.ts
# voice notifications rag storage deck-generation graph scheduling memory
# tool-registry media-generation payments spatial-mapping     <- no world-data
grep -c "world-data" src/shared/kernel-skills/registry.ts src/app/composition/kernel-skills.ts
# 0 and 0
```

It survives in `dist/` only because six app-layer files happen to import it:

```bash
grep -rln "@/features/world-data" src/
# src/app/routes/jarvis-brief-sections.ts
# src/app/trading-{assess,research,schedule}-dispatch.ts
# src/app/trading-strategy-lab-sim.ts  src/app/trading-world-masses.ts
```

**Why that is load-bearing.** `src/app/composition/kernel-skills.ts` is the ADR-090 build anchor —
the file that *pins* a slice into the compiled output so installed store packages can deep-import it
at mount time. A slice reached only by incidental app-layer imports is one refactor away from being
pruned out of `dist`, and the failure mode is not a compile error here: it is a **store package
failing to mount on a customer box**. `docs/apps/kernel-skills.md` documents this as the
silent-prune class, and `scripts/ci-local.sh` cites `google-calendar` (item 2 below) as the original
victim.

Note this is *not* fixed by the `uses:` declaration guard added in PR #25. That guard checks a
manifest declares the kernel skills its compiled JS imports — and `world-data` is not a kernel skill
id, so there is nothing for a manifest to declare. The dependency stays invisible to the registry
either way.

| Option | Gain | Lose | Cost to reverse |
|---|---|---|---|
| **A. Promote `world-data` to a kernel skill** (registry entry + `export * as worldData` in the build anchor + `uses: world-data` in `world`'s manifest) | The dependency becomes declared, pinned and visible to the guard; the store package's reach is contractual instead of accidental | Widens the kernel's public API surface — a 13th skill the platform must keep stable for third parties | Low. Removing a skill id later is a one-line revert plus a manifest edit, as long as no third-party package has adopted it |
| **B. Move the slice into the `world` package** | Kernel stays at 12 skills; the code lives with its only real consumer | The six `src/app/` importers above would each need rework — this is the expensive option, and `world-data` is clearly serving kernel-side callers (Jarvis briefs, trading dispatch), not just `world` | High. Once split and diverged, re-merging is a manual reconciliation |

**Recommendation: A.** The six kernel-side importers are the deciding fact — a slice that Jarvis
briefs and four trading dispatchers depend on is kernel capability in practice, and B would mean
either duplicating it or rewiring all six. A costs one registry entry and one build-anchor line, and
converts an invisible dependency into a declared one.

---

## 2. `src/features/google-calendar/` — delete, or re-pin as a kernel skill

**The situation.** Zero importers in this repo:

```bash
grep -rln "features/google-calendar" src/     # (no output)
```

But `little-monsters` in the store repo carries its **own vendored copy**:

```
C:/Projects/oshal-applications/little-monsters/src-routes/google-calendar-service.ts
C:/Projects/oshal-applications/little-monsters/routes/google-calendar-service.js
```

So the kernel slice is unreferenced *because a package forked it* — and `scripts/ci-local.sh` names
`google-calendar` as the original silent-prune casualty, which is plausibly why the fork exists at
all. Deleting the kernel copy therefore breaks nothing today.

| Option | Gain | Lose | Cost to reverse |
|---|---|---|---|
| **A. Delete the kernel slice** | ~184 lines of genuinely unreferenced code gone; one less thing that looks live and isn't | Any future package wanting calendar reads starts by copying `little-monsters`' fork — the divergence compounds, and a calendar bugfix has to be applied in N places | Low — it is recoverable from git history, though the next consumer will not know to look |
| **B. Re-pin as a kernel skill** (`calendar` id + build-anchor entry), then have `little-monsters` drop its fork and declare `uses: calendar` | One canonical calendar implementation; the fork's maintenance burden disappears; the pattern for the next package is correct | Work in two repos, and it commits the kernel to a calendar API surface. Also needs a check that the fork has not diverged in ways `little-monsters` depends on | Moderate — un-picking a skill after a package adopts it means re-vendoring |
| **C. Leave it** | Nothing | An unreferenced slice keeps reading as live capability; the next audit re-litigates it | — |

**Recommendation: A, unless a second calendar consumer is expected soon.** B is the architecturally
correct answer but only pays for itself with two or more consumers, and the fork already works. C is
the one option with no upside — the whole point of the audit was to stop carrying ambiguous code.

---

## 3. `src/agent/` + `src/swarm/` — the last artifacts of an abandoned plan

**The situation.** Both directories contain exactly one file, `index.ts`, and **nothing imports
either**:

```bash
ls src/agent/ src/swarm/                                    # index.ts, index.ts
grep -rn "from '@/agent\|from '@/swarm" src/ tests/ scripts/    # (no output)
```

Two earlier greps appeared to show importers; both were false positives matching
`'../swarm-bot-registry'` inside `src/app/extensions/swarm/routes/` — a different directory
entirely. Worth stating because it is an easy mistake to repeat.

They are not inert scaffolding, though — they have infrastructure attached:

```bash
grep -nE '"@/(agent|swarm)/' tsconfig.server.json   # both path aliases declared
grep -n "src/agent\|src/swarm" docker-compose.hotswap.yml   # both bind-mounted
```

`src/agent/index.ts` is a "convention layer" barrel from Phase 1 of
`docs/adr/swarm-agent-code-separation-plan.md` — it moved no files and only re-exports from
`src/features/`, establishing an import boundary that was never enforced. Phase 1 shipped; Phases 2+
never ran.

**The consequence worth knowing:** `src/agent/index.ts:44` does
`export * from '@/features/tool-loader/index.js'`, and that is the **only** reason
`src/features/tool-loader/` still exists. That barrel's every export is commented out under
"Implementation coming in Phase 5" — a Phase that belongs to the same abandoned plan. So this is a
two-file decision that unblocks a third.

| Option | Gain | Lose | Cost to reverse |
|---|---|---|---|
| **A. Delete both, plus `tool-loader`, and mark the plan abandoned in its own doc** | Three inert modules gone, two stale tsconfig aliases and two stale compose mounts removed; the import boundary stops being advertised-but-unenforced | Formally closes the agent/swarm code-separation idea. If that separation is still wanted, it restarts from scratch — though Phase 1 moved no files, so there is very little to lose | Low. Phase 1 was a barrel of re-exports; recreating it is an afternoon |
| **B. Finish the plan** (Phases 2+: actually move agent-worker code behind the boundary and enforce it with a lint rule) | A real, enforced runtime boundary between the agent worker and the swarm controller — genuinely valuable, and adjacent to the "one canonical AnyBot node runtime" item already on the roadmap | A large reviewed refactor across `src/features/`, on a codebase with live parallel agents. High risk, and it competes with the roadmap item it overlaps | — |
| **C. Leave them** | Nothing | Two barrels keep implying a boundary that does not exist, and they hold `tool-loader` alive as a decoy | — |

**Recommendation: A now, B never as a standalone.** The boundary B would build is worth having, but
it is the same boundary the roadmap's "AnyBot unified node-runtime" item describes — it should be
done *there*, once, as an ADR-level piece of work, not by resurrecting a 2026-era plan whose Phase 1
artifact is three barrels of re-exports. Deleting them costs nothing real and stops the decoy.

---

## If all three recommendations are accepted

The work is small and mechanical, and splits cleanly into two PRs:

1. **Kernel-skill promotion** — `world-data` registry entry + build-anchor line + `uses: world-data`
   in the `world` manifest (store repo). Guard: the PR #25 `uses:` checker should then see the
   dependency; confirm it does.
2. **Deletion** — `src/agent/`, `src/swarm/`, `src/features/tool-loader/`,
   `src/features/google-calendar/`, the two `tsconfig.server.json` aliases, the two
   `docker-compose.hotswap.yml` mounts, and an abandonment note on
   `docs/adr/swarm-agent-code-separation-plan.md`. Verify with a full `npx vitest run` plus
   `npm run typecheck` — deletions break things far from themselves.

Both need `node scripts/check-repo-separation.js` and `npx tsx scripts/check-kernel-skills.ts` green,
and item 1 touches the store repo, so it lands as a coordinated pair rather than one commit.
