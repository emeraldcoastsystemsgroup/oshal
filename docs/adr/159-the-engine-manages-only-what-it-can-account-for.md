# ADR-159: The engine manages only what it can account for

Date: 2026-09-15
Status: **Accepted by the operator (2026-09-15); implementation open.**

Related: [ADR-134](134-multi-account-trading-books.md) (books and the autopilot),
[ADR-136](136-trading-surface-information-architecture-and-direct-trades.md) (the trading surface),
[ADR-143](143-market-data-stream.md), the wash-sale basis fix (core #452 and #460), and the
BACKLOG entry "The armed book's stop-loss measures against the venue's adjusted cost basis".

## Context

The engine does not keep its own list of what it owns. It reads the **venue's** positions and manages
whatever it finds there, which means a share bought by hand, outside the engine, is picked up and
traded like any other holding. The only ring-fence is `TRADING_CORE_SYMBOLS=SYM:0`, a per-symbol
environment exemption the operator has to remember to set before buying.

That is how a position the engine never bought acquires an engine decision. Two consequences,
both measured on this box:

- **The basis it would trade against is not its own.** `withEngineCostBasis`
  (`src/app/trading-engine-cost-basis.ts:98`) attaches `engineAvgCost` only when the engine's own
  filled orders **fully cover** the position's quantity; a position it cannot cover is *returned
  unchanged*, and the exit path then measures against the venue's average price. After a wash sale
  the venue's price carries the disallowed loss, so the stop measures against a number the engine
  never paid — the phantom stop-loss the #452 veto addresses for the covered case.
- **It shows up in the numbers as unexplained.** Over the 30 days to 2026-09-15 the live book's
  219 sells price to **−$33.03** on the engine's own fills against **−$9,697.53** stored by the
  venue; four of those sells — all **USO** — have no engine basis at all, because the engine never
  bought the shares it sold. The operator confirmed the cause: *"yes i bought some shares on the
  outside."*

## Decision

**A position the engine cannot account for from its own fills is not managed. It is monitored and
flagged as unmanaged.**

- **"Cannot account for" has one definition, the one already in the code:** a long position with no
  `engineAvgCost` after `withEngineCostBasis` — the engine's own filled orders for that book do not
  cover the quantity held. No new heuristic, no second source of truth.
- **Not managed means the engine emits no order for it**: no stop, no trailing exit, no take-profit,
  no rebalance trim, no autopilot entry that adds to it. The change is **suppressive by
  construction** — it can only prevent orders, never create one — which is what makes it safe to
  ship against a live account.
- **Monitored means it stays fully visible**: it appears in the positions list, its market value
  still counts toward exposure and capital (it is real money at the venue, and hiding it would
  understate risk), and its P&L is shown on the venue's basis with the basis named, because the
  engine has no figure of its own to offer.
- **Flagged means the surface says so in words** — "unmanaged: bought outside the engine" — on the
  position row and anywhere an exit decision would otherwise be shown, so the absence of a stop is
  visible rather than silent.
- **Adoption stays a deliberate act, and this ADR does not build one.** The operator can already
  ring-fence with `TRADING_CORE_SYMBOLS`; a future "adopt this position at a stated cost basis"
  action would be a separate decision, because it means typing in a number the engine will then
  trade against.
- **Partial coverage is not coverage.** Holding 100 shares of which the engine bought 40 is
  unmanaged: there is no honest basis for the other 60, and selling 100 on a 40-share basis is the
  same defect in a different shape.

## Consequences

- USO stops being traded by the engine on this box until its shares are accounted for, and the
  operator sees why on the row rather than discovering it in a fill.
- A position the engine bought and then partly sold outside the engine becomes unmanaged the moment
  the ledger stops covering it. That is intended: the engine should not act on a holding whose
  history it no longer explains.
- The wash-sale veto (#452) and this rule cover different halves of the same risk: the veto
  suppresses a stop whose **loss** is an artifact of the venue's adjusted basis; this rule suppresses
  every decision on a position whose **basis is unknown**. Neither replaces the other.
- Exposure and drawdown keep counting unmanaged holdings, so the autopilot's capital arithmetic is
  unchanged; only the order decisions for those symbols are withheld.
- A ledger-drift bug that wrongly makes a covered position look uncovered would silently stop
  managing it. The flag is what makes that visible, and the count of unmanaged positions belongs in
  the same log line the cost-basis attachment already writes.

## Implementation

| Part | Content | Proof |
|---|---|---|
| Core | `Position.unmanaged` (or an explicit `engineAccounted: false`) set where `withEngineCostBasis` today returns the position unchanged; `exitsToRun`, `trailingExits` and `rebalanceTrims` (`src/features/trading/services/portfolio.ts:208, 282, 312`) skip it; the autopilot entry path does not add to it; the attachment log line carries the unmanaged count | a spec proves each of the three exit functions emits nothing for an unmanaged position and is unchanged for a covered one; a spec proves a partially covered position is unmanaged; red before green |
| Package | the trading surface shows the flag and the reason on the row, and the exit card says "unmanaged" instead of a stop that will not fire | the package's browser case |
| Live | the operator sees USO flagged and no engine order is emitted for it | the coordinator, on the box, after deploy |

The BACKLOG entry "Trading — the engine adopts positions it did not buy" tracks the remaining parts.
