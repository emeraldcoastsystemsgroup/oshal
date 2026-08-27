# Multi-account trading books — operating & cutover runbook (ADR-134)

**State as of 2026-08-27:** PR1 (core foundation) + PR2 (per-book strategies) are merged and
deployed flag-off; PR3 (the Accounts & books surface, `intelligent-trades` 1.2.0) is deployed to
the workspace volume. `TRADING_MULTI_ACCOUNT` is **false** — the platform behaves exactly like the
two-book world until the cutover below runs. The ADR is
[134-multi-account-trading-books.md](../adr/134-multi-account-trading-books.md).

## The operator's path to N accounts

1. **Re-connect Schwab with every account consented.** Settings → Connections → Charles Schwab →
   connect, and on Schwab's consent screen **check ALL accounts** (the OAuth grant only ever covers
   what was consented — a grant predating an account cannot see it; live-proven 2026-08-27 when
   discovery on the old grant returned exactly one account). Start the connect from
   `oshal.agenticfederal.us` (the themed-subdomain callback bug). Discovery fires automatically on
   the callback; the Accounts & books tab's "Discover accounts" button re-runs it any time.
2. **Verify the roster.** Trading surface → *Accounts & books*: every account under the login
   should be listed (masked, `…last4`). `login missing` on a row means that Schwab login's
   connection was dropped — re-connect it.
3. **Cut over** (one time, market closed):

   ```bash
   bash scripts/trading-books-cutover.sh          # dry-run — prints every precondition verdict
   bash scripts/trading-books-cutover.sh --arm    # executes
   ```

   The script refuses unless: market closed; zero NULL `book_id` rows on all eight trading tables;
   discovery has run; and the legacy live book links to exactly ONE discovered account
   (`SCHWAB_ACCOUNT_NUMBER` pin match, else the single discovered account). On `--arm` it applies
   migration 125 (side-store PK swaps — without them a second live book's HWM write would raise
   `unique_violation` and the fail-closed breaker would keep the book halted), links the legacy
   book, flips the flag, recreates the api, and health-checks. It **never re-POSTs autopilot
   schedules** — a blind re-POST forks a `--sha24` twin schedule id that double-fires the real
   account (adversarial-review blocker).
4. **Create + arm books.** *Accounts & books* → "Create book…" on an account (born **disabled**) →
   assign a strategy (Strategy Lab → Apply…, or the book's mix editor) → set a capital cap if
   wanted → Enable (explicit confirm). Live trading additionally requires the untouched global
   gates (`TRADING_LIVE_ENABLED` + `TRADING_AUTOPILOT_LIVE`) — per-book enablement never bypasses
   fleet arming.

## Day-2 operations

- **Switching accounts:** the dropdown beside Paper/Live (appears once a non-legacy book exists);
  every view re-scopes instantly. *All accounts* is the consolidated Schwab-style summary.
- **Disable ≠ abandon:** a disabled book takes no NEW risk but keeps protective exits,
  stale-sell frees, and reconcile while it holds positions or working orders (PR1 engine rule).
- **Breaker reset:** *after a deliberate withdrawal/transfer only* — the book's page →
  Reset breaker (confirm-gated, journaled). On real losses the breaker is doing its job.
- **Re-pointing a book at a different account is impossible by design** — the binding is immutable
  once the book has history (a re-point carries the old HWM onto the new account: the
  phantom-drawdown class). A different account is a NEW book.
- **Weekly Schwab re-connect** (the ~7-day refresh token) stays per login. A book whose login
  lapsed fail-closed-skips its fires and shows `login missing` in the roster.

## Rollback

- **Before cutover:** `scripts/oshal-deploy.sh` auto-rollback to the previous image is safe at
  every stage (PR1–PR3 coexist with old code by construction).
- **After cutover:** `TRADING_MULTI_ACCOUNT=false` + roll FORWARD only. Per-book schedules
  hard-skip while the flag is off (they never fall back to the legacy live account), and a
  pre-PR1 image must never run against a post-125 database — its `ON CONFLICT (user_sub, mode, …)`
  reservation targets are gone, which would error every submission including protective exits.

## Deliberately deferred (BACKLOG-tracked, not silent)

- Watchdog per-book beat assertions derived from the books table, and multi-book breakdowns in the
  three host report scripts — required before a SECOND live book runs unattended; the denormalized
  `book_ref` column landed in PR1/PR2 so the scripts keep telling the truth for legacy books today.
- The hardening tail of PR4: `book_id NOT NULL` + legacy mode-index/trigger drops on
  orders/signals/decisions, `SCHWAB_ACCOUNT_NUMBER` env retirement, the config-overrides
  book-less-active CHECK.
- `trading-schedule-dispatch.ts` decomposition (882 code lines — past the 800 threshold it already
  exceeded before ADR-134).

## Known one-time hazards (encountered and fixed during the build)

- Tables created by a superuser spec run are not `ALTER`-able by the api's `oshal_app` role —
  ownership was transferred by hand once (`ALTER TABLE … OWNER TO oshal_app`); migration 124 and
  the runtime rails create them as the right role on any fresh install.
- PowerShell `Set-Content` double-encodes UTF-8 — never use it on manifests (store PR #86 restored
  the bytes; use bash or Edit tooling).
