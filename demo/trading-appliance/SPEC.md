# OSHAL Quant — product & engineering spec

**A private, plug-in AI trading research appliance.** One quiet box on your desk. Your brokerage
account, your API keys, your data, your machine. Nothing leaves the house.

> **Status: DESIGN DOCUMENT.** This is a product spec for a device that does not exist yet. Every
> performance figure quoted here is a measured backtest of the existing OSHAL trading engine on the
> operator's own hardware — not a forecast, not an offer, and not a promise of any return. See
> [GTM.md](./GTM.md) § "The claims we will not make."

---

## 1. What it is (and what it is not)

**It is:** an appliance that runs a *deterministic* algorithmic trading engine plus a local LLM
swarm, against **your own brokerage account**, on hardware **you own**. It is a quant research lab
and an execution rail, packaged so a non-engineer can own one.

**It is not:** a signal service, a managed fund, a copy-trading network, a robo-adviser, or a
"secret AI that beats the market." We never touch your money, never pool accounts, never take
discretion, and never see your positions.

The distinction is the product. Everyone else in this category sells you *their* opinion of the
market, hosted on *their* servers, priced as a subscription that runs forever. We sell you the
machine and the code, once.

---

## 2. The three-engine architecture (the whole thesis)

The reason this fits in a $1,500 box is that the work splits three ways, and only one of them is
expensive. This is the single most important design fact in the document.

| Engine | What it does | Where it runs | Why |
|---|---|---|---|
| **1. Deterministic engine** | Ranking, rotation, sizing, stops, capital caps, order placement | **Local CPU.** No LLM at all. | This is where the edge actually lives. It is TypeScript, it is auditable, it is fast, and it costs nothing to run. |
| **2. Local LLM (20-30B)** | The research grind: signal digestion, backtest sweeps, summarisation, the recursive ticket queue | **Local GPU/NPU** (Strix Halo unified memory) | High volume, latency-tolerant, nobody waiting. Slow tok/s just drains the queue slower. ~$5-10/mo of electricity instead of hundreds in API bills. |
| **3. Frontier model (optional)** | *Writing* new algorithms, revising strategy code, hard reasoning | **The buyer's own $20/mo ChatGPT or Claude subscription**, driven through the harness | Low call volume, high value per call. The buyer already pays for this. We add ~nothing to their bill. |

### The measurement that justifies the split

We ran the experiment. **LLM direction skill on price is ≈ 0 at every embedding dimension we
tested.** The model cannot tell you where the stock goes. What *is* predictable — volatility and
volume, ρ ≈ 0.73 / 0.78 — the deterministic engine already exploits.

So the LLM is deliberately demoted out of the decision path. It digests, summarises, and writes
code. It does **not** pick trades. That is why a cheap local model is sufficient, and it is why we
are not another "AI picks stocks" box — because we tested that premise and it failed.

---

## 3. What's already built (this is not vapourware)

The software is a working system running live today on the operator's own capital:

- **Deterministic engine** — multi-timeframe scan sleeve, gravity-rank rotation sleeve, conviction
  weighting, per-name caps, stop management, capital caps.
- **Broker rails** — Alpaca (paper + live) and Schwab (live) behind a provider interface.
- **Autopilot** — scheduled, regular-hours-only, with a `TRADING_HALT` kill switch and a
  10-minute watchdog (pre-market gap alerts, live-position audit).
- **Backtest harnesses** — four of them, all reusing the live engine's *pure functions* so a
  backtest cannot drift from production behaviour.
- **Swarm** — the multi-agent orchestration platform (bots, ticket queue, cost tracking per call).
- **Daily recap pipeline** — data → deck → video → email, fully automated at 5pm CT.

### The engine's honest numbers

Corrected 5.5-year walk-forward (after a critical harness bug was found and **all prior numbers
were voided and republished** — see §6):

The strategy **currently armed on the author's own capital** — gravity rotation + SPY core, 140-symbol
universe — on the corrected harness:

| Metric | Reference strategy | S&P 500 (same window) |
|---|---|---|
| Return @ 126d | **+20.9%** | +10.1% |
| Sharpe | **2.09** | lower |
| Max drawdown | **10.2%** | ~25% typical |
| Sleeve, full window | **+38.6%** | — |
| Beats SPY at | **21d · 63d · 126d** | — |

**It beats the index on return *and* on drawdown.** And here is what that number does not tell you,
stated as plainly as the number itself:

- **It is one regime.** The 548-day window is a single AI-led bull tape. Nobody has shown this
  survives a bear market, because nobody has tested it in one.
- **The alpha lives in daily rebalancing** — which makes it *slippage-sensitive*. Live fill quality
  is a genuine risk to the edge.
- **Assume worse out-of-sample.** Blended drawdown is estimated at 9-13%; plan for ~15%.

> **This ships as a *worked example*, not as the product.** The buyer writes their own strategies —
> and the legal posture in [GTM.md](./GTM.md) *requires* that we ship an engine rather than a signal
> service. The performance above is evidence that the lab produces real strategies. It is not an
> offer, a forecast, or a promise of any return.

### An earlier engine, for context
A previous configuration (the scan sleeve, before rotation was armed) returned **+55.5% over 5.5
years, Sharpe 1.02, −10% max drawdown** — *lagging* SPY on absolute return while beating it
risk-adjusted. It was superseded on 2026-07-10 when the rotation sweep proved the alpha above. Both
numbers stay in the log, which is what an append-only research record is for.

---

## 4. Hardware SKUs

Built on AMD **Strix Halo** (Ryzen AI Max+ 395) — 16 Zen 5 cores, Radeon 8060S, unified LPDDR5X.
Unified memory is what makes a small quiet box able to hold a real model.

