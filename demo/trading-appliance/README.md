# OSHAL Quant — a self-hosted AI trading appliance

**A complete product package: spec, unit economics, go-to-market, and a presentation deck.**

> ## ⚠️ Read this first
> **This is a design document for a product that does not exist.** Nothing here is an offer, a
> forecast, a promise of any return, investment advice, or legal advice. Every performance figure is
> a *measured walk-forward backtest* of software that runs on the author's own hardware — hypothetical
> and simulated results have inherent limitations and do not represent actual trading. **A securities
> lawyer must review the legal posture in [GTM.md §2](./GTM.md) before anything is sold.**

---

## The pitch, in one paragraph

Retail algo traders currently **rent** the ability to run a strategy 24/7 — $720–$4,800/yr for a
trading VPS, plus $288–$3,000/yr for a platform subscription, forever. **OSHAL Quant is a quiet
mini-PC you buy once.** It runs a deterministic trading engine plus a local AI swarm against *your
own* brokerage account. Your API keys never leave your house, the AI research grind costs $0 in
tokens, and the $20/month ChatGPT or Claude subscription you already pay for becomes the strategist
that writes your algorithms. Payback against a serious stack: **~6 months.** After that it costs
about **$8/month in electricity**, and it's a general-purpose AI computer besides.

---

## The documents

| Document | What's in it |
|---|---|
| **[deck.html](./deck.html)** | **The presentation.** Open it in a browser — light + dark, self-contained. [Also published here.](https://claude.ai/code/artifact/1a87ecd8-da31-483d-b27f-35ef885e3e7b) |
| **[SPEC.md](./SPEC.md)** | Product & engineering spec: the three-engine architecture, hardware SKUs, software stack, setup experience, honest open questions. |
| **[ECONOMICS.md](./ECONOMICS.md)** | Unit economics: real BOM, margin per unit, sensitivity, scale scenarios — and the component-price emergency that threatens all of it. |
| **[GTM.md](./GTM.md)** | Positioning, the wedge, launch sequence, the legal posture (*CFTC v. Vartuli* and why it shapes the product), and an honest go/no-go. |
| [01-product-spec.md](./01-product-spec.md) | A parallel buyer-facing draft (working title "OpenSwarm TradeBox"), kept as-authored. Its buyer-facing framing informed the final spec. |

---

## The four findings that matter

**1. You're selling the lab, not a strategy.**
The buyer brings their own algorithms. What they're buying is the machine that replaces
$1,000–$5,400/yr of rented VPS + platform subscriptions — a backtest harness, broker rails, an
autopilot with a kill switch, and a local model that grinds research **for free** while their $20
ChatGPT subscription writes the strategies. This is also a legal requirement, not just positioning:
[GTM.md §2](./GTM.md) explains why we must ship an *engine*, never a signal service.

**2. The reference strategy beats the market — and we still publish the caveats.**
The strategy currently armed on the author's own capital (gravity rotation + SPY core, 140 symbols),
on the corrected harness: **+20.9% vs SPY's +10.1% at 126 days, Sharpe 2.09, max drawdown 10.2%** —
beating SPY at 21d, 63d *and* 126d. It beats the index **on return and on drawdown**. What that
number doesn't tell you, stated as plainly: **it's one regime** (a 548-day AI-led bull tape, never
tested in a bear market), **the alpha lives in daily rebalancing** so it's slippage-sensitive, and
out-of-sample drawdown should be assumed worse. It ships as a **worked example**, not as the product.

**2b. The kill list is proof the lab works — not proof the product failed.**
The harness killed a *keyword* news scorer that looked **+$96 profitable** in-sample and lost
**−$228** on a pre-registered clean period. It killed a price-only pop-catcher that was sampling
noise (21,900 signals/week). It found a bug **in itself** — time-reversed data — and forced every
prior number to be voided and republished lower. **A rig that kills bad ideas before they cost you
money is the thing you're actually buying.** (What survived that audit: one FDA headline landed
**66 minutes before an +11.9% move** that every count-based metric missed — so *a model reading the
news, rather than counting it* is the open hypothesis. Untested. We won't sell it as if it weren't.)

**3. The form factor is the compliance story.**
Schwab's individual developer keys are *"unique to you… may not provide any third party with
access."* A vendor-*hosted* SaaS driving customer accounts needs a commercial tier and approval. **An
appliance where the buyer registers their own app and the keys never leave their hardware fits both
Alpaca's and Schwab's individual-use models exactly.** The box isn't just privacy — it's the cleanest
regulatory posture available. *(But see the Vartuli constraint in GTM §2: we ship an engine, never a
signal service.)*

**4. The best business may be the one that ships no hardware.**
The base mini-PC is publicly priced — any customer finds it in 30 seconds. So we don't pretend the box
is the value. Alongside the appliance we sell a **$299 Certified Build** (bring your own box): ~84%
margin, zero inventory, zero warranty — and it **hedges the 2026 memory shortage** by moving
component-price risk to the customer. Expect most of the profit to come from it. That's a feature.

---

## The numbers at a glance

| | Quant 64 | Quant 128 | Certified Build |
|---|---:|---:|---:|
| Retail | **$2,299** | **$3,299** | **$299** |
| Landed cost | $1,407 | $2,100 | $49 |
| **Gross margin** | **$892 · 38.8%** | **$1,199 · 36.3%** | **$250 · 83.6%** |
| Local model | 20–30B @ ~100 tok/s | + gpt-oss-120B | (buyer's box) |

**Verdict:** run a **25-unit, build-to-order** experiment and lead with the $299 tier. It tests
demand, support load, and the legal posture for roughly the cost of one machine. **Success isn't
revenue — it's finding out whether support fits in two hours per unit**, which is the number the
entire margin depends on. If it holds, scale. If not, you learned cheaply and the open-source project
is untouched.

---

## Status

**Not built. Not sold. Not offered.** The *software* is real, open source, and running live; the
*appliance* is this proposal. The one hard gate before any of it: **a real ticket answered with zero
cloud keys on the local model** — tracked in the backlog, not yet green.
