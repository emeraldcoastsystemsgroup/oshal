# OSHAL Quant — go-to-market

> **Not legal advice.** §2 summarises real precedent from real cases and is the *shape* of a
> compliant posture. **A securities lawyer must review this before a single unit is sold.** That is
> not boilerplate — §2 contains a precedent that constrains the product design itself.

---

## 1. Positioning

### The one-sentence pitch
> **Your trading algorithms, your brokerage account, your hardware, your house. Nothing leaves the
> box, and nobody takes a cut.**

### The wedge: they're already paying rent
Retail algo traders currently *rent* the ability to run a strategy 24/7. That rent never stops:

| Today's stack | Cost |
|---|---:|
| Trading VPS (QuantVPS $59.99 → $399.99/mo) | **$720 – $4,800 / yr** |
| Platform subscription (Composer $24-40/mo · Trade Ideas $89-178/mo · Tickeron $60-250/mo) | **$288 – $3,000 / yr** |
| **Forever** | **$1,000 – $5,400 / yr** |

The appliance is **$2,299 once**. Against a modest stack it pays back in ~2.3 years; against a
serious one, in **~6 months** — and then it costs about $8/month in electricity, forever. It's also a
general-purpose AI computer, so the trading rig is arguably free.

### Who buys it
1. **The rent-payer** *(primary)* — already runs an algo on a VPS, already pays $100+/mo, already
   understands the domain. Lowest education cost, clearest ROI, easiest sale.
2. **The privacy self-hoster** — owns an Umbrel or Home Assistant box, refuses cloud on principle.
   Proven to pay $199-$1,099 for the *right to own their own infrastructure*. This is a demonstrated
   willingness-to-pay, not a hypothesis.
3. **The tinkerer-quant** — QuantConnect's 516,400-member community. Wants to *build* strategies,
   not rent someone else's. Buys the BYO tier, then buys the box when they get tired of fighting
   their laptop.

### The white space (verified)
**No preloaded, self-hosted algo-trading appliance exists as of July 2026.** Not on the market, not
even in Umbrel's app store — where the community has *asked* for Freqtrade and never got it. The
adjacent categories all thrive:

- **Home-server appliances** prove people pay to self-host: HA Green $199, Umbrel Home $399-699, Start9 from $1,099.
- **Self-hosted trading software** proves people pay one-time for autonomy: Gunbot lifetime licences **$499-$2,999**.
- **The category is being validated by incumbents right now:** SoFi *acquired* Composer (June 2026, >$28B cumulative volume). Alpaca — the API we target — hit **$100M ARR** with 5M+ accounts. ~45% of retail traders report using automated strategies.

Nobody has bridged the two. That's the lane.

---

## 2. ⚠️ The legal posture (this shapes the product, not just the footer)

### The precedent that matters: *CFTC v. Vartuli* (2d Cir. 2000)
A vendor sold software that **emitted specific buy/sell signals that customers were told to follow
mechanically.** The court held this made the seller an unregistered commodity trading advisor —
and, critically, that mechanical signal output is **not protected speech**.

**Read that again in light of our product: we ship an engine that decides trades and an autopilot
that executes them.** If we ship a *default strategy* and tell people to switch it on, we are
uncomfortably close to Vartuli. This is the single most important finding in this document, and it
changes the design:

### The three rules that follow

1. **We ship an *engine*, not a *strategy*.** The box is execution infrastructure for **the buyer's
   own configuration**. Strategies ship as *documented, editable examples* the buyer must
   deliberately configure and arm — never as a live signal feed we maintain for them.
2. **We never transmit signals, ever.** No hosted service, no push updates that say "buy X." The
   vendor has no channel through which a trade instruction could travel. Our servers do not know
   the customer's positions, because our servers are not involved.
3. **No discretion, no personalization, no per-trade or AUM fee.** The moment we take a cut of
   trades or tailor a recommendation to *your* portfolio, we become an adviser in substance. The
   revenue model in [ECONOMICS.md](./ECONOMICS.md) refuses that money deliberately.

### How the comparables split — exactly on this line

| Company | Registered? | Why |
|---|---|---|
| **Composer** | **Yes — SEC RIA** (CRD 311289) + broker-dealer | Supplies **model portfolios** and holds **limited discretionary authority** to execute and rebalance. Its subscription *is* an advisory fee. |
| **QuantConnect** | No | ToS: *"not an investment advisory service… informational and educational purposes only."* No discretion. |
| **3Commas** | No | All-caps ToS: *"3COMMAS IS NOT A BROKER, FINANCIAL ADVISOR, INVESTMENT ADVISOR…"* |
| **TradingView** | No | Charting/data only; execution runs through the user's own broker. |
| **OSHAL Quant** | **No — by design** | Ships infrastructure. No signals, no discretion, no personalization, no cut. **Must stay on the QuantConnect side of the line.** |

### Brokerage API terms — the appliance model is the *compliant* one
- **Alpaca** expressly contemplates user-granted third-party access (*"solely at My risk"*) and
  supports third-party apps — but a **vendor-hosted** app trading *other people's* accounts needs
  Alpaca's approval.
