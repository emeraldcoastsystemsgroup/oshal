# Cockpit startup resilience

**Status: local-asset startup slice implemented in source; publication and native
acceptance pending.** The rollout-time database checkout investigation remains
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

**Remaining:** publish the reviewed source and verify normal installed startup
and an existing-tab update. Cached asset proof is not a claim that live data or
every application works offline. Keep the separate
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

Operator-local, ignored receipts: `temp/career-navigation-native-reload-diagnostic.json`
and `temp/career-navigation-runtime-timeout-summary.json`. The latter retains only
timestamps, durations, counts and error categories. Recovery was observed during
native release acceptance; it does not close the database investigation or serve
as native acceptance of the later local-asset change. Local before/after startup
receipts are retained separately under `temp/cockpit-startup-*.log`.
