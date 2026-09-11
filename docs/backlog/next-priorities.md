# Next ten priorities

Ranked for the operator's 2026-09-10 request. The first three are independent implementation lanes;
the remaining items are queued. Local verification and AI Test Lab registration are part of each
change. No GitHub Actions are required.

| Rank | Outcome | Scope / acceptance | Status |
|---|---|---|---|
| 1 | Installed apps automatically register their smoke tests in AI Test Lab | Reuse existing `smoke:` declarations; identify app/version/case; reconcile activation, reload, update and removal; run through the existing verifier with caller-scoped authority and explicit missing prerequisites. | Implemented; awaiting protected review/promotion |
| 2 | Connector sign-in succeeds across configured themed domains | Keep the provider's fixed callback URL; complete in the initiating browser and identity; reject forged, expired and replayed ceremonies. | Implemented; awaiting protected review/promotion |
| 3 | Multi-store installation has complete source controls | Discover packages across trusted registries; preserve registry/name identity; revoke trust from the page; require explicit confirmation before replacing a package from another source. | Implemented; awaiting protected review/promotion |
| 4 | Dispatched Jarvis specialists can answer from their app's data | A delegated data question reaches the package's deterministic, owner-scoped read and returns the known fixture answer without exposing credentials to the model. | Queued |
| 5 | Nightly tests give useful regression signals | Isolate database-backed alert tests from deployment data, resolve or explicitly disposition persistent failing gates, and prove a local scheduled result. | Queued |
| 6 | Application unit, integration and browser suites register with installation | Settle the richer versioned catalog contract, migrate Portrait Studio and hello-oshal, then work the public and private inventories in their owning repositories. | Queued |
| 7 | Freshly installed bots can immediately receive dispatched work | Seed authoritative runtime configuration from the manifest/persona and prove a clean installation dispatches without hand-created database rows. | Queued |
| 8 | Administrators can invite and disable users from the Users page | Exercise the existing account APIs through the page and prove authenticated non-operators cannot administer accounts or roles. | Queued |
| 9 | First-run provisioning guides a new installation to readiness | Re-enterable trusted-store, app installation and user setup steps; failures identify the affected package and preserve completed steps. | Queued |
| 10 | Users control Jarvis briefings | Discover briefing-capable bots and persist per-user source, frequency and delivery-channel preferences; disabled sources do not brief. | Queued |

The underlying acceptance criteria remain in [the main backlog](../BACKLOG.md),
[application Test Lab registration](app-test-lab-registration.md),
[ADR-147](../adr/147-multi-registry-app-loader.md) and [ADR-148](../adr/148-swarm-root.md).
This ranking does not claim that queued work is implemented or that local tests prove live provider
or production behavior.