- **Schwab's** individual developer tier is **personal-use only**: *"API Keys… are unique to you…
  may not provide any third party with access."*

> **This is decisive and it validates the whole concept.** A vendor-*hosted* SaaS driving customer
> Schwab accounts would need a commercial tier and Schwab's approval. **An appliance where the buyer
> registers their own developer app and the keys never leave their own hardware fits both brokers'
> individual-use models exactly.** The hardware form factor isn't just a privacy story — it is the
> *cleanest regulatory posture available.*

### The claims we will not make — enforcement is real and recent
- **SEC "AI-washing"** — Delphia **$225K** and Global Predictions **$175K** (Mar 2024, first of
  their kind); Rimar Capital **$310K** (Oct 2024) for a fake "AI-driven" trading platform.
- **FTC reaches non-advisers** — *FTC v. WealthPress* (Jan 2023): **$1.2M** in refunds plus a
  **$500K** civil penalty for unsubstantiated trading-earnings claims. We do not need to be an
  adviser to get hit for hype.
- **CFTC Rule 4.41** prescribes the hypothetical-performance disclaimer, which must appear in
  *immediate proximity* to any simulated result.

**Therefore, permanently banned from our marketing:**
- ❌ "Beats the market" · ❌ any return projection · ❌ any income claim
- ❌ Backtests shown as if they were live results
- ❌ Overstating the AI (we will *publish that the LLM has ~zero direction skill* — see below)
- ❌ Testimonials about profits

**What we say instead:** *"Here is exactly how it performed in a walk-forward backtest, here are the
assumptions, here is the drawdown, here is everything we tried that failed, and past performance
does not indicate future results."*

---

## 3. The honesty moat (the actual marketing strategy)

Every competitor in this space markets an edge. We market a **method** — and it is genuinely
differentiated because the receipts already exist in the repo:

- **We publish the failures.** The append-only strategy log records that the news-materiality
  scorer made +$96 in-sample and **−$228** on a pre-registered clean period, so it was **killed**.
  That the short strategy has **no edge**. That LLM direction skill is **≈ 0** — *we sell an AI box
  and we will tell you the AI cannot pick stocks.*
- **We retract.** A harness bug was found; every prior performance number was **voided and
  republished lower**. The old flattering numbers stay in the repo, marked void.
- **We publish the lag.** The engine returns **+55.5% over 5.5 years, Sharpe 1.02, −10% max
  drawdown** — which *beats the index risk-adjusted and lags it on absolute return*. We will print
  that on the box, because it is true.

In a category defined by hype and AI-washing enforcement actions, **the credible player wins by
being the one who publishes what didn't work.** That is not a marketing gimmick — it is the only
durable position available, and it happens to be free, because the discipline already exists.

---

## 4. Launch sequence

### Phase 0 — Prove the software (before anything is sold)
Non-negotiable gate: **a real ticket answered with zero cloud keys** on the local model. Until the
appliance can do its job without an internet-connected LLM, there is no appliance. *(Tracked; not
yet green.)*

### Phase 1 — 25 units, build-to-order (the honest test)
- Sell to the **rent-payer** cohort where the ROI math is undeniable.
- **Build-to-order only.** Charge on order, assemble on receipt. Working capital ≈ one unit.
- Channels: the self-hosted communities that already exist — r/selfhosted, r/algotrading, Umbrel and
  Start9 forums, Hacker News (the *open-source + honest-numbers* angle is genuinely HN-shaped),
  QuantConnect's community.
- **Success is not revenue.** Success is: *does the support load fit in 2 hours per unit?* That
  number decides whether this is a business (see ECONOMICS §6).

### Phase 2 — the BYO tier does the scaling
$299 Certified Build. No inventory, no warranty, ~84% margin, and it **hedges the memory shortage**
by moving component-price risk to the customer. Expect most of the profit to come from the tier that
ships no hardware. Let it.

### Phase 3 — only if Phase 1's support number holds
Stock inventory, a second SKU, a fulfilment partner.

---

## 5. Honest go/no-go

**The reasons to do it:**
- Verified white space; adjacent categories all validated; incumbents (SoFi/Composer, Alpaca)
  proving the market.
- The appliance form factor is the **cleanest regulatory posture** available — better than hosted.
- The honesty moat is real, already built, and impossible for a hype-driven competitor to copy.

**The reasons to be careful:**
- **A component-price emergency is underway** (see ECONOMICS §2 — one competitor's box went from
  $1,985 to $4,349). Launching a hardware business into a memory squeeze is genuinely dangerous.
- **Support load is unknown** and it is the number that decides the margin.
- **The Vartuli line is thin.** Ship an engine, never a signal service — and *get a lawyer* before
  taking a dollar.
- **Being first may mean being alone.** No trading appliance exists. That's either white space or a
  verdict.

### The recommendation
**Run Phase 1 as a 25-unit, build-to-order experiment — and lead with the $299 BYO tier, which
requires no inventory, no warranty, and no exposure to the memory crunch.** It tests demand,
support load, and the legal posture for roughly the cost of one machine. If the support number
holds, scale. If it doesn't, you've learned the truth cheaply and the open-source project is
unharmed.

The software stays free and open either way. That is the point, and it is what makes the whole
thing honest.