### SKU A — **Quant 64** (the volume product)
| | |
|---|---|
| CPU/APU | Ryzen AI Max+ 395 (16C/32T, 40 CU) |
| Memory | **64 GB unified** (~48 GB addressable by the GPU) |
| Storage | 1 TB NVMe (+ user-expandable) |
| Model class | 20-30B MoE (gpt-oss-20b, Qwen3-30B-A3B) at ~100 tok/s |
| Power | ~120-140 W under load, near-idle most of the day |
| **Retail** | **$2,299** |

Runs the entire stack simultaneously: Docker platform (~20 GB), local 30B (~16-20 GB), always-on
STT, speaker diarisation, neural TTS, ambient Jarvis wake-word, and the trading engine — with
headroom. This is the one most people should buy.

### SKU B — **Quant 128** (the enthusiast)
| | |
|---|---|
| Memory | **128 GB unified** |
| Storage | 2 TB NVMe |
| Model class | Everything above **plus gpt-oss-120B locally** (~40-55 tok/s) |
| **Retail** | **$3,299** |

The 128 GB tier buys two things: a *big* model parked next to the fast one (120B chewing the ticket
queue overnight while the 30B answers you instantly), and enough memory to swallow fat-context
research tasks without juggling.

### SKU C — **Certified Build** (bring your own box) — **$299**
The same software image, certified against the same hardware, for people who would rather buy the
mini-PC themselves. You get the image, the certification, and a guided setup session. **The software
is open source; this tier exists because pretending otherwise would insult the customer.**

### What we deliberately do NOT sell
A $14-18K RTX PRO 6000 workstation. It is 6-7× faster and utterly pointless for one user — the
trading queue is latency-tolerant by design. Recommending it would be taking your money. Likewise a
$4,699 DGX Spark: same speed class as the Quant 128, twice the price, and you'd be paying for CUDA
tooling a trader never touches.

---

## 5. Software stack (what's on the box)

```
┌──────────────────────────────────────────────────────┐
│  Cockpit UI  ·  Jarvis (voice)  ·  Trading dashboard │
├──────────────────────────────────────────────────────┤
│  OSHAL swarm: ticket queue · recursive decomposition │
│               bots · cost tracking · Token Chase     │
├──────────────────────────────────────────────────────┤
│  Deterministic trading engine (TypeScript, no LLM)   │
│  rotation · sizing · stops · caps · watchdog · HALT  │
├──────────────────────────────────────────────────────┤
│  Local LLM (Ollama, 20-30B)   │  Your ChatGPT/Claude │
│  research grind, $0           │  writes algorithms   │
├──────────────────────────────────────────────────────┤
│  Postgres · Redis · ChromaDB · your broker's API     │
└──────────────────────────────────────────────────────┘
```

**Everything is open source (the OSHAL platform is free software).** The appliance is a
convenience, not a lock-in: a buyer can build the same thing themselves from the repo, and we will
help them. We are selling the *assembly, integration, and support*, not a moat.

### Why the ticket system matters here
The queue is **recursive and decomposing** — big tasks split into small ones — and it was built for
slow processing and low memory. That architectural choice is exactly what makes local hardware
viable: thousands of small, latency-tolerant calls are the ideal workload for a cheap local model.
The heaviest real day we ever recorded (1,489 LLM calls, ~$151 of API-equivalent cost) becomes
*electricity* on this box.

---

## 6. The discipline (the real differentiator)

Anyone can ship a backtest. This project has an **append-only strategy log** where no config change
lands without fixed-harness evidence, and where things get **killed**:

- **A harness bug was found** (`resample()` fed the engine time-reversed views). Every prior
  performance number was **voided and republished lower**. The old, flattering numbers are retained
  in the repo, explicitly marked as void.
- **Short strategy: killed.** No edge, after the corrected harness.
- **News-materiality regex scorer: killed.** Made +$96 on 89 trades in-sample; a pre-registered
  clean-period test returned **−$228**, and the kill condition fired. No capital, no shadow mode.
- **LLM price prediction: killed.** Direction skill ≈ 0.

That log ships **with the box**. A product that tells you what *didn't* work is worth more than one
that only shows you the equity curve that did.

---

## 7. Setup experience (target: 20 minutes, no terminal)

1. Plug in power + ethernet. Open `oshal.local` in a browser.
2. Sign in. (Everything is local; the account is yours.)
3. **Connect your broker** — paste Alpaca or Schwab API keys. *Paper mode by default.*
4. **Connect your AI** *(optional)* — one click for ChatGPT or Claude; or run entirely on the
   built-in local model with zero accounts.
5. Watch it paper-trade. Read the daily recap. **Live trading requires an explicit, deliberate
   arming step**, and the kill switch is always one click away.

Ships in paper mode. It stays in paper mode until *you* decide otherwise. We think you should leave
it there for a good long while, and the docs say so.

---

## 8. What ships in the box
- The appliance (assembled, burned-in, updates pre-loaded)
- Quick-start card + the honest-risk booklet (not a disclaimer buried in a EULA — an actual booklet)
- The strategy log, including every killed idea
- 1-year hardware warranty; lifetime access to the open-source software

---

## 9. Open engineering questions (honest backlog)
- **Local-model swap for the analyst leg is not yet proven end-to-end.** The engine and the swarm
  run locally today, but "a real ticket answered with zero cloud keys" is a tracked, unfinished item.
  It must be green before a single unit ships.
- **Fat-context tail:** p90 agentic calls hit ~207K tokens. The recursive decomposition mitigates
  this; the 64 GB SKU may need to route the true tails to the buyer's subscription.
- **Multi-broker certification** beyond Alpaca/Schwab.
- **Appliance packaging:** an installer exists, but the one-download-and-it-runs polish is the gap
  between "installable by the author" and "installable by a customer."
