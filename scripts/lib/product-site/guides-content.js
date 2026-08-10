/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Content for the two guide pages: installing oshal, and adding an application. NOTE on the worked example's wording: the publish gate's 8th category (2026-07-24) forbids family references on public surfaces, so the example is phrased as an occasion rather than a relationship. Do not reintroduce a `my <relative>` phrasing here — the gate is fail-closed on push and the rule is deliberate. Every factual statement here was researched against the tree and then adversarially re-checked, because the existing install docs turned out to contain several confident falsehoods (README's "default install runs a noop harness" and "asks four questions", INSTALL.md's "44 containers" and "three images", and a first-run URL that a change-log entry had already been written to kill). Numbers that are countable come through %tokens%; the footprint figures are attributed as measured rather than presented as generated. The worked example is told with its ceiling attached — the parts that do not exist are named on the page, not omitted.
 */

/** Requirements a reader must satisfy before step 1. `req` marks a hard prerequisite. */
const INSTALL_REQUIREMENTS = [
  {
    req: true,
    title: 'Docker Desktop, with Compose v2',
    body: 'The installer checks for the <code>docker</code> command, <code>docker compose version</code>, and a running daemon, and stops if any is missing. On Windows it can install Docker Desktop for you through winget.',
  },
  {
    req: true,
    title: '6 GB of RAM for the engine, 10 GB to be comfortable',
    body: 'Measured footprint from the install guide. The bring-up starts bots in small batches specifically because a mass cold start OOM-crashed a 6 GB engine twice — so the minimum is real, not defensive.',
  },
  {
    req: true,
    title: 'About 25 GB of free disk',
    body: 'Images account for roughly 12 GB of that. Allow 40 GB if you plan to build from source rather than pull.',
  },
  {
    req: false,
    title: 'Git — only if you build from source',
    body: 'Pulling prebuilt images needs no git. The from-source mode clones the repo and builds, and checks for git before it starts.',
  },
  {
    req: false,
    title: 'Nothing else',
    body: 'No Node, no Python, no Postgres, no cloud account, no API key to begin with. Everything the platform needs runs in the compose stack.',
  },
];

/** The install paths, in the order a reader should consider them. */
const INSTALL_PATHS = [
  {
    n: 'Path A',
    title: 'macOS or Linux — one command',
    body: 'Downloads the installer and runs it. It asks you three things (which mode, which bundle of apps, and an email for the first account), then does the rest.',
    cmd: 'curl -fsSLO https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.sh\nbash oshal-install.sh',
  },
  {
    n: 'Path B',
    title: 'Windows — double-click',
    body: 'For a machine with no terminal. Download the launcher and double-click it; it fetches the PowerShell installer and runs the same flow, asking only for an email. Windows SmartScreen will warn that the file is unsigned — choose <em>More info → Run anyway</em>.',
    cmd: 'Install-OSHAL.bat',
  },
  {
    n: 'Path C',
    title: 'Air-gapped — from an archive',
    body: 'A prebuilt archive carries the images so the install needs no registry and no network. Both installers detect an archive sitting next to them, or you can point at one explicitly. The archive is several gigabytes and is self-hosted rather than attached to a GitHub release.',
    cmd: 'bash oshal-install.sh --from-archive ./oshal-images.tar',
  },
];

/** What the installer does once you answer its questions. */
const INSTALL_STEPS = [
  {
    h: 'It checks the machine before it touches anything',
    p: 'Docker present, Compose v2 present, daemon actually running. Each is a hard stop with a named reason rather than a failure three minutes into a pull.',
  },
  {
    h: 'It writes a <code>.env</code> with fresh random secrets',
    p: 'Database password, session secret, service secret, remote-client secret — generated per install from the system random source. If a <code>.env</code> already exists it keeps yours and says so. This file is the one thing a fresh clone cannot start without.',
  },
  {
    h: 'It pulls or builds the images and stages the app bundle you chose',
    p: 'Bundles resolve their dependencies and deduplicate, so choosing <code>full</code> and choosing a themed bundle never stage the same package twice.',
  },
  {
    h: 'It brings the stack up in order, not all at once',
    p: 'Infrastructure first and waits for healthy; then the controller, waiting for it to be genuinely up rather than merely answering; then the bot fleet in small batches with a settle between them. Ordering is the difference between a stack that comes up and one that half-starts.',
  },
  {
    h: 'It verifies by capability and fails the install if one is missing',
    p: 'A postflight check asks the readiness endpoint for its named legs — model access, bots, credentials, catalogs, voice in and voice out, database — and reports which one is not ready. A green container count is explicitly not treated as success. If the verifier itself cannot be fetched, the installer says the install is unverified rather than claiming success.',
  },
  {
    h: 'It opens the welcome flow',
    p: 'At <code>http://localhost:35457/welcome</code>. That is the first-run path — the cockpit itself lives at <code>/cockpit/</code> once you are through it.',
  },
];

