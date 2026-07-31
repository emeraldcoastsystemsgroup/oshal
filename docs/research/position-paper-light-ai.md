Roger Murphy

[Instructor]

[Course]

29 July 2026

## Demote, Don't Delete: Where Intelligence Belongs in a Working System

### A note on this paper's history

This paper began as a stronger claim than the one it now makes. It argued that a general-model call
in a business process is a debt to be instrumented, specified, replaced with deterministic code, and
**deleted** — and that the reason to discharge the debt was no longer cost but regulatory
attestation. Both halves were wrong, and they were shown to be wrong by a systematic attempt to
refute them.

The regulatory argument was falsified by the primary text of the one instrument it cited. The
deletion argument was falsified by something stronger than absence: three independent research
groups built exactly the artifact this paper prescribed, in the domains this paper had chosen, and
every one of them **kept the model**.

What survives is narrower, better evidenced, and — this is the part that surprised its author — has
replicated effect sizes behind it that the discarded version never had. The architecture is right.
The terminal step was wrong. Section XV prints the case against this paper at full strength, in an
opponent's voice and without rebuttal, because a position that cannot survive its own best
refutation is advocacy rather than argument.

Twelve claims from earlier drafts are withdrawn outright; they are listed in the closing notes so
the revision is auditable rather than silent.

### I. What Is Not in Dispute

The consumer side is settled. Bick, Blandin, and Deming conducted the first nationally
representative U.S. survey of generative-AI use and found that as of August 2024, 39.4 percent of
Americans aged eighteen to sixty-four reported using generative AI, 28 percent of employed
respondents used it at work, and close to one in nine workers used it daily. Measured against each
technology's first mass-market launch, workplace adoption ran as fast as the personal computer's and
overall adoption outpaced both the PC and the internet (Bick et al.).

People understood the product on contact. Diagnoses that locate the gap in consumer readiness are
looking in the wrong place. What has not been built is the layer between a capable model and a
completed, verifiable unit of work.

### II. The Return Gap, and Why This Paper Does Not Lean On It

The most-quoted evidence for an enterprise return gap is weaker than its circulation suggests, and
an honest accounting is more useful than the headline.

MIT's Project NANDA reported that roughly ninety-five percent of organizations piloting custom or
embedded task-specific generative-AI tools saw no measurable return. That rests on a review of more
than 300 publicly disclosed initiatives, 52 structured interviews, and 153 survey responses
collected from senior leaders at four conferences. It is labelled "Preliminary Findings," it is not
peer-reviewed, and its authors describe the results as directionally accurate rather than
definitive, warning that the observation window may *understate* success (MIT NANDA). Its other
series — general-purpose chatbots — converted pilots to implementation at a far higher rate, so the
ninety-five percent is the complement of a *task-specific* figure inside a perception funnel. A
contemporaneous instrument runs the other way: AI at Wharton with GBK Collective surveyed 800 senior
decision-makers at U.S. firms above $50 million in revenue and found 74 percent reporting positive
return (Wharton and GBK Collective). Both measure perception, but not with equal grounds for
skepticism: GBK Collective is a commercial marketing-and-analytics firm co-founded by a Wharton
faculty member, and the "AI at Wharton" byline lends an academic association its funding and purpose
do not otherwise carry. NANDA is more forthcoming about its own limits, hedged headline number
included, despite its own institutional motive to frame current tooling as failing.

**A correction this paper owes its own earlier draft.** An earlier version cited RAND for the claim
that more than eighty percent of AI projects fail, twice the rate of non-AI IT projects. **That claim
is withdrawn.** RAND conducted a qualitative root-cause study on sixty-five practitioner interviews
and measured no failure rate; the figure appears in a hedged introductory sentence sourced to trade
press. Citing it as a RAND finding upgraded a magazine estimate into an authoritative measurement,
which is precisely the failure this paper spends its length accusing others of. What RAND does
establish, and what survives, is the qualitative result: the leading root causes of AI project
failure are problem framing and organizational misalignment rather than model capability (Ryseff et
al.).

Two facts cut against any story of an economy transformed. As of the six months ending May 2026, the
U.S. Census Bureau found 19.8 percent of U.S. businesses using AI in any business function, 37
percent among firms with 250 or more employees (Grundy and Khatiwoda). And Acemoglu's published
estimate puts AI's total factor productivity effect at no more than 0.66 percent over ten years,
from a transparent chain: roughly 20 percent of U.S. labour tasks exposed, of which about 23 percent
are profitably automatable, giving 4.6 percent of all tasks affected (Acemoglu).

The thesis does not need a failure statistic. It rests on Sections IV through X.

### III. Two Failures That Look Like One

The first belongs to classical machine learning. A trained model is task-shaped: it classifies,
ranks, forecasts, detects, transcribes. Consumers do not have classification problems; they have
processes — file the claim, chase the invoice, close the month — and a process is a sequence of
decisions, side effects, and exceptions in which a classifier is one part. Mitchell's account of
brittleness applies: a model that performs beautifully inside its training distribution fails
without warning outside it, and the user cannot tell which side of the line they are on (Mitchell).

Sculley and colleagues gave the structural version: only a small fraction of a real machine-learning
system is machine learning. The rest is data collection, feature extraction, verification,
configuration, monitoring, resource and process management, serving infrastructure, and glue — with
their estimate for a mature system at most five percent ML code and at least ninety-five percent
glue (Sculley et al. 2503).

The second failure belongs to the language-model era. The transformer solved sequence modeling at
scale (Vaswani et al.), and the industry wrapped it in a chat window. Chat is an interface idiom, not
an application framework. What a process needs and a conversation does not supply: an identity to
act as, a permission scope, durable state, idempotent operations that survive retry, an audit trail,
per-action cost accounting, and an escalation path under uncertainty.

Two items must come off that list, because they are solved, and Section IV concedes them at length.
What remains genuinely absent is idempotency, cost accounting, and any verification relation between
a specification and an output.

Conway's observation that organizations ship their own communication structure explains why the
surface came before the framework (Conway). A research laboratory's natural artifact is a research
surface.

### IV. Non-Determinism, Correctly Located

Earlier versions of this argument claimed non-determinism is "a defect at the point of use, not
immaturity." **That claim is withdrawn.** It fused a true architectural observation with an
unsupported claim of irreducibility, and the engineers refuted the second half.

Horace He and colleagues root-caused run-to-run variance at temperature zero to batch-size-dependent
reduction order under dynamic batching — kernels for matrix multiplication, RMSNorm, and attention
produce different numerical results depending on which batch a request lands in — and showed
batch-invariant kernels restore reproducibility (He et al.). Batch invariance now ships behind a
feature flag in both dominant open-source serving engines (vLLM Project; SGLang Team), and further
work targets determinism with verified speculation (Gond et al.). Structural defects do not have
toggles.

The measurements must also be restated correctly. Ouyang, Zhang, Harman, and Wang studied 829
problems across three benchmarks. **At the default temperature of 1**, the proportion of tasks for
which no two responses produced identical test output was 75.76, 51.00, and 47.56 percent, and the
maximum pass-rate difference between two responses to the same prompt reached 1.00 for 39.63 percent
of HumanEval problems. **At temperature 0 the figures fall to 43.64, 27.40, and 18.29 percent** —
HumanEval by a factor of 2.6 (Ouyang et al.). An earlier draft attached the temperature-1 range to
the phrase "temperature 0 insufficient," which misrepresented the source.

**Table 1. Four properties, three verdicts**

| Property | Status | Evidence |
|---|---|---|
| Form: output conforms to a schema or grammar | Solved | Willard and Louf; Geng et al.; OpenAI |
| Bitwise: identical input yields identical bits | Solved, at a throughput cost | He et al.; vLLM; SGLang; Gond et al. |
| Brittleness: semantically equivalent inputs yield different answers | Open — and *reproducible*, so not a determinism problem | Mirzadeh et al.: up to 65% drop from irrelevant clauses |
| Behavioural: the same task succeeds on all *k* trials | Open | Yao et al.: pass^1 under 50%; GPT-4o retail pass^8 under 25% |

The third row is a correction: GSM-Symbolic measures *input sensitivity*, which is perfectly
reproducible, and belongs to brittleness rather than non-determinism.

