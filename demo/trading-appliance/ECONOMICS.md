# OSHAL Quant — unit economics

> **Assumption discipline.** Every figure is either a **verified market price** (with source) or a
> **labelled assumption** with a sensitivity range. Anything needing a supplier quote we don't have
> is marked **[NEEDS QUOTE]** rather than invented.

---

## 1. The uncomfortable finding, up front

**Reselling hardware is a 25-30% margin business, and the base box is publicly priced.** The GMKtec
EVO-X2 (Ryzen AI Max+ 395, 64 GB) sells to anyone for **$1,499**. Any customer can find that in
thirty seconds. So we cannot pretend the box is the value — we have to be honest that we are
charging for *integration, warranty, support, and the software*, and price it where that is
obviously fair.

That leads to the single most important strategic call in this document:

> **Sell the appliance AND sell the option not to buy it.**
> A "Bring Your Own Box" tier — the same software image, certified against the same hardware, for
> **$299** — has ~85% margin, zero inventory, and zero warranty exposure. It is the *better
> business*. The appliance exists for people who want it to just work; the BYO tier exists because
> the software is open source and pretending otherwise would insult the customer.

Most of the profit is likely to come from the tier that ships no hardware at all. That is a
feature, not a bug.

---

## 2. ⚠️ The component-price emergency (read before any other number)

**The 2026 LPDDR5X shortage is actively repricing this entire product category upward, right now.**
This is not a footnote — it is the dominant fact of the business case:

| Box (128 GB) | Late 2025 | July 2026 | Move |
|---|---:|---:|---|
| Beelink GTR9 Pro | $1,985 | **$4,349** | **+119%** |
| Bosgame M5 | $1,699 | **$2,799** | +65% |
| Framework Desktop 128 GB | — | $2,459 | **+23% in one January hike** |
| GMKtec EVO-X2 128 GB | — | $1,999 (sale) | *"price increase coming soon"* — vendor's own banner |

A hardware business launched into a component squeeze can watch its margin evaporate between the
order and the build. **Three consequences, and they shape the entire strategy:**

1. **Price in a memory surcharge clause**, or quote for 30 days only.
2. **The BYO / Certified tier is now the *hedge*, not just the high-margin tier** — it moves
   component-price risk to the customer, who buys the box at whatever the market says that week.
3. **Build-to-order is mandatory**, not merely capital-efficient. Never hold stock in this market.

GMKtec publishes **20% off at 3+ units** and custom quotes at 10+, which is the one thing moving in
our favour. All models below use that published 20%.

---

## 3. Bill of materials

We buy a mature Strix Halo mini-PC and add value. No custom PCB, no tooling, no NRE — the same
model Umbrel and Home Assistant use, and the only sane approach at low volume.

### SKU A — **Quant 64** · retail **$2,299**

| Line item | Cost | Basis |
|---|---:|---|
| Base unit (Ryzen AI Max+ 395, 64 GB / 1 TB) | **$1,119** | GMKtec EVO-X2 64 GB street **$1,399**, less GMKtec's **published 20% at 3+ units** |
| Assembly, imaging, 24 h burn-in | $40 | ~1 h loaded labour |
| Packaging + custom foam + printed risk booklet | $15 | Foam from ~$0.75/pc at 100-500 MOQ |
| 3PL pick & pack | $6 | 2026 norm: $2.75 first item, $3.50-8.00 all-in |
| Shipping (2-3 kg boxed, zone 4, insured) | $25 | $14-18 base after 2026's 5.9% GRI; dim-weight buffer |
| Payment processing (2.9% + $0.30) | $67 | Stripe US |
| Warranty reserve (**2.4%**) | $55 | Warranty Week: US computer-OEM 20-yr accrual average |
| Support reserve (2 h, year 1) | $80 | **The number that decides the business** |
| **Landed cost** | **$1,407** | |
| **Gross margin** | **$892 · 38.8%** | |

### SKU B — **Quant 128** · retail **$3,299**