/** Ports, so a reader knows what is exposed and what is not. */
const INSTALL_PORTS = [
  ['<code>35457</code>', 'Cockpit and API. <strong>The only port bound to all interfaces</strong>, deliberately — it is how another machine joins your swarm. Override with <code>OSHAL_API_PORT</code>.'],
  ['<code>55433</code> / <code>55434</code>', 'Postgres and the time-series database. Bound to <code>127.0.0.1</code> only.'],
  ['<code>56380</code>', 'Redis — the agent mesh. Loopback only.'],
  ['<code>58001</code>', 'Vector store for retrieval. Loopback only.'],
  ['<code>58529</code>', 'Graph tier, when you enable it. Loopback only.'],
  ['<code>8444</code>', 'Code server for the shared workspace. Loopback only.'],
];

const INSTALL_TROUBLE = [
  {
    h: 'A bare <code>docker compose up</code> on a fresh clone will not start',
    p: 'Deliberately. There is no session secret and no default identity mode in a clean checkout, and the controller refuses to boot rather than come up insecure. Run the installer, or write a <code>.env</code> first — that single file is the gap between a clone and a running box.',
  },
  {
    h: 'The cockpit answers on <code>127.0.0.1</code> but not <code>localhost</code>',
    p: 'A stale Windows relay process squatting on the IPv6 loopback. Restarting Docker Desktop does not clear it; killing that process does. The repo carries a runbook for it.',
  },
  {
    h: 'Everything reports healthy but nothing answers',
    p: 'Bring the stack up with the ordered script rather than a bare compose command. After an engine restart containers auto-start in the wrong order, and the controller can come up without its database while still passing a shallow health check.',
  },
  {
    h: 'You want it smaller',
    p: 'The kernel bundle runs the platform without the full bot fleet. You can install app packages onto it afterwards one at a time.',
  },
];

/* ─────────────────────────── adding an application ─────────────────────────── */

/**
 * The worked example. Told with its ceiling attached: steps 1-4 are what happens, and the
 * "where this stops" block names the two places it does not do what the sentence implies.
 * Both were verified in the tree — do not soften either without re-checking.
 */
const FLOWERS = {
  quote: 'On Tuesday, order flowers for the anniversary.',
  intro: 'That sentence is a whole application: a trigger, a task, a decision, and an action that touches the outside world. Here is what it actually looks like on oshal today — including the two places it deliberately stops.',
  steps: [
    {
      h: 'You describe it, in words',
      p: 'Open Workflow Studio and type or dictate the process. An assistant drafts the workflow as a graph on the canvas while you talk, and you refine it by talking — "add an approval before it orders", "check the calendar first". It returns the whole revised graph each turn, so refinement is a conversation rather than a redraw.',
    },
    {
      h: 'You point each step at a bot',
      p: 'Pick from a roster dropdown on each step. This is the one place the canvas asks you to choose rather than infer — you are saying who is accountable for that step, which is what makes the cost and the audit trail land somewhere.',
    },
    {
      h: 'You publish it, and it is live',
      p: 'Publish compiles the canvas into a real executable workflow and loads it into the running swarm — no redeploy, no rebuild. It is scoped to you by default: your workflow, your data, invisible to anyone else on the box.',
    },
    {
      h: 'You give it a trigger',
      p: 'A cron scheduler runs the timed side. You set the recurrence in the scheduler panel and it stores the rule; a runner polls for due work and files a ticket when it fires. The ticket is durable, owned, and visible — not a timer in someone\'s browser tab.',
    },
    {
      h: 'Tuesday: it does the work and then stops',
      p: 'The shopping specialist searches the connected retailer, assembles the basket, and hands you a ready checkout. It does not pay. <strong>Nothing in oshal spends your money</strong> — there is no stored card, no outbound payment rail, and every commerce app in the catalog ends at a confirm-it-yourself handoff. That is a design decision, not a missing feature.',
    },
  ],
  ceiling: [
    '<strong>Saying it to the assistant does not create the trigger.</strong> The scheduler is real and the assistant is real, but they are not wired together yet, and nothing translates "on Tuesday" into a schedule rule. You author the schedule once, in the panel, using a recurrence picker — then the sentence runs on its own every week.',
    '<strong>Nothing completes a purchase.</strong> Shopping, food, rides and travel all stop at a ready handoff you confirm in your own account. If you were expecting a florist charge to appear on a card, that does not exist and is not on the way.',
    '<strong>Times are stored as plain schedule rules with no timezone attached</strong>, so "9am" means 9am in the container\'s clock. Worth knowing before you schedule something that matters at a specific local hour.',
  ],
};