What survives is the fourth row, and it is what motivates a deterministic default path. Yao, Shinn,
Razavi, and Narasimhan built τ-bench to test whether an agent handles a realistic customer-service
interaction *under domain policy*. Their pass^k metric — the probability of solving the same task on
all *k* trials — showed frontier agents under fifty percent at pass^1 and GPT-4o's retail pass^8
below twenty-five percent (Yao et al.). Notably, its authors concede that reward computed by
"database state comparisons" against an annotated goal may be "a necessary but not sufficient
condition for a successful episode" — the oracle problem appearing inside the benchmark this paper
relies on. Xu and colleagues extended the test to whole jobs: 175 long-horizon professional tasks in
a simulated software company, best agent completing roughly thirty percent autonomously (Xu et al.).
Broader environments are harder — OSWorld reports 12.24 percent against a 72.36 percent human
baseline (Xie et al.), and AutomationBench's own paper reports frontier models "below 10%" (Shepard
and Salimans).

**Two honest qualifications.** First, this paper will not say non-determinism *disqualifies* a
component; Section XIV concedes why that framing is wrong. The claim is narrower: a component that
cannot repeat itself cannot itself carry a correctness guarantee, so the guarantee must live in
deterministic code around it. Second, every domain in the historical record produced a snapshot like
the one above shortly before the learned approach won, and the trend is currently moving against
this paper — successor benchmarks report frontier pass rates far above the 2024 figures. Those newer
numbers come from vendor-run leaderboard submissions this author could not independently verify, so
they are reported as a trend rather than cited, but the direction is not in doubt.

### V. Why the Model Should Not Sit on the Default Path

Installing the general model inside the running transaction fails in a specific, instructive way.

Dell'Acqua and colleagues ran a field experiment with 758 Boston Consulting Group consultants and
found a "jagged technological frontier": inside it, consultants completed 12.2 percent more work,
25.1 percent faster, at roughly forty percent higher quality, with the largest gains among
below-average performers; outside it, they performed nineteen percentage points *worse* than
consultants without AI (Dell'Acqua et al.). Jagged means not legible from inside the task — and
putting the model on the default path requires an operator to make exactly that judgment,
continuously.

None of what follows in this paragraph is about software. It is included because the clinical
literature shows the same shape with consequences that are easier to see than a botched merge, and
the pattern it documents — automation improving the average while degrading the expert — is what
Section VI licenses demotion against, not evidence about coding agents specifically. Povyakalo and
colleagues
found computer-aided detection *reduced* the sensitivity of the most discriminating mammography
readers on difficult cancers while helping less discriminating ones (Povyakalo et al.). Budzyń and
colleagues found adenoma detection in standard non-AI colonoscopy fell from 28.4 to 22.4 percent
after endoscopists began routine AI use (Budzyń et al.). The tool improved the average and degraded
the expert.

Bainbridge named the mechanism in 1983: unused skills deteriorate, converting a formerly expert
operator into an inexpert one, so the human is least prepared exactly when the automation hands
control back (Bainbridge 775). Parasuraman and Manzey add that automation complacency occurs in
experts as well as novices and cannot simply be trained away (Parasuraman and Manzey). Aviation
regulators acted: the FAA has warned carriers since 2013 that continuous autoflight use does not
reinforce manual skill, and made manual flight a foundational competency in 2017 after an industry
group found manual handling error a factor in over sixty percent of reviewed accident reports
(United States, FAA, SAFO 13002; SAFO 17007; PARC/CAST).

Note what this argues for and what it does not. It argues for keeping the ordinary transaction off
the model. It does not argue for removing the model, and Bainbridge's own mechanism cuts against
removal: a retained model behind a monitor preserves the comparison that makes drift visible.

### VI. The Claim

Where a procedural sub-decision's option space is finite and enumerable at check time, and where its
correctness rule **already exists in writing, prior to and independently of any model**, the general
model belongs upstream as the *author* of a deterministic predicate that occupies the **default
path** — with the model retained as an escalation stage on that predicate's residual, behind a
monitor that compares the two on live traffic.

Not removed. **Demoted.**

Four conditions license it, and a fifth variable governs whether it holds.

**(i) The option space is finite and enumerable at check time.** A *snapshot* property, not a
property of a domain. Bachant and McDermott's selection argument cuts at it directly: "if the domain
were less volatile, the task would not require a knowledge-based system," and "whenever an expert
system finds itself on a boundry, its public encourages it to extend the boundary" (Bachant and
McDermott 21–22, 28). A demoted call site can notice that its option space has stopped being
enumerable; a deleted one cannot. That asymmetry is most of the argument for demotion.

**(ii) The correctness rule already exists as a written rule that predates the model.** Narrowed
from an earlier draft's "exists *or can be constructed*," and the narrowing is a real cost: where
the predicate must be authored from scratch, this paper makes no claim, and accepts Brooks without
qualification — "the hardest part of the software task is arriving at a complete and consistent
specification" (Brooks 12). What is required is *evaluation-time* independence: the predicate takes
only the data on hand as arguments at decision time and is ratifiable against a criterion a domain
expert holds apart from the model's behaviour. Discovery by prototype is not disqualifying; Brooks
prescribes that sequence in the same paragraph in which he denies ex-ante specification is possible,
calling for "rapid prototyping of systems as part of the iterative specification of requirements"
(15).

**(iii) A domain expert can ratify the criterion.** Now the *weakest* condition, not the safest.
EvalPlus found 18 defects across 11 percent of HumanEval's 164 human-written ground-truth solutions
— ten of them cases where the reference implementation "incorrectly implement[s] the desired
functionality" — standing roughly two years undetected in the most scrutinised code benchmark in the
field (Liu et al.). Condition (iii) asks whether a human *can* state the criterion. It does not ask
whether the statement is true.

**(iv) The predicate must be demonstrably non-vacuous over the enumerated option space.** This
condition is new, and exists because the first three are satisfied by `return true`. They require
the predicate to be enumerable, cheap, checkable and model-independent; they never required it to be
*adequate*. The failure mode is definitional, not something a citation is needed to establish: a
predicate that always passes satisfies (i)–(iii) trivially and proves nothing. (An earlier draft
attributed a supporting quotation on generated-verification-annotation weakness to Beg et al.; a
second adversarial pass found that source does not contain the claim, and it is withdrawn rather than
repeated unverified — see the closing notes.)

**The fifth variable: adversarial optimisation pressure against the verifier.** Conditions (i)–(iii)
hold identically in two systems that made opposite choices. Kimi k1.5 held the reference answer and
built two learned judges anyway; DeepSeek-R1's mathematics stage "abstain[s] from applying neural
reward models—whether outcome-based or process-based—to reasoning tasks" (Guo et al.). Whatever
separates them is not in the condition set.

### VII. Adequacy Is Manufactured, Not Discovered

The most useful correction to this paper's earlier form is that oracle adequacy is not a
free-standing feature of a decision waiting to be found. It is **co-produced by constraining what the
generator may emit.**

DeepSeek-R1 obtains reliable rule-based verification because "the model is required to provide the
final answer in a specified format (for example, within a box)" (Guo et al.). The task did not arrive
checkable; it was *made* checkable by restricting admissible outputs, and that restriction is a
method of the approach rather than an embarrassment to it.

This is the part a practitioner can act on immediately. The question is not "does this decision have
a checkable criterion?" It is "what would I have to constrain about the output for a checkable
criterion to exist?" That converts a classification problem this paper's earlier draft could not
administer into a design problem engineers already know how to do.

It also disposes of a defence this paper cannot make. Determinism does not confer robustness under
pressure: in the same study a *model-based* verifier holds at 0.0–1.1 percent across every
reward-hacking pattern tested. Robustness is an implementation property, and it licenses "use a
robust verifier," not "remove the model."

### VIII. What the Record Actually Shows

**Three contemporary instances, all of which demote and none of which delete.**

Reddy, Challaram, and Basu build read-only deterministic pre-execution gates in τ²-bench's airline
domain — the benchmark family this paper cites for agent unreliability — raising task success from
29.6 to 42.0 percent on gpt-4o-mini, a gain of 12.4 percentage points at *P* = 0.0012, replicated on
a disjoint fifteen-seed set at +12.3 points and *P* = 0.0008. They publish negative controls: gates
help where tools are policy-permissive and add little where tools already self-enforce. Their own
summary is the sentence this paper should have started from: "deterministic gates do not guarantee
task success, but they can deterministically prevent a known class of silent policy-violating writes
at the action boundary" (Reddy et al.).

