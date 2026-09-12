# Cockpit startup resilience

**Status: open follow-up, observed 2026-09-12.** No startup or pool-handling fix
is implemented by this record. The Career/navigation release recovered and its
native Retry checks passed; the two failures below remain distinct.

## Blocking external scripts

At 18:44:29 UTC, a native Cockpit reload had `readyState: loading`, no parsed body
and no DOMContentLoaded/load timestamp. Parsing had reached the synchronous
jsDelivr marked script after the shared theme bootstrap. A hard refresh restored
the shell. No CDN failure code or persistent service-worker reload loop was
captured.

The [actual shell](../../src/pages/cockpit/index.html) loads marked, Phosphor and
vis-network synchronously from external CDNs in the head, before the body.
The [service worker](../../src/pages/cockpit/service-worker.js) passes cross-origin
requests through. Its update path intentionally reloads an already controlled
page once; first activation does not trigger that reload.

**Remaining:** replace required external startup dependencies with reviewed,
versioned same-origin assets where practical. Marked already has a locked package
dependency and a bundled UMD build; audit the other libraries before choosing
local or optional loading. A `defer` attribute alone is insufficient if required
application boot still waits indefinitely for the external script.

**Done when:** real Cockpit browser tests stall and refuse each external dependency
while the shell, Home/navigation and selected application remain usable within a
bounded interval. Verify actual markdown rendering and supported icon/graph
behavior, fresh installation and service-worker update, saved palette/layout and
the intended single reload. Offline claims require actual cache verification.
Keep the separate [Jarvis Mermaid follow-up](jarvis-voice-and-visuals.md) open.

## Rollout-time database checkout delays

The published core `c1be9d5d` rollout produced these separate observations:

- At 18:46:58 UTC, six API warning/error events reported `timeout exceeded when trying to
  connect`: three authorization-runtime events and one each in Sports refresh,
  queue sweeps and parent assembly. The captured window contained no role-limit
  rejection or new-connection timeout/reset/refusal.
- Three workspace scans completed at 18:47:04–05 after 279.995, 229.694 and 83.155
  seconds, returning 32, 33 and 32 links. Four later scans took 0.630–1.358 seconds
  and returned all 33 admitted links.
- At 18:48:49, native Retry restored the workspace headings
  and 80 Job Board results with the existing filters.

The exact error is pg-pool's pending client-checkout deadline. The
[main pool](../../src/app/composition/app-runtime-factory.ts) uses a ten-second
checkout limit. [Workspace discovery](../../src/app/routes/workspace-navigation-routes.ts)
performs authorization/profile reads serially and does not stop its remaining
scan when the browser abandons the request. These source facts identify places
to measure; they do not establish a connection leak, event-loop stall or the
initial source of pool pressure.

**Remaining:** extend the existing [bot-recreate backlog](../BACKLOG.md#bot-recreate-thundering-herd)
with measured pool wait/occupancy and request lifetimes during fleet startup.
Evaluate stopping abandoned discovery scans, preserve current authorization and
generation checks, and distinguish temporary policy unavailability from a valid
empty result. Do not increase the role limit or merely lengthen browser timeouts
without identifying the bottleneck.

**Done when:** a full fleet recreation against the configured pool budget leaves
authenticated discovery and representative application reads bounded, abandoned
requests stop further scan work, and temporary failure offers a truthful Retry.
Retain the existing bootstrap config-convergence and authentication/rate-limit
acceptance checks.

## Evidence scope

Operator-local, ignored receipts: `temp/career-navigation-native-reload-diagnostic.json`
and `temp/career-navigation-runtime-timeout-summary.json`. The latter retains only
timestamps, durations, counts and error categories. Recovery was observed during
native release acceptance; it does not close either backlog item.
