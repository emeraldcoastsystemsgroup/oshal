# OpenSwarm TradeBox — Product Specification
*(working title; "OSHAL Trading Appliance" internally)*

**One sentence:** a quiet mini-PC you plug in at home that runs a transparent, deterministic
algorithmic-trading engine plus a local AI copilot against **your own brokerage account** — your
API keys never leave your house, the AI grind costs $0 in tokens, and the $20/month ChatGPT or
Claude subscription you already have becomes the strategist that writes and improves your algorithms.

---

## 1. What the buyer gets

| Layer | What it is | Where it came from |
|---|---|---|
| **Hardware** | AMD Ryzen AI Max+ 395 ("Strix Halo") mini-PC, 64GB or 128GB unified memory, 1-2TB NVMe, WiFi/2.5GbE, ~120-160W under load, whisper-quiet | GMKtec EVO-X2 class (Base) / 128GB class (Pro) |
| **Orchestration** | OSHAL / Open Swarm — the open-source multi-agent platform: cockpit UI, ticket queue, bot registry, connector broker, app store | The shipping platform, preloaded |
| **Trading engine** | Deterministic TypeScript engine: momentum rotation (rank + top-N + core holding), stop management, capital caps, full backtester over a 140-symbol universe | Live-proven build (see §4) |
| **AI copilot** | Local 20-30B-class model (Base) or up to gpt-oss-120B (Pro) serving chat, signal digestion, and the recursive ticket queue; the buyer's own ChatGPT/Claude subscription drives algorithm-writing | Measured quality floor: 20-30B handles the reasoning lanes |
| **Voice** | Always-on wake word + streaming STT + neural TTS + speaker diarization — "Jarvis, how did we do today?" | Existing voice stack containers |
| **Daily recap** | Fully automated 5PM market-close video recap: data → generated video → email → archive | The proven recap pipeline |

**Software license: free and open source, forever.** The product is the box, the integration, and
the support. A buyer can clone the repo and build their own — the appliance is for people who value
their weekend.

## 2. The three-lane AI economics (the core insight)

Every AI call routes to the cheapest lane that can do the job:

1. **Local model (the box)** — the volume lane. Signal digestion, chat, summaries, the recursive
   ticket queue. Measured precedent: the single heaviest real trading day was **1,489 LLM calls ≈
   $151 at API prices**. On the box: **$0**, overnight, on