Qiu and colleagues demote the model so "it is no longer the central decision-maker but is invoked as
a specialized tool at specific nodes of the blueprint to handle complex but bounded sub-tasks,"
reporting 35.56 percent against an 18.00 percent baseline on the same Claude-Sonnet-4 backbone,
constraint violations down 96.0 percent — eleven against 275 — and two production deployments (Qiu et
al.).

Huang and colleagues test a hybrid in which "the rule-based verifier first classifies responses, and
the model-based verifier provides supplementary judgment only when the rule-based verifier flags a
response as incorrect," recovering a few points of recall over the rule-based verifier alone (Huang et
al.). Their own framing is more cautionary than triumphant — the source is a study of verifier
*pitfalls*, not a case for hybrids as a default — but the shape it demonstrates is the one argued for
here: rules first, model on the residual.

**Two instances where deletion did happen, and what they share.** Kaivola and colleagues made formal
verification "the primary validation vehicle" for the Intel Core i7 execution cluster and "dropped
coverage driven testing entirely," at roughly twenty person-years (Kaivola et al.). CompCert's
verified middle end has never yielded a wrong-code error to Csmith across six CPU-years of random
testing, with every defect found lying outside the verified slice (Yang et al.). Both are **fixed,
discrete domains** where the option space does not drift. That is the boundary of unconditional
removal, and it is much narrower than a business process.

**Table 2. The terminal step, by instance**

| Instance | Domain | Terminal step | Result |
|---|---|---|---|
| Reddy et al. | τ²-bench airline | Gate + retain | +12.4pp, *P* = 0.0012, replicated |
| Qiu et al. | Agentic workflows | Demote to sub-tasks | 35.56% vs 18.00%; violations −96% |
| Huang et al. | Verifiable reasoning | Rules first, model on residual | Hybrid recall a few points above rules alone; source frames this as a pitfall study |
| Kaivola et al. | i7 execution cluster | **Delete** | Coverage testing dropped entirely |
| Yang et al. (CompCert) | Compiler middle end | **Delete** | Zero wrong-code in 6 CPU-years |
| *Specification harvested from model traffic, then deleted* | — | — | **No instances** |

The last row is the honest bottom line. Wrap-and-retain has replicated, statistically significant
instances in this paper's own chosen domain. Extract-and-delete-from-instrumented-traffic has none.
An earlier draft treated that absence as a maturity gap awaiting fieldwork. It is a documented
preference, and it runs against the earlier draft.

**Feasibility.** Two facts suggest a frozen predicate is cheaper to maintain than folklore holds.
seL4 reports that re-verification under a *fixed* specification is "roughly proportional to the size
of the change," and that "there is one class of otherwise frequent code changes that does not occur
after the kernel has been verified: implementation bug fixes" (Klein et al. 217). And Menzies and
colleagues, across 171 projects, "found no evidence for the delayed issue effect" (Menzies et al.) —
so a wrongly frozen predicate is cheap to unfreeze, which is demotion's central risk and apparently
a survivable one.

### IX. AI in the Germ Line

The biology this paper takes its framing from was always arguing for demotion, and an earlier draft
misread its own analogy.

Crick's central dogma describes a one-directional flow of sequence information: DNA encodes, RNA
transcribes, protein does the work, and information does not pass back from protein to nucleic acid
(Crick 561–62). The genome is not deleted once development completes. It is retired from the
metabolic path and retained as the standing authority for repair, regeneration, and response to
conditions the expressed form cannot handle. That is the arrangement argued for here.

**Authorship, placed by evidence.** Peng, Kalliamvakou, Cihon, and Demirer found developers with an
AI pair programmer finished an HTTP-server task 55.8 percent faster (Peng et al.). The counter-case
is more complicated than an earlier draft claimed: METR ran a randomized trial finding experienced
developers nineteen percent *slower* in mature repositories, but has since published a revision of
its experiment design identifying selection bias running against the use this paper made of the
figure (METR). **The 19 percent is withdrawn as a live measurement.** What survives is the
qualitative pattern, consistent with Dell'Acqua: authorship wins on greenfield work and accidental
complexity, and narrows or reverses where the codebase is mature and essential complexity already
lives in an expert's head. Brooks drew that distinction in 1987 (Brooks, *Computer* 11–12).

**Patching the seams.** The second earned use is bridging gaps *between* code, where specification
ran out: the adapter nobody wrote, the format translation nobody standardized, the exception
appearing eight times a year. Parnas's rule governs placement: hide the model behind a module
boundary, expose the contract, conceal the mechanism (Parnas 1056).

Karpathy's framing of learned weights as a second kind of program is right, and the skipped part is
that Software 1.0 and 2.0 coexist, with the boundary set by engineering judgment (Karpathy). Meta's
generative ads work illustrates the shape — a large general model in the germ line distilling into
specialised user-facing models (Li et al.) — though it supports the germ-line *structure* and not
extraction, because distillation yields smaller models, not deterministic code.

### X. Why Bother, Given That Inference Is Nearly Free

Inference for a fixed capability level fell more than 280-fold in twenty-three months, hardware cost
declines roughly thirty percent a year, and energy efficiency improves about forty percent (Stanford
Institute for Human-Centered Artificial Intelligence). No demotion amortises against a curve falling
that fast. Rising aggregate spend is not a counter-argument in this paper's favour either; that is
Jevons, conceded by name.

An earlier draft answered this by claiming a bank regulator as its warrant. **That argument is
withdrawn, and the error is kept in view because it is exactly the failure this paper accuses others
of.**

SR 26-2 will not bear the weight. Its opening section states that "this guidance does not set forth
enforceable standards or prescriptive requirements; accordingly, non-compliance with this guidance
will not result in supervisory criticism against a banking organization" (Board of Governors et al.,
SR 26-2 2). Footnote 3 places generative and agentic AI outside scope, and its marker sits at the end
of the very sentence excluding "deterministic rule-based processes and software *where there are no
statistical, economic, or financial theories underpinning their design or use*" (3; emphasis added).
Both endpoints of the transition occupy the same supervisory posture, and the footnote directs
identical treatment for both — governance is to follow the institution's own practices "for any
tools, processes, or systems not covered in this document." Worse, the conditional clause the earlier
draft omitted reverses the incentive for exactly the cases worth doing: a predicate encoding a price,
a cutoff, or a credit policy has financial theory underpinning its use, so extracting it moves a
decision *into* scope. And none of this is new — SR 11-7 in 2011 already defined a model as applying
"statistical, economic, financial, or mathematical theories." SR 26-2 narrowed the definition,
dropped "mathematical," and added a disclaimer its predecessor lacked. The earlier draft dated its
warrant to a deregulatory retrenchment and read it as a tailwind.

**The justification that survives is engineering examinability, not regulatory exemption.** A
deterministic predicate admits exhaustive enumeration over its option space, deterministic replay,
and diff review by a named human. A sampled generator admits none of these. That is a real property
worth real money in an audited process — and this paper states plainly that **no supervisory
instrument currently supplies a differential**. What remains is a judgement about examination risk:
demotion can trade an undefined governance obligation for a defined one. A judgement, not a
derivation.

### XI. What the Cycle Costs the Substrate

A misallocation would be bad enough. The stronger claim is that the current cycle extracts from
organic thought, degrades its practice and regeneration, and charges part of the bill to
non-customers. Each mechanism has evidence; each has limits stated with it.

**Extraction.** On 20 July 2026 the U.S. District Court for the Northern District of California
granted final approval to a non-reversionary $1.5 billion class settlement in *Bartz v. Anthropic
PBC*, covering 482,460 works at roughly $3,000 each. The merits ruling drew the line precisely:
training on the books was fair use, "exceedingly transformative," while downloading over seven
million pirated copies to build the library was not (*Bartz*). Most comparable matters remain
unresolved, including *The New York Times Company v. Microsoft Corporation*.

**Degradation of practice.** The strongest evidence is experimental. Bastani and colleagues
randomized nearly a thousand high-school mathematics students and found access to an unguarded GPT-4
assistant improved practice performance 48 percent while available and left students performing 17
percent *worse* on exams once removed (Bastani et al.). Shen and Tamkin randomly assigned
professional developers to use AI while learning an unfamiliar library and measured a 17 percent
reduction in comprehension with no significant time saving (Shen and Tamkin). Budzyń's colonoscopy
result is the same effect in practising specialists.

