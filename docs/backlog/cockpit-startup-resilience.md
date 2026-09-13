# Cockpit startup resilience

**Status: local-asset startup slice deployed and verified on 2026-09-12.**
Core `2739e250` serves the locked local assets; a signed-in existing browser tab
reloaded successfully, retained Create and its palette, and confirmed a complete
document, loaded Markdown parser and icon font. The rollout-time database checkout investigation remains
open. The earlier Career/navigation release recovered through native Retry; that
recovery and the startup change are separate checkpoints.

## Blocking external scripts

At 18:44:29 UTC, a native Cockpit reload had `readyState: loading`, no parsed body
and no DOMContentLoaded/load timestamp. Parsing had reached the synchronous
jsDelivr marked script after the shared theme bootstrap. A hard refresh restored
the shell. No CDN failure code or persistent service-worker reload loop was
captured.

At that checkpoint, the [shell](../../src/pages/cockpit/index.html) loaded marked,
Phosphor and vis-network synchronously from external CDNs in the head, before the body.
The [service worker](../../src/pages/cockpit/service-worker.js) passes cross-origin
requests through. Its update path intentionally reloads an already controlled
page once; first activation does not trigger that reload.

**Source change:** the shell now loads marked's existing locked 18.0.2 UMD build
and the regular Phosphor 2.1.2 stylesheet/font from fixed local GET routes under
`/cockpit/vendor/`. The [allowlist](../../src/app/routes/cockpit-vendor-assets.ts)
uses the existing Cockpit session gate and `no-store` policy; it does not expose
arbitrary dependency files. Both packages retain their upstream MIT licenses in
the installed dependency, with package versions and registry integrity recorded in
`package-lock.json`. Phosphor is the only new dependency; no package was upgraded.

The unused parent vis-network preload is removed. No Cockpit code referenced
that global: the supported Mesh screen renders its existing flow cards, topology
and participant tables using local code. This change does not add or replace a
graph engine. Service-worker cache v42 includes the parser, CSS and all four
referenced font formats. Auth/session-expiry and single-update-reload behavior
remain unchanged.

**Verification:** `npm run test:cockpit-startup` runs the actual complete HTML and
boot modules against synthetic HTTP fixtures. Its browser recipe is linked from
the existing **Cockpit appearance** Lab card; that card's live stylesheet GET
does not execute these browser tests. Coverage includes stalled/refused external
requests, the real ticket Markdown renderer, loaded distinct icon glyphs, Mesh
navigation/refresh, fixed authenticated asset bytes, cached assets offline, and
one worker-update reload preserving the palette, layout and focused app. The
unchanged before test failed because no body parsed within three seconds.
The focused command passed **87/87 cases** across four files, including all nine
new browser/HTTP cases; scoped TypeScript, lint and diff checks passed.

The standard preview deployment completed at 21:12:39 UTC with all 35 application
containers healthy. Read-only checks matched all six vendor asset hashes and
confirmed anonymous requests receive HTTP 401. Native receipt:
`temp/create-editor-native-shell.json`; deployment receipt:
`temp/create-editor-core-deploy-readonly-v2.json`.

Cached asset proof is not a claim that live data or every application works
offline. Keep the separate
[Jarvis Mermaid follow-up](jarvis-voice-and-visuals.md) open.

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

During later Create acceptance, the three optional persistence stores positively
reported PostgreSQL enabled after API restart, with no corresponding fallback
events. Two tunnel origin-connection resets at 22:29:57 UTC accompanied failed
browser requests; explicit retries recovered. A subsequent bounded check found
healthy API responses, no PostgreSQL blockers or active transactions, and no
recognized checkout errors in the current API boot. This does not locate every
protected-request delay or close the database investigation. The fixed-category
receipts are `temp/create-editor-latency-read.json` and
`temp/create-editor-latency-log-detail.json`; no pool limits were increased.

The final Create activation at 22:46:12 UTC again enabled all three PostgreSQL
stores without fallback. One subsequent loopback health request timed out at ten
seconds; a bounded follow-up returned HTTP 200 with all 35 containers healthy.
Both outcomes are retained in `temp/create-editor-activation-b92013b4-detail.json`.
Successful editor and Lab acceptance does not close this intermittent-delay work.