| Line item | Cost | Basis |
|---|---:|---|
| Base unit (128 GB / 2 TB) | **$1,759** | GMKtec EVO-X2 128 GB **list $2,199**, less 20%. *(Modelled off list, not the $1,999 sale — sale prices don't stack, and the vendor has warned of an increase.)* |
| Assembly / packaging / 3PL / shipping | $86 | |
| Payment processing | $96 | |
| Warranty reserve (2.4%) | $79 | |
| Support reserve | $80 | |
| **Landed cost** | **$2,100** | |
| **Gross margin** | **$1,199 · 36.3%** | |

### SKU C — **Certified Build (BYO box)** · **$299**

| Line item | Cost |
|---|---:|
| Guided setup + certification (1 h) | $40 |
| Payment processing | $9 |
| **Landed cost** | **$49** |
| **Gross margin** | **$250 · 83.6%** | |

Customer buys the GMKtec themselves at retail. We ship the image, the certification, and the
handholding. **This is the highest-margin, lowest-risk product we have.**

### Sensitivity — what actually moves SKU A

| Scenario | Margin |
|---|---:|
| Base case (12% reseller discount) | **27.9%** |
| No discount at all (pay full $1,499 retail) | 20.1% |
| 20% discount (good supplier terms) | 34.2% |
| **Support blows out to 5 h/unit** | **22.7%** |
| Support at 5 h **and** no discount | **14.9%** |

Margin is *robust* to hardware price and *fragile* to support load. Manage support, not COGS.

---

## 3. The wedge: what the customer pays today

This is the honest reason someone buys. Retail algo traders are **already paying rent** to run
strategies 24/7:

| What they pay now | Annual |
|---|---:|
| Trading VPS (QuantVPS Lite $59.99/mo → dedicated $199+/mo) | **$720 – $2,400** |
| Platform subscription (Composer $24-40/mo, Trade Ideas $89-178/mo, Tickeron $60-250/mo) | **$288 – $3,000** |
| **Typical committed spend** | **$1,000 – $5,400 / yr — forever** |

| Appliance | One-time |
|---|---:|
| Quant 64 | **$2,299** |
| Payback vs a *modest* stack (~$1,000/yr) | **~2.3 years** |
| Payback vs a *serious* stack (~$4,500/yr) | **~6 months** |
| Every year after | **$0** (≈$8/mo electricity) |

**And the machine is a general-purpose AI computer**, not a single-purpose trading box — it also
runs the household assistant, voice, and the rest of the swarm. The trading rig is free at that
point.

---

## 4. Year-one contribution per customer

| Line | SKU A buyer | BYO buyer |
|---|---:|---:|
| Product gross margin | $641 | $250 |
| **Quant Club** — support + the research log, $19/mo, ~40% attach | $91 | $91 |
| **Year-one contribution** | **~$732** | **~$341** |

### What we deliberately refuse to sell
No share of trading profits. No AUM fee. No payment for order flow. No signal subscription. No data
resale. Each of those converts a *tool vendor* into a *fiduciary, a broker, or a conflicted party* —
with the registration burden and the misaligned incentive that follows. The legal posture in
[GTM.md](./GTM.md) depends entirely on refusing that money, and so does the honesty of the product.

The $19/mo club buys **support, health monitoring, and the ongoing adversarial research log** — the
same log we publish, including every killed idea. It does **not** buy signals or an edge. Cancel and
the box keeps working forever.

---

## 5. Scale scenarios (12 months)

| | Units | Product GM | Club yr-1 | **Gross profit** | What it demands |
|---|---:|---:|---:|---:|---|
| **Prove it** | 25 appliances + 50 BYO | $22,375 + $12,500 | $6,840 | **$41,715** | One person, evenings, build-to-order |
| **Side business** | 100 + 200 BYO | $64,100 + $50,000 | $27,360 | **$141,460** | ~2 units/wk + a fulfilment partner |
| **Small business** | 400 + 800 BYO | $256,400 + $200,000 | $109,440 | **$565,840** | A real support function; inventory float |

**The binding constraint is working capital, not demand.** 100 units of stock at $1,319 = **$132K
tied up**. Mitigation: **build-to-order** — charge on order, assemble on receipt, 2-3 week lead
time. Honest, slower, and it starts the business with roughly **one unit of working capital**. The
BYO tier needs *none*.

---

## 6. The risks that are actually load-bearing

1. **Support is the margin killer.** People who buy a *trading* appliance will call you when the
   market drops. 2 h/unit is budgeted; 5 h/unit cuts margin nearly in half. This is the number we
   know least about and the one that decides everything.
   *Mitigation:* paper-mode default, ruthless setup simplicity, the risk booklet *before* purchase,
   and a public strategy log that pre-answers "why did it do that?"

2. **We hold no hardware moat.** GMKtec can change price, spec, or supply at will.
   *Mitigation:* the moat is the software, the research discipline, and the community — never
   single-source, stay multi-vendor, and keep the BYO tier so the business survives any vendor.

3. **A customer loses money and blames the box.** Inevitable. Primarily a *product* problem, not a
   legal one: default to paper, gate live behind deliberate arming, refuse to market returns.

4. **The software is free and anyone can self-build.** *Intentional.* We sell assembly, warranty,
   support, and certification. If someone would rather build it themselves — **we want them to**,
   and the docs help. A business that requires its users to be unable to leave isn't worth building.

5. **Category risk: we'd be first.** No trading appliance exists (verified July 2026). That is
   either a wide-open lane or a market that has already voted with its feet. The 25-unit
   build-to-order proof exists precisely to find out cheaply.
