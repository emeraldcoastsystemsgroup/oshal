# Test Lab / build-pipeline backlog

> The feature guide is [../test-lab.md](../test-lab.md).

Open items from the swarm-build-pipeline work (ADR-063). The two root-cause swarm fixes are done and
on `main` (routing-failure timeout; claude-code root write-permission; verifier folder-resolution;
recursive grader). These are the things left to take to a finished state.

## Recommendation — the path to a reliably-green build pipeline

**Framing:** the fixes opened the gates (without them the swarm produced nothing, ever); they did
NOT make output *reliable*. Same golden ticket → judge-95 code, or a lone README, or nothing. So the
remaining work is about **consistency and a deterministic contract**, not more plumbing. Do these in
order; stop when the definition of done (below) is met.

1. **Build a deliverable *contract* into the executor persona (start here — highest ROI, lowest risk).**
   The `code-developer` (and sibling executor) persona should hard-mandate: *write the named file to
   `deliverables/<file>` plus a matching test file, then `ls deliverables/` and confirm the file
   exists before finishing the turn.* The agents currently treat "put it in deliverables" as a
   suggestion. This is a small, reviewable persona/prompt edit — apply it propose-you-approve, then
   re-run the golden set a few times to measure the new hit-rate.

2. **Turn the verifier's "missing deliverable" finding into a bounded retry, not an escalation.**
   `checkWorkspaceDeliverables` already detects "no/insufficient deliverables." Instead of escalating
   the ticket, re-dispatch the SAME unit ONCE with an explicit *"the expected file `<name>` was not
   written — write it now to `deliverables/`"* instruction; escalate only if that second attempt also
   produces nothing. This converts the most common non-deterministic miss into a self-heal.

3. **A/B codex vs. claude-code as the build harness (this also de-risks #1).** Codex writes files
   natively + deterministically as root (no permission-mode workaround). Once codex is authenticated
   (backlog #4), run the golden set on codex executors and compare the pass-rate to claude-code. If
   codex is materially more consistent, route build/implementation units to it. This may be the
   simplest durable fix for the inconsistency.

**Definition of done (so "green" means something):** the build pipeline is done when `g-phone-validator`
passes **≥4 of 5 consecutive nightly runs** recorded in `eval_runs` — NOT a one-off manual screenshot.
Use the Eval Wall success-rate trend as the gate; it is the honest source of truth.

**Do not chase a manual green capture.** It cost hours fighting a stack that was rebuilding every few
minutes. Let the nightly 04:30 run + the Eval Wall record the result on a settled stack.

## 1. Swarm build output is quality-inconsistent (highest priority)
The same golden ticket sometimes produces full code + tests (judge 95) and sometimes only a
`README.md`. The build agents don't reliably honor "write the function to `deliverables/<file>.py`
with tests." This is the real reason a green golden run isn't yet *reproducible* on demand.
- Likely fix: tighten the build persona/prompt to mandate the exact deliverable file + tests, and/or
  add a verification-driven retry (if the expected artifact is absent, re-dispatch with that as the
  explicit instruction). Keep it propose-you-approve.

## 2. Capture one clean golden GREEN on a stable stack
The swarm-level fix is proven (ticket `aa0dce5e` reached `customer_action` with a deliverable;
earlier `eaa5dc20` produced judge-95 real code), but a single clean golden **pass** wasn't captured
because the stack restarted repeatedly during reconfig and builds are slow.
- Action: on a quiet stack, `node scripts/test-lab-nightly.mjs g-phone-validator` and confirm
  `state=pass`. Or just trust the nightly 04:30 run + the Eval Wall trend.

## 3. Email-send: reconnect the other Google accounts
`gmail.send` works only for accounts reconnected after the scope was added — `owner@example.com`
is done; `maintainer@emeraldcoastsystemsgroup.com` and `owner@example.com` are still
read-only. Reconnect them at `/utilities` if send is needed from those logins.

## 4. Authenticate codex as a second build harness (robustness)
**Partly stale — re-baselined 2026-07-19:** the auth half is DONE — codex ChatGPT-OAuth is wired
swarm-wide (the mounted `~/.codex` on the swarm default login; BYOK model per
[building-a-bot](../building-a-bot.md)), and codex is a first-class bot-node harness (`codex-cli`).
What remains from this item is the *build-pipeline* half: A/B the golden set on codex executors vs
claude-code (recommendation #3 above) and route build units to codex if it proves more consistent.
Original framing (historical): build agents were forced to claude-code (`FORCE_LLM_PROVIDER`);
codex — which writes files natively as root — was unauthenticated (`OPENAI_API_KEY` empty).

## 5. Recreate the remaining ~20 non-build bots (auto-resolves)
Only the build-pipeline bots were recreated onto the image with the write fix. Every fix is on `main`,
so the **next full rebuild-from-source bakes them into all bots** — no separate action needed unless
you want them updated before then.

## Deferred features (lower priority, noted earlier)
- **Travel rewards / account-linking** via the ADR-056 data-access broker (the unbuilt half of the
  travel concierge — highest-value, highest-sensitivity, deliberately deferred).
- **Jarvis multi-app chaining** — Jarvis does one action per ask; a multi-step planner would let it run
  coupled commands end-to-end itself (today the Test Lab orchestrates couples).
- **Email the nightly report** — the send endpoint is `requiresAuth`, not service-secret, so the
  host-side nightly runner can't call it; report is committed + on disk for now.