This paper declines to lean on the widely publicised EEG study. Kosmyna and colleagues found 83.3
percent of LLM-group participants failed to produce a correct quotation from an essay they had just
written, against 11.1 percent in comparison groups (Kosmyna et al.). But their own search-engine
group — which also offloads to a tool — showed no impairment, so the effect is not generic
offloading; the authors instruct commentators not to describe the findings as harm; and a published
commentary calculates the study needed roughly three times its sample for adequate power (Stanković
et al.). A frequently cited survey correlating AI use with reduced critical thinking is excluded
entirely: it carries a published correction and prints two mutually incompatible correlation tables
one page apart.

**Degradation of regeneration.** Brynjolfsson, Chandar, and Chen find a 16 percent relative
employment decline for workers aged 22 to 25 in the most AI-exposed occupations, with young software
developers down nearly 20 percent from a late-2022 peak while older cohorts grew (Brynjolfsson,
Chandar, and Chen, "Canaries"). **The authors disclaim causal identification.** Under the broadest
controls the decline is significant only after 2024, earlier declines are attributed partly to
interest rates, and their own dashboard shows the exposed/unexposed gap narrowing by mid-2026
("Canaries, Interest Rates"; Stanford Digital Economy Lab). This is association.

The theory is firmer than the identification. Autor and Thompson establish, across 303 occupations
from 1980 to 2018, that whether automation raises or lowers the value of remaining human labour
depends on whether the automated tasks were the *expert* or the *inexpert* ones (Autor and
Thompson) — the same boundary as Section VI, reached from labour economics. Afrouzi and colleagues
model an economy where workers acquire skill through the tasks they perform and show cheaper
automation can tip it into a low-learning equilibrium (Afrouzi et al.). One caution: the
deliberate-practice literature often invoked here is weaker than its reputation, with a
meta-analysis finding it explains under one percent of performance variance in professions
(Macnamara et al.).

**Consumption of the commons.** Longpre and colleagues measured the substrate closing: in one year,
robots.txt restrictions rendered roughly five percent of all C4 tokens and over twenty-eight percent
of tokens from its most actively maintained sources fully restricted (Longpre et al.). Monthly new
questions on Stack Overflow fell from 109,341 in November 2022 to 2,052 in June 2026 (Stack
Exchange). Causal work isolates part of it: del Rio-Chanona and colleagues find ChatGPT's release
reduced posting about 15 percent over six months, rising to roughly 25 percent by April 2023 (del
Rio-Chanona et al.); Burtch and colleagues measure a discontinuous 12 percent traffic drop with no
comparable Reddit effect (Burtch et al.). Wikimedia reports roughly eight percent lower human
pageviews and attributes it to generative AI (Miller). Cloudflare's data show crawl-to-referral
ratios for AI platforms in the tens and hundreds of thousands to one (Belson and Rhea). Villalobos
and colleagues project training runs consuming the entire stock of public human-generated text
between 2026 and 2032 (Villalobos et al.).

