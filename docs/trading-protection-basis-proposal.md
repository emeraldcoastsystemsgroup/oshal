# Trading protection-basis correction — review proposal

This proposal changes the legacy protection engine still running alongside the native
kernel. It does not add native real-money execution or alter arming, grants, risk-policy
thresholds or broker configuration. Do not merge/deploy it into live protection until the
operator reviews the concrete behavior below. The new kernel's Trading read adapters and
paper engine are separate paths.

`withEngineCostBasis` attests `engineAvgCost` only when the caller/book's actual filled
orders explain the entire held quantity. A successful replay with missing/partial coverage
marks the position unmanaged. The new pure `protectionCostBasis` selects that positive
finite covered cost, otherwise the positive finite venue average. The venue average and
reported P&L remain intact for display.

Take-profit and trailing gain use the covered economic basis. New peak floors use the
same basis. Covered take-profit requires a valid current quote; it does not infer a price
from a venue tax-adjusted unrealized P&L. Without coverage, the existing venue P&L fallback
is retained. Unmanaged positions still emit no managed exits. The existing database-read
failure fallback remains unchanged; this proposal does not decide that separate policy.

The stop-loss decision retains the existing suppress-only wash-sale safeguard: it can
veto a venue-triggered stop but does not create an engine-basis stop the venue did not
request. A vetoed venue stop can now be followed by a legitimate economic take-profit.

Examples below use synthetic ten-share positions and the unchanged active policy: 8%
take-profit, 5% trail arm and 3% giveback. Stop-loss remains 5%.

| Venue average | Covered engine cost | Current / prior peak | Existing result | Proposed result |
| --- | --- | --- | --- | --- |
| 130 | 100 | 110 / none | Venue stop vetoed; no exit | Take-profit at +10% economic gain |
| 80 | 105 | 110 / none | Take-profit on venue gain | Hold: economic gain is below 8% |
| 130 | 100 | 106 / 110 | No trailing exit on venue loss | Trailing exit at +6%, 3.64% giveback |
| 130 | 100 | 106 / no stored peak | Peak initialized to 130 | Peak initialized to observed 106 |
| 130 | 100 | 94 / none | Real stop-loss | Same real stop-loss |
| 90 | 100 | 94 / none | No venue-triggered stop | Same: no newly created stop |
| 130 | Partial or missing replay | 110 / any | Unmanaged; no exits | Same unmanaged exclusion |

Existing stored positive finite peaks are retained. The old schema records no provenance
that distinguishes an actual observed high from a former venue-basis floor, so lowering
old peaks automatically would guess. This proposal does not migrate them. Closing a
position prunes its peak through the existing store; a replacement entry starts from its
fresh covered cost. Any historical peak repair needs separate evidence and review.

Current-price arming, thin-session multipliers, volatility scaling, plan-specific exits,
cap trims and exit priority remain unchanged. In particular this proposal does not fix or
redefine whether an earlier peak permanently arms a trailing exit.

Run the registered regressions with one worker:

```sh
node node_modules/vitest/vitest.mjs run --pool=forks --maxWorkers=1 --no-file-parallelism \
  tests/unit/trading-protection-basis.spec.ts \
  tests/unit/trading-protection-basis-postgres.spec.ts \
  tests/unit/trading-engine-cost-basis-postgres.spec.ts \
  tests/unit/trading-wash-sale-adapter-boundary.spec.ts \
  tests/unit/trading-portfolio.spec.ts \
  tests/unit/trading-vol-scaled-trailing.spec.ts \
  tests/unit/test-lab-trading-parity-registration.spec.ts
```

The PostgreSQL suites start and remove their own disposable containers; they never read
a deployment DSN. The new integration uses real fill replay, book/owner filters, dispatch
and peak SQL. Market bars are an explicit empty fixture; no provider calls or orders are
placed. Pure and disposable-database suites are registered in the legacy Test Lab's
Trading card and isolated nightly regression. Native Vitest/core runner support remains
separate pending work; registration is not a native execution receipt.
