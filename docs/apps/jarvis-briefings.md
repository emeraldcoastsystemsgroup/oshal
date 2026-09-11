# Jarvis briefing preferences

Open **Briefing settings** from Jarvis's task shelf (`/api/jarvis/briefings/settings`). The page lists sources registered by currently active applications that the signed-in account can access. Each source has an enabled switch, an announcement frequency, and a delivery channel. The shared surface theme applies, including daylight mode.

Untouched preferences are enabled, announce as updates arrive, and use voice plus the existing bubble. These defaults apply only to eligible recipients; they never grant application access. An application can declare different defaults. Saving a preference replaces the defaults for that exact issuer/subject and source ID and survives restarts and application version updates.

Frequency means a maximum **announcement cadence**, not the application's collection or scan schedule. Hourly, daily and weekly intervals start when a browser claims an announcement. Updates waiting for a due source are claimed as one batch, so opening Jarvis does not produce individual spoken updates. Concurrent browsers share a transactional delivery cursor. Browser delivery requires Jarvis to be open; voice also requires browser audio permission. Bubble-only does not invoke speech. Main-screen-only updates remain in the task shelf without an automatic bubble or voice announcement. Disabling a source suppresses new queued briefings and hides its pending rows. An explicit request to open an available result is still a user action.

## Package registration

Declare owned sources in the application's manifest and require the kernel capability:

```yaml
uses: [jarvis-briefings]
briefings:
  - id: account-updates
    title: Account updates
    description: New updates prepared by this application.
    sessionId: example-account-updates
```

The framework owns source IDs as `application-name:source-id`. Producer session IDs are globally unique and reserved permanently, including after removal. A package cannot replace another package's source or session. An optional `botAgentId` must belong to the same manifest. Applications with an authorization catalog must declare an owned bot binding; an unbound application-level source is rejected at manifest validation. The bot must also have the appropriate catalog binding and authoritative resource adapter. Delivery rechecks that policy. Protected applications without a catalog require the existing explicit application administrator grant; platform administration alone does not provide business-data access.

Trusted package producers use the existing `saveTaskPending(pool, id, userSub, sessionId, title)` task-store export and must honor its boolean result before calling `finishTask`. A `false` result means suppressed or unavailable delivery. The `jarvis-briefings` capability is the compatibility floor for this return contract. No request may supply an acting issuer, a source owner or a replacement user identity. Ordinary chat ingress rejects registered and retired producer session IDs.

The legacy producer API supplies only a subject. Composition resolves it against current local accounts, enabled native login providers and explicit bridge links. Delivery proceeds only when exactly one active canonical issuer/subject is established. Ambiguous identities are refused. Newly queued source tasks persist that exact issuer and source. Old rows from known source sessions lack issuer proof and are quarantined from the shelf and prompt, including after source removal; the system never guesses their issuer.

## Persistence and lifecycle

Migration `130-jarvis-briefing-preferences.sql` creates durable ownership, preference and delivery cursor tables and adds source/issuer task columns. Runtime bootstrap verifies these before delivery. Control tables use forced RLS and the database wrapper's actual operator value, `on`; routes act through trusted service methods with explicit issuer/subject predicates. An unavailable preference store fails delivery closed.

Sources become available during manifest activation and are reconstructed by active manifest loading after restart. Deactivation immediately retracts application authorization, routes, Lab registrations and local source availability before waiting for persistence. Queued rows from retired sources cannot become ordinary tasks. Rights and active source generation are checked again after lock waits. Claims update task delivery markers and source cadence in one transaction. The browser removes filtered source rows and pending offers from its cache and checks current visibility again before opening a briefing.

Transactions that refresh authority are admitted one at a time per runtime pool so concurrent claims cannot consume every connection while waiting on the same source lock. Source registration and retirement remain independent, and an older activation cannot republish a retired source. The production pool minimum is two connections. Each read-only recipient or permission refresh has a two-second deadline; waiting for transaction admission has a five-second deadline. A saturated or single-connection pool therefore fails the affected operation closed and rolls back instead of pinning its control transaction indefinitely. Late read completion cannot resume that operation or write delivery markers. Database connection and statement timeouts still bound database work; an already-running authority read is not canceled by this service deadline.

## Verification

`npm run test:briefings` runs the registered suites:

- `tests/unit/jarvis-briefing-preferences.spec.ts`: disposable PostgreSQL, migration/RLS, actual task writer and Express routes, lifecycle, exact identities, frequency races, account/source revocation, reserved sessions, visible pagination, small-pool concurrent claims and bounded authority starvation with rollback.
- `tests/unit/jarvis-briefing-browser.spec.ts`: Chromium settings save/reload, shared theme, readable retry errors, channel claims and actual shelf/cache code.
- `tests/unit/jarvis-briefing-identity.spec.ts`: enabled provider/bridge identity resolution and real protected-application policy.

The AI Test Lab scenario `jarvis-briefing-preferences` performs a read-only authenticated catalog probe. It does not change preferences, claim notifications or run a provider. The suites use disposable databases and local HTTP fixtures; no live notification or application collection schedule is exercised.