During Create 1.6.0 acceptance on 2026-09-13, the API again stalled after an
otherwise successful startup. Retained internal health checks timed out at
00:31:28 and 00:32:06 UTC; the tunnel recorded origin failures matching the
browser's 00:32:16 gateway response. The API retained its container, PID/start
time and zero restarts, with no reported OOM. It recovered without intervention:
health and version returned 200 in 192/183 ms. All three optional PostgreSQL
stores had initialized without fallback. This demonstrates a wider origin/API
interruption, but does not establish its cause or prove a template-route defect.
The immutable incident receipt is `temp/create-templates-native-loading-incident.json`
(SHA256 `f3964679f5eaf87835a2849dda70cfa94516b3e93612a88f2422878e29068887`).
The standalone image editor subsequently completed template selection,
edit/save/reopen and PNG/editable export. Keep the request-stall investigation open.

Scan acceptance on 2026-09-13 adds two distinct observations. A native photo
upload initially returned HTTP 502; a retry returned HTTP 404. The latter was
reproduced with the actual framework identity context: the multipart callback
lost that context before a fresh owner lookup, and the GUC pool correctly denied
the identity-less query. Scan 0.2.2 preserves the callback context; this does not
establish the cause of the earlier gateway failure or broader request delays.
See the [Scan release record](../releases/scan-cad-2026-09-13.md).

The Scan page also awaits an unbounded capabilities request before binding its
New and other controls. Follow up with independent bounded capability loading,
usable initial controls and explicit retry/error feedback. Do not replace an
unavailable response with a false empty result. Native Lab's earlier depth suite
was cancelled at 01:30:58 UTC with no output. Its generic authority/source
wording does not prove a grant changed; that result is not a passing suite.

During the daily-dashboard rollout on 2026-09-13, the native browser displayed
HTTP 524 at **03:41:49 UTC**. A bounded read-only capture at 03:43:32-03:44:00
then measured successful health responses taking 7.271 seconds inside the API,
10.534 seconds through host loopback and 9.877 seconds through the hosted origin.
The PostgreSQL activity read took 128 ms and found zero blocked sessions, with
three sessions idle in transaction for up to nine seconds. API logs included
pool-checkout timeouts. The API retained the same process and container with
zero restarts and no reported OOM during the capture. These observations do not
establish the cause of the delay or close this investigation. Receipt:
`temp/daily-dashboard-startup-incident.json`; the later 35/35 healthy deployment
census is recorded separately in the [release checkpoint](../releases/daily-dashboard-2026-09-13.md).

The 03:47 UTC resource capture observed substantial system CPU/memory pressure
and nearly full Linux swap, without API cgroup throttling or OOM. These are bounded
observations, not a measured root cause. Receipt:
`temp/daily-dashboard-resource-pressure.json`. A later native HTTP 502 at
03:53:49 UTC coincided with another agent's package reload; keep it separate from
the earlier stall on an unchanged process. Native dashboard and Lab acceptance
subsequently passed. At 04:16:02 UTC, a bounded health request returned 200 in
103 ms; that recovery does not close this investigation.

**Next measurement:** trace one correlated authenticated reload across middleware,
pool checkout, SQL duration, main-process event-loop delay and work remaining
after a client disconnect. Current source performs serial workspace authorization
reads with repeated assignment snapshots. The September 13 source correction now
stops subsequent work after client abort or unfinished response close; an already
awaited port may still finish. Thirteen actual HTTP lifecycle cases and twenty-eight
retained authorization cases pass. Normal GET request close does not cancel a
connected response. This bounded fix neither cancels SQL already running nor
establishes the broader origin stall's cause. Deployment is tracked in the
[integration record](../releases/component-integration-2026-09-13.md). Protected
Jarvis assets also pass identity middleware, whereas successful Cockpit static
responses terminate before the later global principal/actor layers. Measure
these paths separately, retain current authorization checks, and record only
timings/counts rather than identity claims or business values. Pool pressure alone
does not explain the slow public health handler, which precedes those layers.

Operator-local, ignored receipts: `temp/career-navigation-native-reload-diagnostic.json`
and `temp/career-navigation-runtime-timeout-summary.json`. The latter retains only
timestamps, durations, counts and error categories. Recovery was observed during
native release acceptance; it does not close the database investigation. The
later local-asset acceptance is recorded above. Local before/after startup
receipts are retained separately under `temp/cockpit-startup-*.log`.
