/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Long-form content for the nine platform pages. Prose lives here rather than in the renderer so editing marketing copy never means touching layout code, and numbers are written as %tokens% substituted from the tree-counted totals — the anti-drift rule says a count is generated, never typed, and that has to hold in prose as much as in a stat tile. Honesty labels (`flag`) are part of the content, not decoration: A2A is default-off and self-healing is observe-only, and a page that omitted that would be the over-claiming the same rules forbid.
 */

/**
 * Each topic renders one page under /platform/<slug>/.
 *   promise  — the one line that goes under the H1
 *   facts    — the scannable spec table
 *   sections — the substance, in the order someone evaluating it would ask
 *   flag     — an honesty label rendered next to the title AND on the hub card
 */
const TOPICS = [
  {
    slug: 'cockpit',
    title: 'Cockpit &amp; ribbon',
    kicker: 'The surface',
    promise: 'One shell for every app. The left ribbon is drawn from the app you opened, and the URL decides — never a cached preference.',
    facts: [
      ['Shape source', 'The <code>?app=</code> query parameter, read on every page load'],
      ['Client storage', 'None — no cached app name, deliberately'],
      ['App surfaces', 'Mounted in-page, sandboxed, one message contract to the shell'],
      ['Per-app theming', 'Yes — a package can carry its own look inside the shared chrome'],
    ],
    sections: [
      {
        h: 'Every application surface is a view, not a program',
        body: '<p>An app declares the pages it contributes. The cockpit mounts them inside the shared shell, where the ribbon, the ticket list and the assistant are already present. The app does not have to rebuild any of that, and it cannot accidentally replace it.</p>',
      },
      {
        h: 'The URL is the only source of truth',
        list: [
          '<strong>Nothing is written to browser storage.</strong> An earlier build cached the last-used app name, which poisoned plain cockpit visits with whatever you had opened previously. The fix was to delete the cache, not to add a way to clear it.',
          '<strong>A shape is therefore a link.</strong> Bookmark it, send it to a colleague, point a kiosk at it, put it in a runbook — the cockpit that opens is the one you meant.',
          '<strong>Kiosk and focused modes are supported</strong>, not improvised: a stripped ribbon around a single app is a real configuration, which is what makes a shared screen or a child\'s login workable.',
        ],
      },
      {
        h: 'How a surface talks to the shell',
        body: '<p>App pages mount as in-page views and speak one small message contract: navigate, and tell the ribbon its tools changed. There is no other channel. That boundary is why a third-party package can ship a UI without being able to reach into the rest of the cockpit.</p>',
      },
    ],
  },
  {
    slug: 'connectors',
    title: 'Connectors &amp; the vault',
    kicker: 'Connections',
    promise: '%connectors% hand-audited connector specs ship in the repo. Your token is encrypted per user, and the model never sees it.',
    facts: [
      ['Specs in the repo', '%connectors%, each an auditable YAML definition'],
      ['Token storage', 'Encrypted per user, scoped to the person who granted it'],
      ['Model access to credentials', 'None — a fixed server operation makes the call'],
      ['Registration shapes', 'Two: OAuth client with a fixed callback, or a pasted token'],
    ],
    sections: [
      {
        h: 'The credential never reaches the model',
        body: '<p>Connecting an account is the moment most agent systems quietly hand a credential to a language model and hope the prompt holds. oshal does not. The credential is consumed by a schema-bounded server operation, the call completes outside the model, and only the normalized result is allowed into reasoning.</p><p>That is the whole reason connectors are a platform concern rather than an app concern: an app declares what it needs, and the platform decides what the model gets to see.</p>',
      },
      {
        h: 'What ships, and what that means',
        list: [
          '<strong>%connectors% connector definitions</strong> live as audited specs in the repo — a catalog you can read before you trust it, not a list of logos.',
          '<strong>Per-user encryption.</strong> One person connecting their mail does not give the swarm anybody else\'s mail. The scope is the individual, not the deployment.',
          '<strong>Two registration shapes only.</strong> An OAuth client with a fixed callback, or a pasted access token. Every partner integration follows the same documented path, so adding one is a form to fill in rather than a new design to review.',
          '<strong>No connectors to nowhere.</strong> A connector ships when its token drives a genuinely usable API. Integrations that would need a certification the project does not hold are documented as staged rather than shipped as a dead tile.',
        ],
      },
    ],
  },
  {
    slug: 'queues',
    title: 'Queues &amp; the mesh',
    kicker: 'Work routing',
    promise: 'A request becomes a ticket, a ticket becomes phases, and phases are dispatched to accountable bot identities over durable streams.',
    facts: [
      ['Transport', 'Redis streams with consumer groups, one per agent identity'],
      ['Liveness', 'Per-agent heartbeats'],
      ['Undeliverable work', 'Dead-letter queue you can open and read'],
      ['Default review shape', 'One bot per ticket type; a reviewer is opt-in'],
    ],
    sections: [
      {
        h: 'This is what makes it a swarm rather than a chatbot with plugins',
        body: '<p>Work is durable, addressed to a named identity, and observable while it runs. A request that fails is a ticket in a state you can inspect — not a lost turn in a conversation.</p>',
      },
      {
        h: 'How work is routed',
        list: [
          '<strong>Tickets, not calls.</strong> Scheduled and swarm-initiated work enters a queue with a declared ticket type, and the dispatcher routes it by the workflow that type registered.',
          '<strong>One bot per ticket type, by default.</strong> The persona carries its own quality gate — classification rules, citation rules, the artifacts it must produce. Most work needs no second reviewer bot; a workflow can opt into one with a revision limit when the worker genuinely cannot self-gate.',
          '<strong>Interactive work skips the queue</strong> and calls the owning bot directly — but records its cost against that same bot, so the accounting is identical either way.',
          '<strong>Streams, heartbeats and dead letters.</strong> Each agent reads its own stream with a consumer group and publishes a heartbeat; undeliverable work lands somewhere you can actually look at it.',
        ],
      },
    ],
  },
  {
    slug: 'databases',
    title: 'Databases',
    kicker: 'State',
    promise: 'Four stores, each doing the job it is genuinely better at — and one of them is optional on purpose.',
    facts: [
      ['System of record', 'Postgres — tickets, agents, work items, per-call cost'],
      ['Coordination', 'Redis — agent streams, consumer groups, heartbeats'],
      ['Retrieval', 'Vector store with server-side embedding'],
      ['Relationships', 'Optional graph tier; absent unless configured'],
    ],
    sections: [
      {
        h: 'What lives where',
        list: [
          '<strong>Postgres</strong> — tickets, agents, work items, and the per-call token and dollar table. Row-level security scopes user-owned data to its owner; app-owned domain state is keyed to the user who owns it.',
          '<strong>Redis</strong> — the internal mesh: agent streams, consumer groups, heartbeats and runtime coordination.',
          '<strong>Vector store</strong> — the retrieval corpus, embedded server-side. If a collection is ever missing its embedding function, retrieval degrades to lexical scoring rather than silently returning nothing, which is the failure that is actually dangerous.',
          '<strong>Graph tier</strong> — engine-agnostic, with a per-person and a per-tenant database. For relationship-heavy domains it beats a pile of joins.',
        ],
      },
      {
        h: 'The graph tier is optional, and that is a design decision',
        body: '<p>It is absent unless you configure it, and the graph API answers a plain 503 when it is not there rather than pretending. Relational data stays relational. A new domain graph is ingestion plus queries over the same connector — never a new service — and forcing graph where relational fits is explicitly the wrong call.</p>',
      },
      {
        h: 'Cost is a table, not a log line',
        body: '<p>Per-call tokens and dollars land in the cost table as the work happens, attributed to the bot that spent them. When you ask what an agent cost you last month, the answer is a query against the system of record — not an estimate reconstructed from logs.</p>',
      },
    ],
  },
  {
    slug: 'monitoring',
    title: 'Monitoring &amp; self-healing',
    kicker: 'Operations',
    flag: 'Observe-only by default',
    promise: 'The stack watches itself, files its own incident tickets and does root-cause analysis on them — with the repair still gated on a human.',
    facts: [
      ['Collection', 'Prometheus, Alertmanager and cAdvisor overlay'],
      ['Alert path', 'Fail-closed webhook into real processing tickets'],
      ['Auto-analysis', 'On for container-health rules'],
      ['Auto-repair', 'Built, ships OFF, bounded when enabled'],
      ['Core infrastructure', 'Never ticket-healed, regardless of that switch'],
    ],
    sections: [
      {
        h: 'An alert is a unit of work, not a notification you learn to ignore',
        body: '<p>The monitoring overlay is wired all the way through to the ticket system. An alert becomes a ticket, the ticket gets root-cause analysis, and the analysis reaches an explicit disposition. The loop closes somewhere you can audit.</p>',
      },
      {
        h: 'Noise is handled before dispatch, not after',
        body: '<p>A triage stage does storm consolidation, bundles related alerts behind an ordered root-candidate policy, and applies claim, budget, flap and already-resolved gates. That is the difference between a self-healing system and one bad night turning into two hundred tickets nobody reads.</p>',
      },
      {
        h: 'What is automatic and what is not',
        list: [
          '<strong>Automatic analysis is on</strong> for container-health rules. The swarm investigates without being asked.',
          '<strong>Bounded auto-apply of whitelisted container restarts is built and ships off.</strong> When you do enable it: a per-incident lock, an hourly cap, and verify-after-apply.',
          '<strong>Core infrastructure is never ticket-healed.</strong> The database, cache and API tier stay owned by the watchdog whatever that switch says. A system that can restart its own database is a system that can lose your data at 3am.',
        ],
      },
    ],
  },
  {
    slug: 'harnesses',
    title: 'Model harnesses',
    kicker: 'any-bot',
    promise: '%providers% model providers wired in, hosted or local, on your keys — with a containment boundary that fails closed.',
    facts: [
      ['Providers wired', '%providers%'],
      ['Local endpoints', 'Supported — a laptop-only deployment is a real configuration'],
      ['Model choice', 'Per bot identity, not per deployment'],
      ['Bring-your-own connection', 'Ephemeral; never rewrites the bot default'],
      ['Unattended local CLI execution', 'Refused at the guard'],
    ],
    sections: [
      {
        h: 'Deliberately boring, deliberately strict',
        body: '<p>Reasoning runs on an authorized hosted or bring-your-own rail. Exact external actions do not go through a model at all — they are fixed server operations. Those two sentences are the whole security posture of the model layer, and everything else follows from them.</p>',
      },
      {
        h: 'Why per-bot model choice matters',
        body: '<p>Each bot identity carries its own provider and model. An expensive lane and a cheap lane can run side by side in the same swarm on the same work, and be compared on measured output rather than on preference. Swapping a provider becomes a decision with evidence behind it.</p>',
      },
      {
        h: 'The part most platforms skip',
        list: [
          '<strong>Unattended local CLI execution fails closed.</strong> The CLI harness family remains a typed configuration interface, but running one unattended is refused at the guard rather than sandboxed and hoped for.',
          '<strong>Re-enabling it is audited work, not a flag.</strong> It would require a brokered sandbox with immutable handler generations and exact operation scopes, keeping authentication and connector credentials outside the model-visible process and workspace.',
          '<strong>A caller-supplied connection is ephemeral</strong> — used for that request, then gone. It does not quietly become the bot\'s new default.',
        ],
      },
    ],
  },
  {
    slug: 'remote-nodes',
    title: 'Remote &amp; edge nodes',
    kicker: 'Reach',
    promise: 'A bot is an identity, not a location — and an identity can live on the desktop where your browser is already signed in.',
    facts: [
      ['Node identity', 'A UUID that must match across compose, registry, heartbeat and database'],
      ['Networking', 'Self-hosted private overlay, not public exposure'],
      ['Desktop work', 'Driven step by step, submit gated behind explicit approval'],
      ['Edge client', 'Installable npm package'],
    ],
    sections: [
      {
        h: 'Not every job can run in a data centre',
        body: '<p>Some work needs the machine that already has the session, the camera, the drive or the serial port. Treating those machines as second-class webhook targets is why most agent platforms cannot do this class of work at all.</p>',
      },
      {
        h: 'What makes a remote node first-class',
        list: [
          '<strong>Its identity lines up everywhere</strong> — the same UUID in the compose file, the registry, its heartbeat and the database. That consistency is what lets the queue address it exactly like a local bot.',
          '<strong>Desktop worker nodes run on an operator\'s own machine</strong>, driven step by step, with the consequential action gated behind an explicit approval rather than an autonomous click.',
          '<strong>Remote nodes join over a private overlay network</strong> instead of being exposed to the internet.',
          '<strong>Adding a machine is an install</strong>, not a deployment project — the edge client ships as an npm package.',
        ],
      },
    ],
  },
  {
    slug: 'external-agents',
    title: 'External agents (A2A)',
    kicker: 'Interop',
    flag: 'Shipped, default off',
    promise: 'Agents that are not yours can be given a scoped door into the swarm — and oshal bots can call out through the same protocol.',
    facts: [
      ['Status', 'Built and proven end to end; off in every deployment until enabled'],
      ['Inbound work', 'Becomes a real queued ticket under its own synthetic identity'],
      ['Credentials', 'Per agent, hashed, with capability scopes — no global secret'],
      ['Cost', 'Real or honestly flagged; never a silent zero'],
      ['Internal coordination', 'Stays on the internal mesh, deliberately separate'],
    ],
    sections: [
      {
        h: 'Honest status first',
        body: '<p>The gateway is built and was proven end to end against a real standalone foreign agent. It is off in every deployment until deliberately enabled, and the route is structurally absent until then. What has not happened yet: enabling it on a real deployment, and proving it against a third-party vendor\'s agent rather than a hand-built one.</p>',
      },
      {
        h: 'What it does when you turn it on',
        list: [
          '<strong>Inbound work becomes a real ticket.</strong> A foreign agent\'s request is queued under its own synthetic identity, so budgets, dead-lettering and run tracing apply to it exactly as they do to an internal bot.',
          '<strong>Per-agent credentials and capability scopes.</strong> No shared global secret, and the published agent card is curated by the same access-role policy that governs everything else.',
          '<strong>Cost is real or honestly flagged.</strong> A foreign call never books as a silent zero, because a free-looking integration is how budgets get blown.',
          '<strong>Internal coordination stays internal.</strong> In-swarm bots use the internal mesh; this protocol is for agents outside the trust boundary. The two are not merged for convenience.',
        ],
      },
    ],
  },
  {
    slug: 'security',
    title: 'Security &amp; isolation',
    kicker: 'The wall',
    promise: 'Auth per route, credentials the model never sees, per-user data scoping, and a fail-closed gate between a commit and the public.',
    facts: [
      ['Route authentication', 'Explicit per route, with an inventory test that fails the build'],
      ['Sign-in', 'OIDC providers, or invited login with a second factor'],
      ['Local development', 'Mock identity, so a human can always exercise it'],
      ['Data scoping', 'Enforced at the database, not in application code'],
      ['Publish gate', 'Fail-closed on every push'],
      ['Licence', 'AGPL-3.0-or-later'],
    ],
    sections: [
      {
        h: 'The honest framing',
        body: '<p>This is a self-hosted platform whose security posture is enforced by gates in the pipeline rather than promised in a document. The claims below each correspond to something that fails a build, a push or a request when it is violated.</p>',
      },
      {
        h: 'What is actually enforced',
        list: [
          '<strong>Routes are gated explicitly.</strong> Anything exposing workspace paths, file content, persona detail, model execution or ticket creation must carry authentication — and an inventory test fails the build when a new route quietly does not.',
          '<strong>Data is scoped to its owner at the database level</strong>, so a bug in application code is not automatically a data leak.',
          '<strong>Connector tokens are encrypted per user and brokered</strong>, never handed to a bot environment.',
          '<strong>A publish gate stands between the repo and the world</strong> and is fail-closed on every push. The rule when it fires is to fix the identifier, never to narrow the pattern to the file that tripped it.',
          '<strong>Every fix ships a regression guard in the same change</strong> — and a guard that would pass against a mocked version of the thing that broke does not count as one.',
        ],
      },
      {
        h: 'Sign-in and local development',
        body: '<p>OIDC providers in production, plus an invited-login mode with a second factor for deployments that should not depend on an external identity provider. Local development runs on a mock identity, because a system a human cannot exercise in a browser at handover is a system nobody has actually checked.</p>',
      },
    ],
  },
];

module.exports = { TOPICS };