/** The four on-ramps, roughly easiest-first. */
const BUILD_LANES = [
  {
    n: 'Route 1',
    title: 'Describe a bot, answer eight questions',
    body: 'The Bot Forge is a chat. It asks what the job is, what goes in, what comes out, what "good" looks like, what knowledge it needs, what it must talk to, when it should run, and what it is allowed to touch. Then it writes the bot — the persona, the manifest, the tool declarations — and puts it in a tray. You click Inject and it is registered and running. You write no YAML and no code.',
    honest: 'Two of the eight questions want specifics rather than ideas: if your bot must talk to an external service, you supply the endpoint and the credential profile, and you approve the list of tools it may use. It is conversational, not magic.',
  },
  {
    n: 'Route 2',
    title: 'Describe a process, publish the canvas',
    body: 'Workflow Studio is for work with shape — steps, branches, approvals, things happening in parallel. You describe it and the graph is drawn as you talk. Publish compiles it into a live queue on the real execution engine: branches evaluate, parallel steps fan out and rejoin, approval gates suspend the run until a human says continue.',
    honest: 'You pick which bot runs each step from a dropdown, and you need to be signed in — the studio is closed to guest sessions. Composing brand-new agents from a prompt is not built; the canvas orchestrates the bots that already exist.',
  },
  {
    n: 'Route 3',
    title: 'Import a skill you already have',
    body: 'If you have an Agent-Skills <code>SKILL.md</code> from somewhere else, an importer turns it into the same persona-plus-manifest shape as everything else. It is a command-line step, not a chat.',
    honest: 'Security-gated on purpose: bundled scripts are quarantined rather than run, declared tools are translated to platform equivalents and minimized rather than copied, and the result is emitted switched off so a human reviews it before it can do anything.',
  },
  {
    n: 'Route 4',
    title: 'Copy a folder',
    body: 'For anyone who would rather read code than talk to it. The reference example is five files and 332 lines, and only two of those files are actually its own — a manifest and a route. The loader requires exactly two fields in a manifest to accept a package at all.',
    honest: 'This is the route that assumes you can write a small Express handler. The other three do not.',
  },
];

/** What the platform provides so a package author never builds it. */
const BUILD_FREE = [
  '<strong>Login, accounts and per-user data isolation.</strong> Your app receives the signed-in user; their data is scoped to them at the database, not by your code remembering to filter.',
  '<strong>The credential vault.</strong> If your app needs someone\'s mail or bank or calendar, you declare the connector. The token is encrypted per user and consumed by a fixed server operation — your app never holds it, and neither does the model.',
  '<strong>The queue, the workers and the retry story.</strong> Declare a ticket type and long work becomes durable, owned and observable, with a dead-letter queue you can actually open.',
  '<strong>The cockpit shell.</strong> Ribbon, navigation, theming, mobile layout, the assistant. You contribute views; you do not rebuild a shell.',
  '<strong>Cost accounting.</strong> Every model call your bot makes lands in a per-call table attributed to that bot. You get the dollar figure without instrumenting anything.',
  '<strong>Model access.</strong> Your bot names a provider and a model, or inherits the deployment default. Swapping providers later is configuration, not a rewrite.',
];

/** What genuinely still needs a person — stated so nobody is surprised at step four. */
const BUILD_LIMITS = [
  {
    h: 'Credentials are still yours to obtain',
    p: 'If your app talks to a service, somebody registers the app on that service and pastes the credential once. No tool can do that for you, and the platform will not pretend it did — it asks for the exact scopes and the login command up front.',
  },
  {
    h: 'A brand-new external integration is a real piece of work',
    p: 'Reaching a service nobody has wired yet means adding a connector definition and a bounded server operation with its own schema and authorization tests. That is deliberate: it is the boundary that keeps credentials away from the model. Using an integration that already exists is a declaration.',
  },
  {
    h: 'Packed bots run in the shared controller',
    p: 'Which is fine for most jobs. Work that needs isolation, hours of runtime, or its own storage still wants a dedicated node — a hand-edited step today.',
  },
  {
    h: 'There is no draft test-run yet',
    p: 'A workflow becomes testable by publishing it. Publishing is scoped to you and reversible by unloading, so the blast radius is small — but a rehearsal mode is not built.',
  },
];

module.exports = {
  INSTALL_REQUIREMENTS, INSTALL_PATHS, INSTALL_STEPS, INSTALL_PORTS, INSTALL_TROUBLE,
  FLOWERS, BUILD_LANES, BUILD_FREE, BUILD_LIMITS,
};
