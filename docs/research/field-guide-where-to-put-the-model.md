# Where to Put the Model

**A field guide for teams whose AI works in the demo and fails in production.**

Companion to [Demote, Don't Delete](./position-paper-light-ai.md), which carries the full evidence
and the case against this advice. This guide is the operational summary. Ten minutes.

---

## 1. The failure you're seeing

Your pilot worked. Production doesn't. The team's instinct is that the prompt needs work, or the
model needs upgrading, or you need better retrieval.

It's usually none of those. It's placement.

Here's the shape of it, measured. On τ-bench — a benchmark built specifically to test whether an
agent follows *domain policy* in a customer-service interaction — frontier agents solved under 50%
of tasks on a single attempt. But the number that matters for you is **pass^8**: the probability the
agent solves the same task on all eight independent tries. GPT-4o's retail pass^8 fell **below 25%**
(Yao et al. 2024).

Read that carefully. On tasks it can *sometimes* do, it cannot do them eight times running. Your
demo was a pass^1 event. Your production traffic is pass^k, and your users don't retry.

Two more numbers worth having in your head:

- **TheAgentCompany** put agents in a simulated company with a code host, chat, docs and project
  tracking, and gave them 175 real professional tasks. Best agent: **~30% autonomous completion**
  (Xu et al.).
- **OSWorld**, on open-ended computer tasks: **12.24%** against a 72.36% human baseline (Xie et al.).

This is not a prompt problem. A component that cannot repeat itself cannot carry a correctness
guarantee — so the guarantee has to live somewhere else.

### Why your best people are the ones getting hurt

The 758-consultant BCG field experiment found a **jagged frontier**: inside AI's capability
boundary, consultants completed 12.2% more work, 25.1% faster, ~40% higher quality. **Outside it,
they performed 19 percentage points *worse* than colleagues working without AI** (Dell'Acqua et al.
2023).

Jagged means you can't see the boundary from inside the task. Putting the model on the default path
asks every operator to make that judgment call, continuously, under time pressure.

None of the following is about software — it's medicine and aviation, included because the pattern
is the same and the stakes make it legible. And it lands hardest on your experts. Computer-aided
detection *reduced* the sensitivity of the
**most discriminating** mammography readers on difficult cancers while helping the weaker ones
(Povyakalo et al.). Adenoma detection in standard non-AI colonoscopy fell from 28.4% to 22.4% after
endoscopists began routine AI use (Budzyń et al. 2025). Lisanne Bainbridge named the mechanism in
1983: unused skills decay, so the human is least prepared exactly when the automation hands back
control.

---

## 2. The fix, in one sentence

**Put a deterministic check on the default path. Keep the model on what the check can't decide.**

Not remove the model. *Demote* it.

---

## 3. Why demote and not delete

Because everyone who has actually built this kept the model, and they got better results than the
teams who didn't.

| What they built | Result |
|---|---|
| **Deterministic pre-execution gates** on τ²-bench's airline domain (Reddy et al. 2026) | 29.6% → **42.0%** (+12.4pp), *P* = 0.0012, **replicated** on disjoint seeds (+12.3pp, *P* = 0.0008) |
| **Model demoted** to bounded sub-tasks, never deciding the workflow's path (Qiu et al. 2025) | **35.56%** vs 18.00% baseline, same backbone; constraint violations down **96%** (11 vs 275); two production deployments |
| **Rules first, model only on the residual** the rules reject (Huang et al. 2025) | Hybrid recall a few points above rules alone — though the source frames this as a study of verifier pitfalls, not a case for hybrids |

The Reddy team's own summary is the sentence to put on the wall:

> "Deterministic gates do not guarantee task success, but they can deterministically prevent a known
> class of silent policy-violating writes at the action boundary."

They also published **negative controls** — gates help where tools are policy-permissive and add
little where tools already enforce their own rules. That's a team you can trust.

**When is full deletion safe?** Two documented cases, and they have something in common: Intel made
formal verification the primary validation vehicle for the Core i7 execution cluster and dropped
coverage-driven testing entirely (~20 person-years); CompCert's verified compiler middle end has
never produced a wrong-code error across six CPU-years of random testing. **Both are fixed, discrete
domains where the option space doesn't drift.** An execution cluster. A compiler.

Your claims workflow is not a compiler. Demote.

---

## 4. The move that unlocks everything: manufacture the check

The question teams ask is *"does this decision have a checkable criterion?"* — and they get stuck,
because usually it doesn't.

Wrong question. Ask:

> **"What would I have to constrain about the output for a checkable criterion to exist?"**

This is how DeepSeek-R1 got reliable rule-based verification: *"the model is required to provide the
final answer in a specified format (for example, within a box)"* (Guo et al., *Nature* 2025). The
task didn't arrive checkable. They **made** it checkable by restricting what the model was allowed
to emit.

That turns an unanswerable classification problem into an ordinary design problem. Your engineers
already know how to do design problems.

Practical forms of this:
- Force a schema, then validate it (constrained decoding gives you structural conformance for free)
- Force the model to name which policy rule it's invoking, then check that rule independently
- Force a bounded enum instead of free text wherever a decision is categorical
- Force the model to emit its *inputs to* a decision, and compute the decision yourself

One caution so you don't overclaim: **determinism is not what makes a verifier robust.** In a
separate verifier study (Huang et al.), the strongest *model-based* verifier tested was fooled by
only 0.0–1.1% of reward-hacking attempts across the representative patterns — while other
model-based verifiers in the same study fell for the same attacks at rates up to 35–62%. Robustness
is an implementation property. This licenses "use a robust verifier," not "verifiers must be
deterministic."

---

## 5. Triage: which of your model calls qualify

Run each call against four conditions. All four, or leave it alone.

**(i) Is the option space finite and enumerable — right now?**
Snapshot property, not a domain property. And note the trap: if the domain were stable, you probably
wouldn't have reached for a general model in the first place. A *demoted* call site can notice its
option space has stopped being enumerable. A deleted one can't. That asymmetry is most of the reason
to demote.

**(ii) Does the correctness rule already exist in writing, predating the model?**
Statute, published policy, contract, a rate card, an SLA. **If you'd have to author the rule from
scratch, stop.** That's the expensive case, and Brooks settled it in 1986: *"the hardest part of the
software task is arriving at a complete and consistent specification."* You may look at logs to
learn *which cases arrive* — that's the domain of your predicate. The *criterion* has to come from
somewhere other than the model's behaviour.

**(iii) Can a domain expert ratify the criterion?**
Treat this as your **weakest** condition, not your safest. EvalPlus found 18 defects across **11% of
HumanEval's 164 human-written ground-truth solutions** — ten of them cases where the reference
implementation simply implemented the wrong thing (Liu et al. 2023). By release-date arithmetic
(HumanEval 2021, EvalPlus 2023) those defects had sat roughly two years in the most scrutinised code
benchmark in the field. Experts stated the correctness criterion 164 times and were wrong 11% of the
time. Get a second ratifier.

**(iv) Is the predicate demonstrably non-vacuous?**
This is the condition everyone skips, and it exists because `return true` satisfies the other three
without proving anything. **A green check certifies conformance to the check.** Enumerate your option
space against the predicate and prove it discriminates. (An earlier draft cited a study on generated
verification annotations here; a second check found the source didn't say what was attributed to it,
so it's cut rather than repeated unverified — the point doesn't need a citation to hold.)

**And one variable that isn't a condition: is anything trying to fool the verifier?** Two frontier
labs faced identical conditions and made opposite choices — one built two learned judges, one refuses
neural reward models entirely. Whatever separates them isn't in the checklist. If your predicate sits
where someone benefits from gaming it, budget accordingly.

---

## 6. Where this does not apply

**The predictive layer is never authorable.** Estimating an unobservable — will this borrower
default, is this transaction fraudulent, which ad wins — is irreducibly statistical. No specification
determines it because no specification *contains* it.

What *is* authorable is the procedural layer wrapped around the estimate: thresholds, notices, audit
records, retry semantics, escalation, cost attribution. Credit scoring is the case that forces the
split.

So: **wrap prediction, don't replace it.** If someone on your team is trying to write rules that
replace a fraud model, redirect them to the decision logic *around* the score.

(Scope note: this section is a corollary of condition (ii) — an unobservable estimate has no
pre-existing written correctness rule, so it can never qualify — not something the companion paper
argues from evidence. The boundary is this guide's own extrapolation.)

---

## 7. The four commitments

If you do this, do all four. The first three without the fourth is how you get a rule base nobody
can maintain.

1. **Manufacture adequacy.** Constrain the output until a check exists.
2. **Demote, never delete** — outside fixed discrete domains. Predicate on the default path, model on
   the residual, **differential monitor over live traffic** so drift is visible.
3. **Prove non-vacuity** before trusting a green check.
4. **Ship an expiry review and a re-entry path with every predicate.** Adequacy decays — rule-based
   recall for long-chain-of-thought generators averages ~0.92, "much lower than other weaker models"
   (Huang et al.). Put a date on it and a named owner.

Plus one discipline from Parnas: **every predicate ships an explicit declaration of what it doesn't
cover.**

---

## 8. What could go wrong, honestly

**Your rule base could rot.** DEC's XCON grew from about 250 rules in 1979 to on the order of 2,500
within a decade — a real, expensive, sustained expansion of a rule base nobody fully controlled. (A
more dramatic rule count, an annual-churn figure, and a maintenance-cost estimate circulated in an
earlier draft of this guide and didn't survive a second check against the source; they're cut rather
than repeated unverified.) If your churn looks anything like that, the predicate isn't worth building.

**Two facts cut the other way.** seL4 found re-verification under a *fixed* specification is "roughly
proportional to the size of the change," and that one class of change stops happening entirely after
verification: implementation bug fixes. And across 171 projects, Menzies et al. "found no evidence
for the delayed issue effect" — meaning a wrongly frozen predicate is **cheap to unfreeze**. That's
demotion's main risk, and it appears survivable.

**Don't do this for cost.** Inference for a fixed capability level fell **more than 280-fold in 23
months**. Nothing amortises against that. Do it for examinability: a deterministic predicate admits
exhaustive enumeration, deterministic replay, and diff review by a named human. A sampled generator
admits none of those. In an audited process that's worth real money — but it's a judgement about
examination risk, not a regulatory exemption. (If someone tells you a regulator rewards this: the
2026 revised U.S. bank model-risk guidance puts generative AI *and* theory-free deterministic
software **both** outside its scope, and explicitly obliges no one. There is no regulatory arbitrage
here.)

**The honest state of the evidence.** Wrap-and-retain has replicated, statistically significant
instances. **The full "instrument, specify, replace, delete" cycle has zero documented instances** —
and formal methods, which is the same mechanism, has had four decades, working tools and real
technical wins without achieving routine adoption. The set of decisions that qualify is a minority of
what your team does. This guide is about that minority.

---

## 9. Monday morning

1. Pick your **highest-volume** model call that touches a **write**.
2. Ask what it would take to constrain its output so a check exists.
3. Find the **written rule** it's supposed to be following. If there isn't one, pick a different call.
4. Build the check as a **read-only gate in front of the write**. Log disagreements. Change nothing
   yet.
5. Run it for two weeks. Look at the disagreements — that's your data on whether the predicate is
   adequate.
6. Only then move the gate onto the default path, with the model behind it on the residual.

Step 4 is the whole thing. A read-only gate that only logs is free to build, impossible to break, and
tells you within a fortnight whether the rest is worth doing.

---

*Numbers in this guide are drawn from the sources cited in
[Demote, Don't Delete](./position-paper-light-ai.md), which also prints the strongest case against
this advice without rebuttal and documents a second, independent verification pass against primary
sources (2026-07-31) in its closing notes. That pass found Reddy et al. accurate in every
particular; found Qiu et al.'s core numbers accurate but corrected its cited title and a quotation;
corrected Huang et al.'s title, a quotation, a misattributed verifier statistic, and a recall
figure; pulled a citation (Beg et al.) that turned out not to say what it was cited for; and
verified every remaining figure this guide uses — the benchmark numbers, the BCG and Copilot
studies, the XCON growth figure, the seL4 and Menzies findings, and the 280-fold cost decline —
directly against their primary sources. Read those notes before you build a business case on any of
this.*