**Cost-shifting, with the complication.** PJM's 2027/2028 capacity auction cleared at the
FERC-approved cap of $333.44 per MW-day footprint-wide, with PJM attributing nearly 5,100 MW of the
5,250 MW forecast-peak increase to data centres (PJM, "PJM Auction Procures"). PJM's Independent
Market Monitor quantifies the resulting capacity-market revenue increase at $23.1 billion across
three delivery years (Monitoring Analytics). Lawrence Berkeley National Laboratory estimates U.S.
data centres used 192 TWh in 2024, 4.7 percent of national electricity, projecting 649 TWh or 11.8
percent by 2030 (Smith et al.). Federal Reserve Board staff estimate data-centre investment rose from
$10 billion in 2023 to $179 billion in 2025, contributing 0.41 percentage points to nominal GDP
growth (Brandsaas et al.). Two facts cut against the strong version and travel with it: in PJM's
first quarter of 2026 total wholesale power cost rose 75.5 percent year over year but the largest
single component was *fuel*, not capacity; and PJM's most recent auction, announced 14 July 2026,
cleared *lower* at $325 per MW-day with a forecast-peak increment of about 2,000 MW (PJM, "PJM
Capacity Auction Procures").

**Why it cannot simply eat itself.** The satisfying closing move — the replacement is made of the
substrate it degrades, so degradation is self-limiting — does not survive. Shumailov and colleagues
demonstrated model collapse under recursive training (Shumailov et al.), but their own second
condition, preserving ten percent of original real data, produced only minor degradation.
Gerstgrasser and colleagues identified the general condition: if synthetic data *accumulates
alongside* real data rather than replacing it, test error has a finite bound of roughly 1.645 times
the real-data-only risk (Gerstgrasser et al.), confirmed by Kazdan and colleagues and generalized by
Dey and Donoho. Schaeffer and colleagues document eight competing definitions of "collapse" and argue
the catastrophic narrative rests on the replacement regime (Schaeffer et al.). The countervailing
result is Dohmatob and colleagues' proof that in the asymptotic scaling regime even a vanishing
synthetic fraction prevents optimal scaling.

So collapse is real under replacement and averted under accumulation. **But note the averting
conditions.** Alemohammad and colleagues identify the decisive variable as *fresh* real data — a
fixed real dataset only delays degradation (Alemohammad et al.). Feng and colleagues show
*verification* of synthesized data, not mere mixing, is the operative condition (Feng et al.). Fresh
human material and verification: this paper's architecture, restated by the collapse literature from
the opposite direction. The dramatic claim fails; the structural one survives without it.

### XII. The Balance Sheet

Combined cash capital expenditure by Microsoft, Alphabet, Meta, and Amazon rose from $217.267 billion
in 2024 to $357.508 billion in 2025 (U.S. Securities and Exchange Commission).

**Table 3. Free cash flow against the build-out**

| Company | Free cash flow | Operating cash flow | Source |
|---|---|---|---|
| Amazon | TTM $25.9B → $1.2B (−95%) | TTM $113.9B → $148.5B (+30%) | 8-K, 29 Apr. 2026 |
| Alphabet | Q2 2026 **−$5.9B** (first negative quarter) | $39.1B against capex $44.9B | 8-K, 22 July 2026 |
| Meta | Q2 2026 $0.78B vs. $8.5B (−91%) | Capex incl. finance leases $31.1B | 8-K, 29 July 2026 |
| Microsoft | FY24 $74.1B → FY25 $71.6B → FY26 $67.0B | FY24 $118.5B → FY26 $182.9B (+34%) | 10-K, 29 July 2026 |

The rebuttal that this is funded from operating surplus no longer holds. Alphabet funded its June
2026 build-out by issuing $49.6 billion of equity and mandatory convertible preferred, stating the AI
purpose explicitly, plus $20.3 billion of notes (Alphabet). Microsoft extended datacenter and
office-building useful lives from fifteen to twenty-five years effective fiscal 2027 (Hood;
Microsoft). Meta lengthened server lives to 5.5 years, disclosing the change alone added $2.59
billion to 2025 net income (Meta). Amazon moved the opposite way, shortening a subset from six to
five years citing the pace of AI development (Amazon). The four now disagree about the useful life of
the same asset class. Microsoft recorded $24.1 billion of revenue *from OpenAI* in fiscal 2026 and
was owed $6.0 billion, making part of the sector's revenue circular; Alphabet's headline
second-quarter earnings were dominated by $99.0 billion of unrealised equity gains against $40.8
billion of operating income; and Microsoft's own risk disclosure states its AI infrastructure
investment is running ahead of the revenue meant to justify it (Microsoft).

**Two claims withdrawn here.** An earlier draft called general intelligence "the one component that
was never scarce." A wage bill is a scarcity price, and the same draft invoked one two clauses later;
human general reasoning is abundant in aggregate and acutely scarce at points of need, which is a
genuine argument for building synthetic capability. And an earlier draft credited humanity with "zero
training capex," booking human formation at zero because sunk while booking a training run at sticker
price — a sunk-versus-forward asymmetry, withdrawn.

What survives is narrower: the substitution bet is financed by equity, debt, and lengthened
depreciation rather than product cash flow, while the augmentation path needs a compiler and a
runtime rather than a new brain. Whether that resolves as mania or infrastructure has precedent both
ways; Odlyzko notes the 1830s railway boom reached over eight percent of GDP, was profitable, and was
"justified by fundamentals" (Odlyzko).

### XIII. The Practical Shape

For an operator, the claim reduces to four commitments.

1. **Manufacture adequacy rather than looking for it.** Constrain what the generator may emit until a
   checkable predicate exists. This is the DeepSeek-R1 move and it is available on ordinary work.
2. **Demote, never delete, outside fixed discrete domains.** Put the predicate on the default path;
   keep the model on the residual; run a differential monitor over live traffic so drift stays
   visible.
3. **Prove non-vacuity before trusting a green check.** A passing oracle certifies conformance to the
   oracle. Enumerate the option space against the predicate and show it discriminates.
4. **Ship an expiry review and a re-entry path with every predicate.** Adequacy decays — Huang and
   colleagues find rule-based recall meaningfully lower for long-chain-of-thought generators (around
   0.92) than for the weaker generators their verifier was built against, evidence that a predicate's
   fit degrades as the thing it's checking changes. Where churn is high, demotion relocates the model
   call rather than eliminating it, which given falling inference cost drains it of economic force in
   exactly those cases.

And one discipline borrowed from Parnas, a hostile witness on the *sequence* — "the people who
commission the building of a software system do not know exactly what they want and are unable to
tell us all that they know" — but friendly on the *artifact*: every predicate ships an explicit
declaration of its areas of incompleteness (Parnas and Clements).

### XIV. Concessions

Twenty-two concessions were forced by the refutation attempt. These change what a reader should
believe.

**The normative claim is downgraded.** Barr and colleagues report that "for many systems and most
testing as currently practiced in industry … the tester does not have the luxury of formal
specifications or assertions, or automated partial test oracles" (Barr et al. 508). The set of
sub-decisions meeting all four conditions at negligible construction cost is a **minority residue of
industrial practice**. "General models belong out of the transaction path" is withdrawn as a general
prescription and restated as a claim about that residue.

**The mechanism has been available for four decades and has not diffused.** Woodcock and colleagues
report that "verification technology and formal methods have not seen widespread adoption as a
routine part of systems development practice, except, arguably, in the development of critical
systems in certain domains" — from a sample they describe as biased toward those who saw value
(Woodcock et al.). The price where paid is real: seL4's proof cost 11 person-years against 2.2
person-years of implementation, 165,000 lines of Isabelle against 8,700 lines of C (Klein et al.
216).

**Three citations are withdrawn as evidence.** PAL's deterministic component is an *executor*, not a
verifier — the model emits a program per question at inference time, and its authors conclude current
models "are still incapable of executing" the plans they specify (Gao et al.). LATM's tool *user*
remains a model on every call (Cai et al.). Both keep a model call in the transaction path and both
argue from cost, the justification this paper has given up; they are demoted from evidence to
illustration. And the McMahan calibration layer is withdrawn as exemplar: its correction functions
are fitted by Poisson or isotonic regression — statistical models, not authored code — and the same
lead author proved that "certain natural notions of calibration can be impossible to achieve"
(McMahan and Muralidharan).

**One earlier concession is partially withdrawn as over-broad.** This paper previously conceded that
human-AI combinations underperform the best of either alone. Vaccaro and colleagues find task type
significantly moderates the effect, *F*(1,104) = 7.84, *p* = 0.006: losses concentrate in *decision*
tasks (*g* = −0.27, *p* = 0.002) while *creation* tasks show a positive point estimate, and where the
human alone outperforms the AI alone the combination beats both (*g* = +0.46, *p* < 0.001) (Vaccaro
et al.). Drafting a specification is a creation task performed by a domain expert. The concession
stands for decisions in the transaction path; it does not bar a human-ratified, model-drafted
predicate — which is precisely the arrangement argued for here.

**The conditions are a resource-relative prior, not a decision procedure.** Verifier existence is
semi-decidable in general (Rice), decidable only under finite-state restriction (Büchi and
Landweber), and undecidable under incomplete information (Pnueli and Rosner). The conditions are
therefore stated as "authorable at stated engineering cost," candidates are pre-registered before
being attempted, and abandoned attempts are published alongside successes so the base rate is visible
— a discipline Reddy and colleagues already demonstrate by publishing negative controls.

### XV. The Case Against This Paper

*The strongest refutation available, written from the opponent's side and printed without rebuttal.*

The argument advanced here has a structure worth naming before it is contested. It claims that where
a procedural sub-decision has an enumerable option space, an existing written criterion, an expert
who can ratify it, and a non-vacuous predicate, a general-model call belongs off the default path.
The objection is not that this is unproven. It is that the conditions cannot do the work assigned to
them, that the evidence for the terminal step comes from domains unlike the ones the paper addresses,
and that the mechanism has had four decades to diffuse and has not.

Begin with the conditions, which fail in four ways. They do not discriminate the two regimes the
field actually operates: (i)–(iii) hold identically in a system that built two learned judges and one
that refuses neural reward models entirely. They never required adequacy until this draft added it,
and the addition repairs a hole `return true` walked through. Condition (ii)'s independence clause
was inconsistent with the paper's own verb order until narrowed, and the narrowing — to rules already
existing in writing — concedes away every case where the specification must be authored, which is
most of them. And condition (iii), the licensing authority for the whole scheme, carries a measured
eleven percent defect rate in the cleanest instance anyone has constructed.

Then consider what the terminal step rests on. Testing survived verification in both flagship cases:
every defect Csmith found in CompCert lay outside the verified slice, and the authors conclude that
"verification does not obviate testing, but rather complements it" (Yang et al.). Fonseca and
colleagues exhibited a verified system whose specification gap admitted implementations that "return
incorrect results" and "still verified" after a seven-line patch (Fonseca et al.) — a defect class
formal verification is supposed to catch, surviving it anyway. In the maintained-rule literature the
largest instance took years to stabilise: XCON grew from roughly 250 rules in 1979 to on the order of
2,500 within a decade, a sustained and expensive expansion. (An earlier draft of this paragraph cited
a more dramatic 6,200-rule figure, an annual-churn rate, a per-year maintenance-cost figure, and a
direct quotation from Bachant and McDermott; none of the four survived a second adversarial check
against the primary text, and they are withdrawn rather than repeated unverified — see the closing
notes.)

The selection argument is the sharpest form. If the volatility that makes a team reach for a general
model is the same volatility that prevents an extracted artifact from stabilising, the conditions
select for cases where the predicate expires soonest. The paper's answer — demotion, so the call site
can notice its own expiry — is an admission that the artifact is not expected to hold, dressed as a
design principle.

Finally, ambition. The set of sub-decisions satisfying all conditions at negligible construction cost
is a minority residue of industrial practice, and a minority residue has never licensed a general
architectural prescription. Where the mechanism has been pursued at scale outside that residue the
price has been enormous, and formal methods — the same mechanism, with four decades, working tools,
regulatory endorsement and demonstrated technical wins — produced a few dozen findable industrial
projects and its own surveyors' verdict of non-adoption.

None of this shows determinism is the wrong destination. It shows the paper is describing a minority
practice, that its licensing conditions are a prior rather than a procedure, and that its central
mechanism has a forty-year record of not spreading. Those are the terms on which it should be read.

### XVI. What Would Falsify This

**F1 — Behavioural reliability closes without demotion.** Sustained pass^8 above 0.95 on an
execution-graded, cross-application business-process benchmark, on a task distribution the model's
builders did not choose, replicated by a third party. If that arrives, the deterministic default path
becomes optional rather than load-bearing. The trend is currently moving toward this falsifier.

**F2 — Demotion is shown to be strictly dominated.** If, where all four conditions hold, a retained
model on the default path matches a deterministic predicate on error rate, examinability and cost
across a full hardware cycle, the claim is wrong. Conversely, if a firm profitably *deletes* a call
in a domain with drifting option space, the boundary in Section VIII is wrong in the other direction.

**F3 — Predicate decay outruns its benefit.** If harvested predicates in ordinary business domains
show churn on the XCON scale — sustained, expensive annual revision, maintenance exceeding the
inference displaced — the conditions select for cases too volatile to be worth doing and the residue
shrinks to nothing.

### XVII. Remaining Vulnerabilities

1. **Zero instances of the specific transition.** No documented case of a specification harvested from
   instrumented model traffic with the call then demoted on a stated schedule. The architecture has
   instances; this paper's route to it does not.
2. **The conditions remain a prior, not a test**, bounded now by pre-registration and published
   failures — a discipline rather than a solution.
3. **Condition (iii) carries a measured eleven percent error rate** and licenses the whole scheme.
4. **The residue may be small.** If Barr and colleagues are right about industrial practice, the set
   of qualifying sub-decisions may be too small to matter economically even where the argument holds.
5. **Four decades of non-diffusion** is the base rate this paper bets against, and it has not
   explained what changed other than that a general model can now draft the predicate.

### XVIII. Conclusion

The consumer side of generative AI is settled; the application layer is not. This paper argued, and
still argues, that the reason is a misplacement rather than a shortfall — general models installed
inside transactions where their properties are wrong, instead of upstream where their properties are
exactly right.

What it no longer argues is that the model should be removed. Every published instance of putting a
deterministic correctness predicate into an agentic transaction path retains the model: gating its
writes, confining it to bounded sub-tasks, or working the residual the rules reject. Those instances
carry replicated, statistically significant gains — twelve points on the airline domain, a
ninety-six percent reduction in constraint violations, two production deployments — which is more
than the deletion thesis ever had. Unconditional removal belongs to fixed discrete domains: an
execution cluster, a compiler.

So the genome analogy holds after all, and more exactly than its author first understood. DNA is not
deleted when the organism is built. It is retired from the metabolic path and kept as the standing
authority for repair and for conditions the expressed form was not built to handle. That is where a
general model belongs in a working system: authoring the encoding, absent from the ordinary
transaction, retained for the exceptions, with a human stating what counts as correct.

It is a smaller claim than this paper started with. It is the one the evidence supports.

---

## Works Cited

Acemoglu, Daron. "The Simple Macroeconomics of AI." *Economic Policy*, vol. 40, no. 121, Jan. 2025,
pp. 13–58.

Afrouzi, Hassan, Andres Blanco, Andrés Drenik, and Erik Hurst. *Automation, Learning, and Career
Dynamics*. Working Paper 2026-61, Becker Friedman Institute, University of Chicago, 2026.

Alemohammad, Sina, et al. "Self-Consuming Generative Models Go MAD." *Proceedings of the Twelfth
International Conference on Learning Representations*, 2024.

Alphabet Inc. "Alphabet Announces Second Quarter 2026 Results." Exhibit 99.1 to Form 8-K, U.S.
Securities and Exchange Commission, 22 July 2026.

Amazon.com, Inc. *Annual Report on Form 10-K for the Fiscal Year Ended December 31, 2025*. U.S.
Securities and Exchange Commission, Feb. 2026.

Autor, David, and Neil Thompson. *Expertise*. NBER Working Paper 33941, National Bureau of Economic
Research, June 2025.

Bachant, Judith, and John McDermott. "R1 Revisited: Four Years in the Trenches." *AI Magazine*, vol.
5, no. 3, 1984, pp. 21–32.

Bainbridge, Lisanne. "Ironies of Automation." *Automatica*, vol. 19, no. 6, 1983, pp. 775–79.

Barr, Earl T., Mark Harman, Phil McMinn, Muzammil Shahbaz, and Shin Yoo. "The Oracle Problem in
Software Testing: A Survey." *IEEE Transactions on Software Engineering*, vol. 41, no. 5, May 2015,
pp. 507–25.

*Bartz v. Anthropic PBC*, No. C 24-05417 WHA (N.D. Cal.). Order on Fair Use, 23 June 2025; Order
Granting Final Approval of Class Action Settlement, 20 July 2026.

Bastani, Hamsa, Osbert Bastani, Alp Sungu, Haosen Ge, Özge Kabakcı, and Rei Mariman. "Generative AI
without Guardrails Can Harm Learning: Evidence from High School Mathematics." *Proceedings of the
National Academy of Sciences*, 2025.

Belson, David, and Sam Rhea. "The Crawl before the Fall … of Referrals." *The Cloudflare Blog*, 1
July 2025.

Bick, Alexander, Adam Blandin, and David J. Deming. *The Rapid Adoption of Generative AI*. NBER
Working Paper 32966, National Bureau of Economic Research, Sept. 2024.

Board of Governors of the Federal Reserve System, Office of the Comptroller of the Currency, and
Federal Deposit Insurance Corporation. "Supervisory Guidance on Model Risk Management." Attachment to
Supervisory Letter SR 26-2, 17 Apr. 2026, 12 pp.

---. "Supervisory Guidance on Model Risk Management." Attachment to SR Letter 11-7, 4 Apr. 2011.

Brandsaas, Eirik Eylands, Daniel Garcia, Robert Kurtzman, Joseph Nichols, and Adelia Zytek.
"Estimating Aggregate Data Center Investment with Project-Level Data." *FEDS Notes*, Board of
Governors of the Federal Reserve System, 2026.

Brooks, Frederick P., Jr. "No Silver Bullet: Essence and Accidents of Software Engineering."
Technical Report TR86-020, Dept. of Computer Science, University of North Carolina at Chapel Hill,
Sept. 1986, pp. 12, 15. Reprinted in *Computer*, vol. 20, no. 4, Apr. 1987, pp. 10–19.

Brynjolfsson, Erik, Bharat Chandar, and Ruyu Chen. *Canaries in the Coal Mine? Six Facts about the
Recent Employment Effects of Artificial Intelligence*. Stanford Digital Economy Lab, 2025.

---. *Canaries, Interest Rates, and Timing*. Stanford Digital Economy Lab, 2025.

Büchi, J. Richard, and Lawrence H. Landweber. "Solving Sequential Conditions by Finite-State
Strategies." *Transactions of the American Mathematical Society*, vol. 138, 1969, pp. 295–311.

Budzyń, Krzysztof, et al. "Endoscopist Deskilling Risk after Exposure to Artificial Intelligence in
Colonoscopy." *The Lancet Gastroenterology and Hepatology*, 2025.

Burtch, Gordon, Dokyun Lee, and Zhichen Chen. "The Consequences of Generative AI for Online Knowledge
Communities." *Scientific Reports*, vol. 14, 2024, article 10413.

Cai, Tianle, Xuezhi Wang, Tengyu Ma, Xinyun Chen, and Denny Zhou. "Large Language Models as Tool
Makers." *Proceedings of the Twelfth International Conference on Learning Representations*, 2024.

Conway, Melvin E. "How Do Committees Invent?" *Datamation*, vol. 14, no. 5, Apr. 1968, pp. 28–31.

Crick, Francis. "Central Dogma of Molecular Biology." *Nature*, vol. 227, no. 5258, 8 Aug. 1970, pp.
561–63.

del Rio-Chanona, R. Maria, Nadzeya Laurentsyeva, and Johannes Wachs. "Large Language Models Reduce
Public Knowledge Sharing on Online Q&A Platforms." *PNAS Nexus*, vol. 3, 2024.

Dell'Acqua, Fabrizio, et al. *Navigating the Jagged Technological Frontier*. Harvard Business School
Working Paper 24-013, 2023.

Dey, Apratim, and David Donoho. "Universality of the π²/6 Pathway in Avoiding Model Collapse."
*arXiv*, 2024, arxiv.org/abs/2410.22812.

Dohmatob, Elvis, Yunzhen Feng, Arjun Subramonian, and Julia Kempe. "Strong Model Collapse."
*Proceedings of the Thirteenth International Conference on Learning Representations*, 2025.

Feng, Yunzhen, et al. "Beyond Model Collapse: Scaling Up with Synthesized Data Requires
Verification." *Proceedings of the Thirteenth International Conference on Learning Representations*,
2025.

Fonseca, Pedro, Kaiyuan Zhang, Xi Wang, and Arvind Krishnamurthy. "An Empirical Study on the
Correctness of Formally Verified Distributed Systems." *Proceedings of the Twelfth European
Conference on Computer Systems (EuroSys '17)*, ACM, 2017, pp. 328–43.

Gao, Luyu, et al. "PAL: Program-Aided Language Models." *Proceedings of the 40th International
Conference on Machine Learning*, PMLR, vol. 202, 2023.

Geng, Saibo, et al. "Grammar-Constrained Decoding for Structured NLP Tasks without Finetuning."
*Proceedings of EMNLP 2023*, ACL, pp. 10932–52.

Gerstgrasser, Matthias, et al. "Is Model Collapse Inevitable? Breaking the Curse of Recursion by
Accumulating Real and Synthetic Data." *arXiv*, 2024.

Gond, Raja, Aditya K. Kamath, Ramachandran Ramjee, and Ashish Panwar. "LLM-42: Enabling Determinism
in LLM Inference with Verified Speculation." *arXiv*, 25 Jan. 2026, arxiv.org/abs/2601.17768.

Grundy, Adam, and Dhanapati Khatiwoda. "Large Firms with at Least 20 Employees Biggest AI Users."
U.S. Census Bureau, May 2026.

Guo, Daya, et al. "DeepSeek-R1 Incentivizes Reasoning in LLMs through Reinforcement Learning."
*Nature*, vol. 645, no. 8081, 2025, pp. 633–38.

He, Horace, et al. "Defeating Nondeterminism in LLM Inference." *Thinking Machines Lab*, 10 Sept.
2025.

Hood, Amy. Remarks. Microsoft Fiscal Year 2026 Fourth Quarter Earnings Conference Call, 29 July 2026.

Huang, Yuzhen, Weihao Zeng, Xingshan Zeng, Qi Zhu, and Junxian He. "From Accuracy to Robustness: A
Study of Rule- and Model-based Verifiers in Mathematical Reasoning." *arXiv*, 2025,
arxiv.org/abs/2505.22203.

Kaivola, Roope, et al. "Replacing Testing with Formal Verification in Intel Core i7 Processor
Execution Engine Validation." *Computer Aided Verification (CAV 2009)*, Springer, 2009, pp. 414–29.

Karpathy, Andrej. "Software 2.0." *Medium*, 11 Nov. 2017.

Kazdan, Joshua, et al. "Collapse or Thrive: Perils and Promises of Synthetic Data." *Proceedings of
the 42nd International Conference on Machine Learning*, 2025.

Klein, Gerwin, et al. "seL4: Formal Verification of an OS Kernel." *Proceedings of SOSP '09*, ACM,
2009, pp. 207–20.

Kosmyna, Nataliya, et al. "Your Brain on ChatGPT." *arXiv*, 2025, arxiv.org/abs/2506.08872.

Li, Huayu, et al. "Meta's Generative Ads Model (GEM)." *Engineering at Meta*, 10 Nov. 2025.

Liu, Jiawei, Chunqiu Steven Xia, Yuyao Wang, and Lingming Zhang. "Is Your Code Generated by ChatGPT
Really Correct?" *Advances in Neural Information Processing Systems 36*, 2023.

Longpre, Shayne, et al. "Consent in Crisis: The Rapid Decline of the AI Data Commons." *Advances in
Neural Information Processing Systems 37*, 2024.

Macnamara, Brooke N., David Z. Hambrick, and Frederick L. Oswald. "Deliberate Practice and
Performance in Music, Games, Sports, Education, and Professions: A Meta-Analysis." *Psychological
Science*, vol. 25, no. 8, 2014, pp. 1608–18.

McMahan, H. Brendan, and Omkar Muralidharan. "On Calibrated Predictions for Auction Selection
Mechanisms." *arXiv*, 2012, arxiv.org/abs/1211.3955.

Menzies, Tim, William Nichols, Forrest Shull, and Lucas Layman. "Are Delayed Issues Harder to
Resolve?" *arXiv*, 2016, arxiv.org/abs/1609.04886.

Meta Platforms, Inc. "Meta Reports Second Quarter 2026 Results." Exhibit 99.1 to Form 8-K, U.S.
Securities and Exchange Commission, 29 July 2026.

METR. "We Are Changing Our Developer Productivity Experiment Design." *METR*, 24 Feb. 2026.

Microsoft Corporation. *Annual Report on Form 10-K for the Fiscal Year Ended June 30, 2026*. U.S.
Securities and Exchange Commission, 29 July 2026.

Miller, Marshall. "New User Trends on Wikipedia." Wikimedia Foundation, 17 Oct. 2025.

Mirzadeh, Iman, et al. "GSM-Symbolic: Understanding the Limitations of Mathematical Reasoning in
Large Language Models." *arXiv*, 7 Oct. 2024, arxiv.org/abs/2410.05229.

MIT NANDA. *The GenAI Divide: State of AI in Business 2025*. Preliminary Findings, MIT Media Lab
Project NANDA, 2025.

Mitchell, Melanie. *Artificial Intelligence: A Guide for Thinking Humans*. Farrar, Straus and Giroux,
2019.

Monitoring Analytics, LLC. *2026 Quarterly State of the Market Report for PJM: January through
March*. Monitoring Analytics, 2026.

Odlyzko, Andrew. *Collective Hallucinations and Inefficient Markets: The British Railway Mania of the
1840s*. University of Minnesota, 15 Jan. 2010.

OpenAI. "Structured Outputs." OpenAI API Documentation.

Ouyang, Shuyin, Jie M. Zhang, Mark Harman, and Meng Wang. "An Empirical Study of the Non-determinism
of ChatGPT in Code Generation." *ACM Transactions on Software Engineering and Methodology*, vol. 34,
no. 2, Jan. 2025, article 42.

Parasuraman, Raja, and Dietrich H. Manzey. "Complacency and Bias in Human Use of Automation." *Human
Factors*, vol. 52, no. 3, June 2010, pp. 381–410.

Parnas, David L. "On the Criteria to Be Used in Decomposing Systems into Modules." *Communications of
the ACM*, vol. 15, no. 12, Dec. 1972, pp. 1053–58.

Parnas, David L., and Paul C. Clements. "A Rational Design Process: How and Why to Fake It." *IEEE
Transactions on Software Engineering*, vol. SE-12, no. 2, Feb. 1986, pp. 251–57.

Peng, Sida, Eirini Kalliamvakou, Peter Cihon, and Mert Demirer. "The Impact of AI on Developer
Productivity: Evidence from GitHub Copilot." *arXiv*, 13 Feb. 2023, arxiv.org/abs/2302.06590.

Performance-Based Operations Aviation Rulemaking Committee / Commercial Aviation Safety Team, Flight
Deck Automation Working Group. *Operational Use of Flight Path Management Systems*. FAA, 2013.

PJM Interconnection. "PJM Auction Procures 134,479 MW of Generation Resources." News release, 17 Dec.
2025.

---. "PJM Capacity Auction Procures 138,318 MW of Generation Resources." News release, 14 July 2026.

Pnueli, Amir, and Roni Rosner. "Distributed Reactive Systems Are Hard to Synthesize." *Proceedings of
the 31st Annual Symposium on Foundations of Computer Science*, IEEE, 1990, pp. 746–57.

Povyakalo, Andrey A., Eugenio Alberdi, Lorenzo Strigini, and Peter Ayton. "How to Discriminate
between Computer-Aided and Computer-Hindered Decisions." *Medical Decision Making*, vol. 33, no. 1,
2013, pp. 98–107.

Qiu, Libin, Yuhang Ye, Zhirong Gao, Xide Zou, Junfu Chen, Ziming Gui, Weizhi Huang, Xiaobo Xue, Wenkai
Qiu, and Kun Zhao. "Blueprint First, Model Second: A Framework for Deterministic LLM Workflow."
*arXiv*, 2025, arxiv.org/abs/2508.02721.

Reddy, Challaram, and Basu. "Reason Less, Verify More: Deterministic Gates Recover a Silent
Policy-Violation Failure Mode in Tool-Using LLM Agents." *arXiv*, 8 July 2026,
arxiv.org/abs/2607.07405.

Rice, H. Gordon. "Classes of Recursively Enumerable Sets and Their Decision Problems." *Transactions
of the American Mathematical Society*, vol. 74, no. 2, 1953, pp. 358–66.

Ryseff, James, Brandon F. De Bruhl, and Sydne J. Newberry. *The Root Causes of Failure for Artificial
Intelligence Projects and How They Can Succeed*. Research Report RR-A2680-1, RAND Corporation, 2024.

Schaeffer, Rylan, Joshua Kazdan, Alvan Caleb Arulandu, and Sanmi Koyejo. "Position: Model Collapse
Does Not Mean What You Think." *arXiv*, 2025, arxiv.org/abs/2503.03150.

Sculley, D., et al. "Hidden Technical Debt in Machine Learning Systems." *Advances in Neural
Information Processing Systems 28*, Curran Associates, 2015, pp. 2503–11.

SGLang Team. "Towards Deterministic Inference in SGLang and Reproducible RL Training." *LMSYS Org
Blog*, 22 Sept. 2025.

Shen, Judy Hanwen, and Alex Tamkin. "How AI Impacts Skill Formation." *arXiv*, 3 Feb. 2026,
arxiv.org/abs/2601.20245.

Shepard, D., and R. Salimans. "AutomationBench." *arXiv*, 2026, arxiv.org/abs/2604.18934.

Shumailov, Ilia, et al. "AI Models Collapse When Trained on Recursively Generated Data." *Nature*,
vol. 631, 2024, pp. 755–59.

Smith, Sarah J., et al. *United States Data Center Energy Usage Report*. Lawrence Berkeley National
Laboratory, June 2026.

Stack Exchange, Inc. "Questions." Stack Exchange API, version 2.3.

Stanford Digital Economy Lab. "Canaries Dashboard." 2026.

Stanford Institute for Human-Centered Artificial Intelligence. *The 2025 AI Index Report*, Apr. 2025.

Stanković, Miloš, Ella Hirche, Sarah Kollatzsch, and Julia Nadine Doetsch. "Comment on: Your Brain on
ChatGPT." *arXiv*, 29 Dec. 2025, arxiv.org/abs/2601.00856.

United States, Federal Aviation Administration, Flight Standards Service. *Manual Flight Operations*.
SAFO 13002, 4 Jan. 2013.

---. *Manual Flight Operations Proficiency*. SAFO 17007, 4 May 2017.

U.S. Securities and Exchange Commission. EDGAR XBRL company-concept data,
us-gaap:PaymentsToAcquirePropertyPlantAndEquipment.

Vaccaro, Michelle, Abdullah Almaatouq, and Thomas Malone. "When Combinations of Humans and AI Are
Useful: A Systematic Review and Meta-Analysis." *Nature Human Behaviour*, vol. 8, 2024.

Vaswani, Ashish, et al. "Attention Is All You Need." *Advances in Neural Information Processing
Systems 30*, Curran Associates, 2017, pp. 5998–6008.

Villalobos, Pablo, et al. "Position: Will We Run Out of Data?" *Proceedings of the 41st International
Conference on Machine Learning*, 2024.

vLLM Project. "Batch Invariance." vLLM Documentation, 2026.

Wharton, AI at, and GBK Collective. *Accountable Acceleration: Gen AI Fast-Tracks into the
Enterprise*. AI at Wharton, University of Pennsylvania, Oct. 2025.

Willard, Brandon T., and Rémi Louf. "Efficient Guided Generation for Large Language Models." *arXiv*,
2023, arxiv.org/abs/2307.09702.

Woodcock, Jim, Peter Gorm Larsen, Juan Bicarregui, and John Fitzgerald. "Formal Methods: Practice and
Experience." *ACM Computing Surveys*, vol. 41, no. 4, Oct. 2009, art. 19.

Xie, Tianbao, et al. "OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer
Environments." *arXiv*, 2024, arxiv.org/abs/2404.07972.

Xu, Frank F., et al. "TheAgentCompany: Benchmarking LLM Agents on Consequential Real World Tasks."
*Advances in Neural Information Processing Systems 38: Datasets and Benchmarks Track*, 2025.

Yang, Xuejun, Yang Chen, Eric Eide, and John Regehr. "Finding and Understanding Bugs in C Compilers."
*Proceedings of PLDI '11*, ACM, 2011, pp. 283–94.

Yao, Shunyu, Noah Shinn, Pedram Razavi, and Karthik Narasimhan. "τ-bench: A Benchmark for
Tool-Agent-User Interaction in Real-World Domains." *arXiv*, 17 June 2024, arxiv.org/abs/2406.12045.

---

### Notes on sources and provenance

**Format.** Times New Roman 12 pt, double-spaced throughout including Works Cited, one-inch margins,
half-inch first-line indents, right-aligned running head `Murphy 1`, four-line heading block flush
left, title centered in plain title case. Works Cited entries take a hanging indent; tables carry
label and caption above.

**Claims withdrawn across revisions**, kept visible so the revision is auditable: (1) the RAND
failure rate — RAND measured none; (2) the brain-versus-datacentre energy comparison — backwards per
unit of output, since a median Gemini prompt costs about forty-three seconds of a twenty-watt brain
and AI emits 130–1,500× less CO₂e per page than human writers; (3) "non-determinism is a defect, not
immaturity" — refuted by batch-invariant kernels; (4) the wafer/silicon endpoint as a prediction —
business logic has had fifty years and has not moved, and the TPU and Anton accelerate stable
mathematical kernels, not processes; (5) the claim that 70 percent of deployed compute is eliminable
— the 10:20:70 figure is *power capacity*, not compute; (6) Hummingbird's 1200× — the favourable tail
of a distribution in which ~40 percent of pipelines regressed; (7) Pac-Man as evidence for
stabilization — deterministic from the first line, so the direction is inverted; (8) Shannon 1938 as
an inferential step — an existence theorem satisfied by a CPU running an if-statement; (9) the SR
26-2 attestation argument — falsified by the primary text; (10) PAL and LATM as evidence for
extraction; (11) the McMahan calibration layer as exemplar; (12) DELETE as an unconditional
prescription; (13) the Beg et al. citation for condition (iv)'s non-vacuity argument — on inspection
the source does not contain the claim attributed to it (a real arXiv ID and author surname attached to
a paper on a different subject), so the citation is removed outright rather than hedged; (14) the
XCON figures in Section XV — 6,200 rules, roughly half changing annually, four worker-years per year,
and the "difficult to believe R1 will ever be done" quotation — none of the four survived a second
adversarial check against the primary text; replaced with the figure that did (250 rules in 1979 to
on the order of 2,500 within a decade); (15) the clause "invisible to expert readers for eight
months" attached to the Fonseca et al. citation in Section XV — that figure belongs to a different,
unrelated detail in the same source (how long the authors searched for protocol bugs, not how long the
specification-gap bug went undetected) and is removed; (16) the Huang et al. citation's title,
attributed quotation, and the "hybrid beats either alone" characterization — the source's real title
signals a cautionary study of verifier pitfalls, the quotation was a paraphrase presented as verbatim,
and the paired 0.95-to-0.92 recall figure used twice (Section XIII, field-guide commitment 4) is not a
matching comparison in the source; all three are corrected in place rather than repeated unverified.

**Verification status.** The regulatory text (SR 26-2 §I p. 2, §II p. 3, n. 3) was extracted and read
directly from the Federal Reserve's published attachment by this author, as were the NANDA
methodology, the Wharton counter-instrument, the Alphabet Q2 2026 cash-flow figures, and the
batch-invariance work. A first pass credited Bachant and McDermott, Brooks, Klein, Woodcock, Barr,
Yang, Kaivola, Liu, Fonseca and Guo as "verified against primary texts during the refutation pass" —
that was too strong. A second, independent adversarial pass (2026-07-31) re-checked every 2026-dated
arXiv item plus the paper's most load-bearing older citations directly against primary sources, not
secondary summaries. Results: Reddy et al. is accurate in every particular, including the exact
quotation and both p-values. Qiu et al.'s reported figures (35.56% vs. 18.00%, 11 vs. 275 constraint
violations, two production deployments) are accurate; its cited title and one quotation were wrong and
are corrected above. Huang et al. and the Bachant-and-McDermott XCON figures were materially wrong, as
detailed in (14) and (16). Beg et al. turned out to be a hallucinated citation — see (13) — and is
removed. Barr, Yang, Klein, and Liu held up under the same scrutiny. Fonseca et al. is accurate except
for the fabricated-by-conflation detail in (15). The discrepancy between the first pass's "verified"
label and what the second pass actually found is recorded here rather than quietly corrected, because
a verification claim that turns out to be wrong is exactly the kind of thing this paper's method is
supposed to catch.

**The clinical and aviation evidence in Section V is accurate and analogical, not on-topic.**
Povyakalo et al. (mammography), Budzyń et al. (colonoscopy), and the FAA SAFOs all check out against
primary and reliable secondary sources. None of them are studies of software or LLM systems. They
establish that "automation improves the average while degrading the expert" recurs across unrelated
domains — which is what licenses using them as an analogy — and Section V has been edited to say so
explicitly rather than leave a reader to infer it.

**Deliberately excluded.** Hummingbird's 1200× as a characteristic gain; Visa's $25 billion as an
outcome measure; a survey correlating AI use with reduced critical thinking that carries a published
correction and two incompatible correlation tables; a leaked figure for OpenAI's 2025 operating loss;
and vendor-run leaderboard scores, referred to as a trend rather than cited.
