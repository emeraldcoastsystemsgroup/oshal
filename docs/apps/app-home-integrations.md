# Home: application value and connected actions

Status: implementation in progress. This extends the approved configurable Home plan. A Calendar gift suggestion is one example of the application integration model, not the scope of the work.

## Application contract

Each application owns four decisions: the result worth showing, the records that prove it, the next useful action, and the other application that can continue that action. Home composes these declarations from the caller's active application catalog. It does not contain a central table of application names, SQL, or business rules.

Required `dependencies.apps` remain installation dependencies. Optional `integrations.offers` name an application and a versioned receiving action; they do not install or activate anything. A receiving app declares `integrations.accepts` with an owned static surface, a context type, version, and bounded text fields. A matching loaded receiver makes the offer available. An absent receiver is unavailable; a version or context mismatch is incompatible. Loading an app is not proof that its external connection works or that a particular business operation is authorized.

Context handoffs open a reviewable draft. They never submit a message, trade, order, booking, deployment, or generated task. The receiving app validates context and rechecks access to any referenced record before using it. Source text is data, not instructions or authority. Actual execution stays behind the receiving app's existing authorization and confirmation flow. No credentials travel in the handoff. File transfers continue to use ADR-139 artifact exchange, including its owner-scoped handles, rather than copying bytes into context.

## Dashboard behavior

The app's useful result leads the card: a briefing, conversation, pipeline, preview, or work item. Counts and source freshness support that result. Session-only utilities may remain compact launchers with an honest purpose. All applications remain visible by default; display choices persist independently of installation and permissions.

Each update identifies its source and may offer an app-owned detail action or a declared contextual handoff. Only explicitly eligible business updates become highlights. Connection metadata and explanatory disclaimers do not become news merely because they are the first sentence. Suite summaries should expose the distinct work needing attention; page highlights should avoid repeating the entire suite digest.

## Integration assessment required for every application

The store ledger must record: dashboard form; persisted evidence and owner scope; inbound contexts; outbound partners; required versus optional dependencies; prerequisites; exact draft/review destination; and verification state. A proposed partner does not count as an implemented integration. Serious applications require source-backed extraction; the lack of an easy query is not grounds to call them launchers.

Representative work chains to assess and implement include research to opportunity evaluation, communications to follow-up, opportunity to proposal, proposal to approval, approved content to publishing, generated artifact to storage/distribution, and upcoming commitment to preparation. Each chain must preserve provenance and distinguish a suggestion, a draft, a submitted request, and a confirmed result.

## Acceptance

Verify absent/inactive targets, incompatible versions, malformed context, removed dependencies, caller isolation, denied record access, expired handoffs, repeated clicks, and navigation failure. Merely opening Home must not mutate business records or call a provider. Verify real rendered cards and explicit handoffs in the authenticated Home page after deployment. Track extraction, receiving UI, declared integration, tests, and live rollout separately.

## Authoring a context exchange

Receiver declaration (the surface must belong to this manifest):

```yaml
integrations:
  accepts:
    - id: research-idea
      contextType: research-brief
      version: 1
      surface: venture-home
      fields: [title, notes, sourceUrl]
```

Source declaration (an optional loaded partner, not an installation dependency):

```yaml
integrations:
  offers:
    - id: explore-venture
      label: Explore as a venture
      targetApp: venture-plan
      targetAction: research-idea
      contextType: research-brief
      version: 1
```

An entry in the source's declared summary `itemsPointer` returns `{text, detail, integration: "explore-venture", context: {title, notes, sourceUrl}}`. `detail` is supporting text capped at 400 characters. Item-level `sourceUrl` renders a public HTTP(S) evidence link; URLs with embedded credentials are rejected. `highlight: true` opts an ordinary business update into highlights. Existing `fix` links remain confined to the source app. Unavailable/incompatible receivers produce explanatory text; invalid context never enables an action.

The receiver imports `receiveHandoff` from `/cockpit/js/app-handoff.js` and registers `{app, action, contextType, version, fields}` with a callback that fills its existing draft fields. It accepts only its parent's same-origin message, validates the exact contract again, consumes once, and rejects expired contexts. The shell retains context only in memory for at most two minutes and posts it to the selected same-origin frame on load. Context is not written to URLs, storage, preferences, or business tables. Each receiver permits at most 12 named text fields of at most 2,000 characters each. An app may declare at most 24 receivers and 24 offers.

Home fetches a fresh caller-visible active-app plan before staging a handoff. Receiver fields are draft data, never arbitrary execution options. The receiver still authorizes any source-record lookup and subsequent action. Package authors must not send secrets in context.

The active catalog is authoritative after activation changes; the original manifest's `status` is only an installation default. Resolved actions include their owned same-origin surface URL. Home can open that declared surface even when the current ribbon profile does not list a shortcut for it. Summary-provided URLs never choose the receiving surface.

## Execution record

Application screens can now use `mountConnectedActions` and `requestHandoff` from `/cockpit/js/app-workflows.js`. The app supplies context from its selected records or editable controls. The shell verifies the active frame's actual URL against that source's caller-visible manifest surfaces, refreshes the loaded catalog, validates the receiving fields, and opens the destination. Group members and apps without Home summary routes publish their source contracts through `integrationSources`. A stale or internally navigated frame cannot borrow its original iframe URL as source authority.

Summary items may return `actions: [{integration, context}]` for up to four distinct declared actions. The original singular fields remain compatible. The per-card connected-actions preference hides every action. Optional partners remain independent of required installation dependencies.

The next package batch connects native Office and Marketing drafts, selected Venture ideas, and Travel/Shopping/Eats/Rides planning controls. Browser fixtures exercise World → Office → Marketing and Travel → Rides → Eats → Shopping, including the Travel receiver, without executing business actions. Deployment of this batch is recorded separately in the store ledger.

The first implementation adds manifest validation, loaded-partner resolution, caller-visible Home planning, in-memory context delivery, receiving-surface validation, connected-action display controls, source links, supporting evidence and revised card styling. Ordinary metadata no longer becomes a highlight by position. Suite highlights exclude updates already in the page highlights.

Live rollout of core #416/#417 and store #155 installed World/Venture 1.1.0 and verified the World summary (HTTP 200, no partial sources) and available integration. The actual cockpit exposed a missing-ribbon navigation gap that the initial fixture had not exercised. The correction carries the declared destination URL and the browser harness now uses the actual cockpit controller with an empty ribbon. The deployed cockpit-to-Venture click-through passed, including populated source context and zero business writes; the stack passed 35/35 healthy with image parity.

Visual acceptance then found a content-selection defect: recently ingested sports/court stories with old publication dates were being offered as venture ideas. The correction lets the app select up to 16 coverage subjects, bounds each archive scan to 100 saved items, and requires publication within 48 hours. The World package chooses the baseline topics, diversifies its three headlines, and restricts the Venture suggestion to fresh relevant commercial/research titles with public evidence. This is an explicit navigation aid, not a generated opportunity assessment. Detailed Home cards use two grid columns where space permits; compact and mobile cards retain one column. The correction needs its own release acceptance.

World Intelligence supplies an initial archive briefing and optional World → Venture draft handoff. Verification: 36 focused core tests, 15 compiled package tests, TypeScript, scoped lint, package/catalog validation, an authenticated existing-Home rendering check, a real World archive query, and a browser fixture using the actual Home and Venture surfaces. The fixture transfers context on click with zero business writes and no mobile overflow. These checks do not mark the remaining application work orders complete; rollout is recorded separately.
