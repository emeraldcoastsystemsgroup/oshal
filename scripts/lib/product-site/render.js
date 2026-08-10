/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Renderers for the multi-page product site: catalog hub, shelf pages, one page per application, platform hub, one page per platform topic. Content is baked into static HTML rather than rendered from a JSON island by client script — a catalog that only exists after JavaScript runs is invisible to search, to link previews and to anyone who opens the page with a flaky connection, which is a large part of why a single-page version of this reads as a brochure instead of a product site.
 */

const { page, esc, APP_HOST } = require('./theme');
const { TOPICS } = require('./platform-content');
const { renderOrb, SHELF_HUE } = require('./orb');

/** Site-absolute URLs. One place, so a path change cannot half-happen across seventy pages. */
const url = {
  productHub: '/product/',
  shelf: (slug) => `/product/${slug}/`,
  app: (name) => `/product/apps/${name}/`,
  platformHub: '/platform/',
  topic: (slug) => `/platform/${slug}/`,
  install: '/install/',
  build: '/build/',
};

/** Counts are substituted into prose so no number is ever typed into copy. */
const fill = (text, counts) => String(text).replace(/%(\w+)%/g, (_, k) => (
  typeof counts[k] === 'number' ? counts[k].toLocaleString('en-US') : '—'
));

const originBadge = (app) => (app.origin === 'kernel'
  ? '<span class="badge core">Core</span>'
  : '<span class="badge">Store</span>');

/** The card used on the hub, on shelf pages and in "related" strips. */
function appCard(app) {
  return `<a class="card" href="${url.app(app.name)}">
      <span class="top"><span class="tag">${esc(app.shelf ? app.shelf.label : '')}</span>${originBadge(app)}</span>
      <h3>${esc(app.title)}</h3>
      <p>${esc(app.summary)}</p>
      <span class="more">Learn more &rarr;</span>
    </a>`;
}

function bulletList(items) {
  return `<ul class="bullets">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

/**
 * A framed, captioned screenshot. `src` is a same-origin path under /assets (the main site deploy
 * stages those), so nothing external loads. Only real, vetted captures are passed here — never a
 * mock-up, and never a surface that shows real user data.
 */
function figure(src, alt, caption) {
  return `<figure class="shot">
      <div class="frame"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></div>
      <figcaption>${caption}</figcaption>
    </figure>`;
}

/**
 * The vetted, already-public cockpit captures reused across the site, keyed by a short id. Each is a
 * structural UI shot with no personal data — the same five that ship on the home page. Adding an
 * entry here is the only place a screenshot is declared, so a page can never reference one that was
 * not deliberately cleared.
 */
const SHOTS = {
  connectors: ['/assets/cockpit-connectors.png', 'The oshal connector marketplace', '<b>The connector marketplace.</b> Search the audited catalog, enable only what you need, and keep every token user-owned.'],
  connectorGovernance: ['/assets/cockpit-connector-governance.png', 'Connector governance cards', '<b>Every connector is a readable spec.</b> Enablement state, auth shape, and read/write scope — audited before you trust it.'],
  ops: ['/assets/cockpit-ops-dashboard.png', 'The oshal operations dashboard', '<b>The ops dashboard.</b> Runtime health, the process-flow snapshot, and the per-agent health registry, read from live APIs.'],
  workflow: ['/assets/cockpit-workflow-studio.png', 'The Workflow Studio canvas', '<b>Workflow Studio.</b> A real branching canvas — intake, an approval gate, a parallel split, verify and review — compiled to a live queue on Publish.'],
  world: ['/assets/cockpit-world-intelligence.png', 'The World Intelligence surface', '<b>Bias-aware sentiment.</b> Each tracked subject scored across political and economic axes and by outlet kind — a naive average would mislead.'],
  littleMonsters: ['/assets/app-little-monsters.png', 'The Little Monsters student dashboard', '<b>Learning, grounded in the class.</b> Join a class, record a lecture, and get a replay, flashcards and a tutor from it — shown here with open demo classes.'],
  finance: ['/assets/app-finance.png', 'The Finance app', '<b>Your money in one view.</b> Balances, holdings and spending across every linked account, with a plain-English brief. Shown on demo data — reading is read-only.'],
  dnd: ['/assets/app-dnd.png', 'The Dungeon Master campaign shelf', '<b>Pick a campaign and play.</b> An AI Dungeon Master runs a cinematic shared board — investigations remember clues, battles share the same visible turn and dice.'],
};
const shot = (id, section) => (SHOTS[id] ? `${section ? '<section><div class="wrap">' : ''}${figure(...SHOTS[id])}${section ? '</div></section>' : ''}` : '');

/** App pages that have a real, safe screenshot, keyed by app name → SHOTS id. */
const APP_SHOTS = { world: 'world', 'little-monsters': 'littleMonsters', finance: 'finance', dnd: 'dnd' };

/** Numbered "what actually happens" flow. Each step is a claim the manifest supports. */
function flowList(steps) {
  return `<ol class="flow">${steps.map((s, i) => `<li>
      <span class="step">${String(i + 1).padStart(2, '0')}</span>
      <div><h3>${s.h}</h3><p>${s.p}</p></div>
    </li>`).join('')}</ol>`;
}

/** `resume-generation` → `resume generation`, for use inside a sentence. */
const humanize = (cap) => String(cap).replace(/[-_]/g, ' ').trim();

/**
 * The three ways work reaches an application, narrated from what it actually declares. An app that
 * registered no ticket type does not get told it "runs unattended" — the shape flags gate each step.
 */
function activationFlow(app) {
  const s = app.shape || {};
  const steps = [];

  if (s.surfaces) {
    steps.push({
      h: 'You open it, or the assistant does',
      p: `Opening <code>?app=${esc(app.name)}</code> loads its ${s.surfaces} screen${s.surfaces === 1 ? '' : 's'} into the shared cockpit`
        + `${app.defaultView ? `, starting on <code>${esc(app.defaultView)}</code>` : ''}. `
        + 'The ribbon, the ticket list and the assistant are already there — the app contributes views, not a second application to log into.',
    });
  }
  if (s.conversational) {
    steps.push({
      h: 'Or you just ask',
      p: 'The assistant classifies what you asked for and hands it to the bot that owns that domain. '
        + 'You do not pick the app, and you do not learn a command — routing is by declared capability, not by keyword matching a menu.',
    });
  }
  if (s.bots) {
    const names = app.bots.map((b) => `<code>${esc(b.name)}</code>`).join(', ');
    steps.push({
      h: 'A named bot picks it up',
      p: `${names} ${app.bots.length === 1 ? 'is' : 'are'} accountable for the work. `
        + `${s.capabilities ? `${s.capabilities} declared capabilities say what it is trusted to do; ` : ''}`
        + 'the tokens and dollars it spends are recorded against that identity, so the cost has a line item rather than disappearing into a monthly bill.',
    });
  }
  if (s.connectors) {
    steps.push({
      h: 'It reads your accounts without ever holding the keys',
      p: 'The connector call happens in a fixed server operation outside the model. '
        + 'Only the normalized result reaches reasoning — the token stays encrypted and scoped to you.',
    });
  }
  if (s.queued) {
    steps.push({
      h: 'Longer work becomes a ticket',
      p: `Scheduled and swarm-initiated work enters the queue as a <code>${esc(app.ticketType)}</code> ticket. `
        + 'It is durable, it has an owner, you can watch it move through its phases, and if it fails it fails somewhere you can open and read.',
    });
  }
  steps.push({
    h: 'The result lands where you can check it',
    p: s.surfaces
      ? 'Back on the app\'s own screens, as state you own — not as a chat message you have to scroll back to find.'
      : 'As state keyed to you in the platform\'s store, which the assistant can then answer questions about.',
  });
  return steps;
}

function factTable(rows) {
  return `<div class="facts">${rows.map(([k, v]) => `
      <div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
    </div>`;
}

/* ────────────────────────────── catalog hub ────────────────────────────── */

function renderProductHub(model) {
  const { counts, shelves, apps } = model;
  const shelfCards = shelves.map((shelf, i) => `<a class="shelfcard" style="--sh:${SHELF_HUE[shelf.id] || '#94A3B8'}" href="${url.shelf(shelf.slug)}">
      <span class="n">${String(i + 1).padStart(2, '0')} — ${shelf.apps.length} app${shelf.apps.length === 1 ? '' : 's'}</span>
      <h3>${esc(shelf.label)}</h3>
      <p>${esc(shelf.blurb)}</p>
      <span class="names">${esc(shelf.apps.slice(0, 5).map((a) => a.title).join(' · '))}${shelf.apps.length > 5 ? ' …' : ''}</span>
      <span class="more">Browse ${esc(shelf.label.toLowerCase())} &rarr;</span>
    </a>`).join('\n    ');

  // A hub that only lists shelves makes a visitor click twice before seeing a single real app.
  const featured = ['career-hunter', 'email-summarizer', 'presentations', 'home', 'finance', 'video']
    .map((n) => apps.find((a) => a.name === n)).filter(Boolean).slice(0, 6);

  const body = `
${renderOrb(model)}

<section><div class="wrap">
  <p class="lede" style="max-width:44em">oshal is an orchestration platform for agentic AI. The platform
    underneath never changes: a cockpit, a queue, a set of databases, a connector vault, and accountable
    bot identities that do the work. <strong>Applications are what you install on top</strong> — each one
    a packaged bot with its own screens, its own connectors and its own domain.</p>
  <div class="cta-row">
    <a class="btn primary" href="#shelves">Browse by what you need</a>
    <a class="btn" href="${url.platformHub}">See the platform underneath</a>
  </div>
  <div class="stats">
    <div><div class="n">${counts.apps}</div><div class="l">Applications</div></div>
    <div><div class="n">${counts.shelves}</div><div class="l">Shelves</div></div>
    <div><div class="n">${counts.connectors}</div><div class="l">Connector specs</div></div>
    <div><div class="n">${counts.providers}</div><div class="l">Model providers</div></div>
    <div><div class="n">${counts.personas}</div><div class="l">Bot personas</div></div>
  </div>
</div></section>

<section id="shelves"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">The shelves</p>
    <h2>Pick the job, not the technology.</h2>
    <p class="lede">Applications are grouped by <strong>who they serve</strong> — never by which model or
      connector they happen to use. An app bundles the bots, the connector permissions, the ticket types
      and the screens it needs, and installs as one unit.</p>
  </div>
  <div class="grid two">
    ${shelfCards}
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Start here</p>
    <h2>Six that show what the platform is for.</h2>
    <p class="lede">Different shelves, same rails underneath — each one owns its data, its bots and
      its screens, and each one is a real page with the whole story.</p>
  </div>
  <div class="grid">
    ${featured.map(appCard).join('\n    ')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Spotlight — learning</p>
    <h2>Built for the kitchen table, not just the desk.</h2>
    <p class="lede">The same platform that runs an incident queue runs a study companion for a
      12-year-old. <strong>Little Monsters</strong> turns a recorded lecture into a replay, flashcards
      and a tutor — every answer grounded in that class's own material, so it can cite where it came
      from instead of guessing.</p>
  </div>
  ${figure(...SHOTS.littleMonsters)}
  <div class="grid" style="margin-top:22px">
    ${['little-monsters', 'youtube-kids'].map((n) => apps.find((a) => a.name === n)).filter(Boolean).map(appCard).join('\n    ')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Opening one</p>
    <h2>One app, one shelf, everything, or just the assistant.</h2>
    <p class="lede">The cockpit is shaped by the URL, and the URL is the only source of truth — nothing
      is cached into your browser to poison the next visit. A shape is a link.</p>
  </div>
  ${factTable([
    ['<code>/cockpit/</code>', 'The framework default — tickets, chat, calendar, dashboard, shaped by what you are authorized for.'],
    ['<code>?app=&lt;name&gt;</code>', 'One application, full screen: its ribbon, its surfaces, its ticket list pre-filtered to the types it registered.'],
    ['<code>?app=life</code>', 'A shelf as one desk. Real apps whose job is to gather related apps behind a single toolbar.'],
    ['<code>?app=jarvis</code>', 'Just the assistant — ask in plain language and it routes to whichever specialist owns the answer.'],
  ])}
  <div class="note"><b>Local first.</b> The stack runs on one box with Docker — cockpit, Postgres, Redis,
    the vector store and the bot containers — and scales out to Kubernetes without changing the app
    contract. Sign-in is OIDC in production; local development runs with a mock identity so a human can
    always exercise the thing in a browser.</div>
</div></section>`;

  return page({
    title: `oshal applications — ${counts.apps} apps on infrastructure you own`,
    description: `Browse all ${counts.apps} oshal applications across ${counts.shelves} shelves — productivity, knowledge, finance, creative, home and engineering — and the platform underneath them.`,
    canonical: url.productHub,
    section: 'product',
    statusLeft: 'APPLICATION CATALOG',
    body,
  });
}

/* ────────────────────────────── shelf page ────────────────────────────── */

function renderShelf(model, shelf) {
  const others = model.shelves.filter((s) => s.slug !== shelf.slug);
  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">${esc(shelf.label)} · ${shelf.apps.length} application${shelf.apps.length === 1 ? '' : 's'}</p>
  <h1>${esc(shelf.tagline)}</h1>
  <p class="lede">${esc(shelf.blurb)}</p>
</div></header>

<section><div class="wrap">
  <div class="grid">
    ${shelf.apps.map(appCard).join('\n    ')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Other shelves</p>
    <h2>The rest of the catalog.</h2>
  </div>
  <div class="grid two">
    ${others.map((s) => `<a class="shelfcard" href="${url.shelf(s.slug)}">
      <span class="n">${s.apps.length} app${s.apps.length === 1 ? '' : 's'}</span>
      <h3>${esc(s.label)}</h3>
      <p>${esc(s.blurb)}</p>
      <span class="more">Browse &rarr;</span>
    </a>`).join('\n    ')}
  </div>
</div></section>`;

  return page({
    title: `${shelf.label} apps — oshal`,
    description: `${shelf.blurb} ${shelf.apps.length} oshal applications: ${shelf.apps.map((a) => a.title).join(', ')}.`,
    canonical: url.shelf(shelf.slug),
    section: 'product',
    statusLeft: `${shelf.label.toUpperCase()} SHELF`,
    trail: [{ label: 'oshal', href: '/' }, { label: 'Applications', href: url.productHub }, { label: shelf.label }],
    body,
  });
}

/* ────────────────────────────── app page ────────────────────────────── */

function renderApp(model, app) {
  const openHref = `${APP_HOST}/cockpit/?app=${encodeURIComponent(app.name)}`;
  const isStore = app.origin === 'store';

  const facts = [['Shelf', `<a href="${url.shelf(app.shelf.slug)}">${esc(app.shelf.label)}</a>`]];
  if (app.version) facts.push(['Version', `<code>${esc(app.version)}</code>`]);
  facts.push(['Ships as', isStore ? 'An installable store package' : 'Resident in the platform core']);
  facts.push(['Opens at', `<code>?app=${esc(app.name)}</code>`]);
  if (app.ticketType) facts.push(['Queued work', `Registers the <code>${esc(app.ticketType)}</code> ticket type`]);
  if (app.bots && app.bots.length) {
    facts.push(['Accountable bots', app.bots.map((b) => `<code>${esc(b.name)}</code>`).join(' ')]);
  }

  // The screens sit in the hero rather than in a section of their own: they are the most concrete
  // thing about an app, and they fill a left column that is otherwise dead space beside the aside.
  const screensBlock = (app.screens && app.screens.length)
    ? `<div style="margin-top:36px">
        <p class="eyebrow">${app.screens.length} screen${app.screens.length === 1 ? '' : 's'} in the ribbon${app.defaultView ? ` · opens on <code>${esc(app.defaultView)}</code>` : ''}</p>
        <div class="pills" style="margin-top:14px">${app.screens.map((s) => `<span class="pill screen">${esc(s.label)}</span>`).join('')}</div>
      </div>`
    : '';

  const blocks = [];

  if (app.rest) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">What it does</p><h2>The rest of the story.</h2></div>
      <p class="lede">${esc(app.rest)}</p></div></section>`);
  }

  // A real screenshot, only for apps with a vetted capture — never a mock-up or a data-bearing shot.
  if (APP_SHOTS[app.name]) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">On screen</p><h2>What it looks like.</h2></div>
      ${figure(...SHOTS[APP_SHOTS[app.name]])}</div></section>`);
  }

  if (app.tools && app.tools.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">What you can ask it</p>
      <h2>Tools the bot can actually call.</h2>
      <p class="lede">Registered server-side, scoped to the signed-in user. The bot calls the tool —
        it never shells out, and it never handles the credential behind it.</p></div>
      ${bulletList(app.tools.map((t) => `<strong>${esc(t.label)}.</strong> ${esc(t.description)}`))}
    </div></section>`);
  }

  blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">How it runs</p>
      <h2>What happens when you use it.</h2>
      <p class="lede">Not a chat window with a plugin behind it. Every step below is something the
        app declares in its manifest, which is why it can be told to you plainly.</p></div>
      ${flowList(activationFlow(app))}
    </div></section>`);

  if (app.bots && app.bots.length) {
    const asks = (app.capabilities || []).slice(0, 6);
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">With the assistant</p>
      <h2>You can ignore this app entirely and just ask.</h2>
      <p class="lede">The assistant is the front door. It classifies your request, delegates to the
        bot that owns the domain, and answers in one voice — so you do not have to know which of the
        applications this happens to live in.</p></div>
      ${bulletList([
        `<strong>Routing is by declared capability</strong>, not by keyword. ${app.bots.map((b) => `<code>${esc(b.name)}</code>`).join(', ')} ${app.bots.length === 1 ? 'advertises' : 'advertise'} what ${app.bots.length === 1 ? 'it is' : 'they are'} accountable for, and the assistant matches against that.`,
        ...(asks.length ? [`<strong>Asks that land here:</strong> ${asks.map((c) => `anything about ${esc(humanize(c))}`).join(', ')}.`] : []),
        `<strong>The specialist does the work, not the assistant.</strong> Cost, permissions and audit stay attached to ${app.bots.length === 1 ? 'the bot' : 'the bots'} above — delegation does not launder accountability.`,
        `<strong>It will tell you when it cannot.</strong> If a request needs your screen — an approval, a payment, a login — it says which app to open rather than guessing.`,
      ])}
    </div></section>`);
  }

  if (app.capabilities && app.capabilities.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">Accountability</p>
      <h2>${app.capabilities.length} capabilit${app.capabilities.length === 1 ? 'y' : 'ies'}, each attached to a named identity.</h2>
      <p class="lede">Declared in the manifest and bound to the bot above — so "what is this thing
        allowed to do" is a list you can read, not a prompt you have to trust.</p></div>
      <div class="pills">${app.capabilities.map((c) => `<span class="pill">${esc(c)}</span>`).join('')}</div>
    </div></section>`);
  }

  const needs = [];
  if (app.connectors && app.connectors.length) {
    needs.push(`<strong>Accounts to connect:</strong> ${app.connectors.map((c) => `<code>${esc(c)}</code>`).join(' ')}. Your token is encrypted per user and consumed by a fixed server operation — <a href="${url.topic('connectors')}">the model never sees it</a>.`);
  }
  if (app.requires && app.requires.length) {
    needs.push(`<strong>Other apps:</strong> ${app.requires.map((r) => `<a href="${url.app(r.name)}">${esc(r.title)}</a>`).join(', ')}. Install is dependency-aware and refuses to orphan them.`);
  }
  if (app.uses && app.uses.length) {
    needs.push(`<strong>Platform capability:</strong> ${app.uses.map((u) => `<code>${esc(u)}</code>`).join(' ')} — reached by declaration, never by copying platform code into the package.`);
  }
  if (needs.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">What it needs</p><h2>Before it can do anything for you.</h2></div>
      ${bulletList(needs)}</div></section>`);
  }

  if (app.related && app.related.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">Also on the ${esc(app.shelf.label.toLowerCase())} shelf</p>
      <h2>Apps that pair with this one.</h2></div>
      <div class="grid">${app.related.map(appCard).join('\n    ')}</div>
      <p style="margin-top:22px"><a href="${url.shelf(app.shelf.slug)}">All ${app.shelf.apps.length} ${esc(app.shelf.label.toLowerCase())} apps &rarr;</a></p>
    </div></section>`);
  }

  const install = isStore
    ? `<pre><code>node scripts/oshal-app.js install ${esc(app.name)}</code></pre>
       <p class="cta-note">Installs from git and hot-loads — nothing is compiled into the core.
       A one-call install straight from the catalog is planned, not shipped.</p>`
    : `<p class="cta-note">Ships with the platform. No install step — it is there once the stack is up.</p>`;

  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">${esc(app.shelf.label)} ${isStore ? '· Store package' : '· Ships with the core'}${app.version ? ` · v${esc(app.version)}` : ''}</p>
  <h1>${esc(app.title)}</h1>
  <div class="split">
    <div>
      <p class="lede">${esc(app.lead)}</p>
      <div class="cta-row">
        <a class="btn primary" href="${openHref}">Open the app &rarr;</a>
        <a class="btn" href="${APP_HOST}/guest">Try the live demo</a>
      </div>
      <p class="cta-note">Opens <code>?app=${esc(app.name)}</code> on the demo deployment. On your own box it is the same URL.</p>
      ${screensBlock}
    </div>
    <aside class="aside">
      <h3>At a glance</h3>
      ${factTable(facts)}
      <div style="margin-top:18px">${install}</div>
    </aside>
  </div>
</div></header>
${blocks.join('\n')}

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Underneath</p>
    <h2>What every app on this site is standing on.</h2>
    <p class="lede">This app does not ship its own queue, its own credential store or its own cockpit.
      It declares what it needs and the platform provides it.</p>
  </div>
  <div class="grid">
    ${['cockpit', 'connectors', 'queues', 'security'].map((slug) => {
      const t = TOPICS.find((x) => x.slug === slug);
      return `<a class="card" href="${url.topic(t.slug)}">
      <span class="top"><span class="tag">${esc(t.kicker)}</span></span>
      <h3>${t.title}</h3>
      <span class="more">Learn more &rarr;</span>
    </a>`;
    }).join('\n    ')}
  </div>
</div></section>`;

  return page({
    title: `${app.title} — oshal ${app.shelf.label.toLowerCase()} app`,
    description: app.summary || app.lead,
    canonical: url.app(app.name),
    section: 'product',
    statusLeft: isStore ? 'STORE PACKAGE' : 'CORE APPLICATION',
    trail: [
      { label: 'oshal', href: '/' },
      { label: 'Applications', href: url.productHub },
      { label: app.shelf.label, href: url.shelf(app.shelf.slug) },
      { label: app.title },
    ],
    body,
  });
}

/* ────────────────────────────── platform pages ────────────────────────────── */

function renderPlatformHub(model) {
  const { counts } = model;
  const cards = TOPICS.map((t, i) => `<a class="card" href="${url.topic(t.slug)}">
      <span class="top"><span class="tag">${String(i + 1).padStart(2, '0')} / ${esc(t.kicker)}</span></span>
      <h3>${t.title}</h3>
      <p>${fill(t.promise, counts)}</p>
      ${t.flag ? `<span class="flag">${esc(t.flag)}</span>` : ''}
      <span class="more">Learn more &rarr;</span>
    </a>`).join('\n    ');

  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">Inside the box</p>
  <h1>The platform all <span class="accent">${counts.apps} applications</span> are standing on.</h1>
  <p class="lede">The apps are the visible part. Underneath, the same pieces run for all of them — one
    cockpit, one queue, one credential vault, one set of databases. An app never ships its own copy;
    it reaches platform capability by declaring what it needs.</p>
  <div class="cta-row">
    <a class="btn primary" href="${url.productHub}">Browse the applications</a>
    <a class="btn" href="/">Platform overview</a>
  </div>
  ${figure(...SHOTS.ops)}
</div></header>

<section><div class="wrap">
  <div class="grid two">
    ${cards}
  </div>
</div></section>`;

  return page({
    title: 'The oshal platform — cockpit, connectors, queues, databases, security',
    description: 'The nine pieces underneath every oshal application: cockpit and ribbon, connectors and the credential vault, queues and the mesh, databases, monitoring and self-healing, model harnesses, remote nodes, external agents and security.',
    canonical: url.platformHub,
    section: 'platform',
    statusLeft: 'PLATFORM',
    trail: [{ label: 'oshal', href: '/' }, { label: 'Platform' }],
    body,
  });
}

// A platform page shows the surface it describes, where a vetted capture exists.
const TOPIC_SHOTS = { connectors: ['connectors', 'connectorGovernance'], monitoring: ['ops'] };

function renderPlatformTopic(model, topic) {
  const { counts } = model;
  const others = TOPICS.filter((t) => t.slug !== topic.slug);
  const shots = (TOPIC_SHOTS[topic.slug] || []).map((id) => figure(...SHOTS[id])).join('\n');
  const shotSection = shots ? `<section><div class="wrap">${shots}</div></section>` : '';

  const sections = topic.sections.map((s) => `<section><div class="wrap">
  <div class="sec-head"><h2>${fill(s.h, counts)}</h2></div>
  ${s.body ? fill(s.body, counts) : ''}
  ${s.list ? bulletList(s.list.map((i) => fill(i, counts))) : ''}
</div></section>`).join('\n');

  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">${esc(topic.kicker)}</p>
  <h1>${topic.title} ${topic.flag ? `<span class="flag" style="font-size:.9rem;vertical-align:middle">${esc(topic.flag)}</span>` : ''}</h1>
  <div class="split">
    <div>
      <p class="lede">${fill(topic.promise, counts)}</p>
      <div class="cta-row">
        <a class="btn primary" href="${url.productHub}">See what runs on it</a>
        <a class="btn" href="${url.platformHub}">All platform pieces</a>
      </div>
    </div>
    <aside class="aside">
      <h3>Specifics</h3>
      ${factTable(topic.facts.map(([k, v]) => [k, fill(v, counts)]))}
    </aside>
  </div>
</div></header>
${shotSection}
${sections}

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Keep reading</p><h2>The rest of the platform.</h2></div>
  <div class="grid">
    ${others.map((t) => `<a class="card" href="${url.topic(t.slug)}">
      <span class="top"><span class="tag">${esc(t.kicker)}</span></span>
      <h3>${t.title}</h3>
      <p>${fill(t.promise, counts)}</p>
      <span class="more">Learn more &rarr;</span>
    </a>`).join('\n    ')}
  </div>
</div></section>`;

  const plain = topic.title.replace(/&amp;/g, '&');
  return page({
    title: `${plain} — the oshal platform`,
    description: fill(topic.promise, counts).replace(/<[^>]+>/g, ''),
    canonical: url.topic(topic.slug),
    section: 'platform',
    statusLeft: topic.kicker.toUpperCase(),
    trail: [{ label: 'oshal', href: '/' }, { label: 'Platform', href: url.platformHub }, { label: plain }],
    body,
  });
}

/* ────────────────────────────── guides ────────────────────────────── */

const G = require('./guides-content');

function renderInstall(model) {
  const { counts } = model;
  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">Install</p>
  <h1>One command, and a stack that <span class="accent">checks its own work</span>.</h1>
  <p class="lede">oshal runs on one machine with Docker — cockpit, database, mesh, vector store and the
    bot fleet — and the installer refuses to tell you it worked until it has verified that it did.
    No cloud account, no API key to begin with, nothing to compile.</p>
  <div class="cta-row">
    <a class="btn primary" href="#paths">Pick your path</a>
    <a class="btn" href="${url.build}">Then add an app &rarr;</a>
  </div>
</div></header>

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Before you start</p><h2>What the machine needs.</h2></div>
  <div class="checklist">
    ${G.INSTALL_REQUIREMENTS.map((r) => `<div>
      <span class="tick${r.req ? ' req' : ''}">${r.req ? 'REQ' : 'OPT'}</span>
      <span><b>${r.title}</b>${r.body}</span>
    </div>`).join('')}
  </div>
</div></section>

<section id="paths"><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Three ways in</p><h2>Pick the one that matches your machine.</h2></div>
  <div class="lanes">
    ${G.INSTALL_PATHS.map((p) => `<div class="lane">
      <span class="n">${esc(p.n)}</span>
      <h3>${p.title}</h3>
      <p>${p.body}</p>
      <code class="cmd">${esc(p.cmd)}</code>
    </div>`).join('')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">What it does</p><h2>Six things, in this order.</h2>
    <p class="lede">Worth reading once, because it explains why an oshal install either works or tells
      you exactly which capability is missing — rather than leaving you with running containers and a
      blank page.</p>
  </div>
  ${flowList(G.INSTALL_STEPS)}
</div></section>

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">After it finishes</p><h2>Where everything is.</h2></div>
  ${factTable(G.INSTALL_PORTS)}
  <div class="note"><b>One port is public, the rest are not.</b> Only the cockpit binds to all
    interfaces, because that is how a second machine joins your swarm. Every datastore is bound to
    loopback, so nothing on your network can reach your database even if you never configure a
    firewall.</div>
</div></section>

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">If something is wrong</p><h2>The four that actually happen.</h2></div>
  ${flowList(G.INSTALL_TROUBLE)}
</div></section>

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Next</p><h2>You have a platform. Now put something on it.</h2>
  <p class="lede">${counts.apps} applications are installable from the catalog, and adding your own
    takes a conversation rather than a codebase.</p></div>
  <div class="cta-row">
    <a class="btn primary" href="${url.build}">Add an application &rarr;</a>
    <a class="btn" href="${url.productHub}">Browse the catalog</a>
  </div>
</div></section>`;

  return page({
    title: 'Install oshal — one command, self-hosted, verified',
    description: 'Install oshal on one machine with Docker: one command on macOS or Linux, a double-click on Windows, or an offline archive. The installer generates its own secrets, brings the stack up in order, and verifies by capability before reporting success.',
    canonical: url.install,
    section: 'install',
    statusLeft: 'INSTALL GUIDE',
    trail: [{ label: 'oshal', href: '/' }, { label: 'Install' }],
    body,
  });
}

function renderBuild(model) {
  const { counts } = model;
  const body = `
<header class="page"><div class="wrap">
  <p class="eyebrow">Adding an application</p>
  <h1>You need an idea. <span class="accent">Not an architecture.</span></h1>
  <p class="lede">You do not have to understand agent orchestration, prompt engineering, OAuth scopes,
    row-level security or front-end layout to add something to oshal. You need to be able to say what
    you want to happen. A requirement, a workflow, a reminder, an event — the platform already owns
    the hard parts, and the parts it cannot do for you are named on this page rather than discovered
    at step four.</p>
  <div class="cta-row">
    <a class="btn primary" href="#routes">The four routes in</a>
    <a class="btn" href="#example">See a real one</a>
  </div>
</div></header>

<section id="example"><div class="wrap">
  <div class="sec-head"><p class="eyebrow">A worked example</p><h2>One sentence, start to finish.</h2></div>
  <p class="quote">&ldquo;${esc(G.FLOWERS.quote)}&rdquo;</p>
  <p class="lede">${G.FLOWERS.intro}</p>
  <div style="margin-top:28px">${flowList(G.FLOWERS.steps)}</div>
  <div class="note"><b>The honest edges.</b>
    ${bulletList(G.FLOWERS.ceiling)}
  </div>
</div></section>

<section id="routes"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Four routes in</p><h2>Talk, draw, import, or copy.</h2>
    <p class="lede">Three of the four never ask you to open an editor. Each one ends the same way —
      a real application, registered in the running swarm, with its own bots and its own screens.</p>
  </div>
  <div class="lanes">
    ${G.BUILD_LANES.map((l) => `<div class="lane">
      <span class="n">${esc(l.n)}</span>
      <h3>${l.title}</h3>
      <p>${l.body}</p>
      <p class="cta-note" style="margin-top:0"><strong>Honestly:</strong> ${l.honest}</p>
    </div>`).join('')}
  </div>
  ${figure(...SHOTS.workflow)}
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">What you skip</p><h2>Six things you will never build.</h2>
    <p class="lede">This is the actual reason adding an app is small: almost everything that makes
      software hard is already here, and your package declares that it wants it.</p>
  </div>
  ${bulletList(G.BUILD_FREE)}
</div></section>

<section><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">What still needs you</p><h2>The honest four.</h2>
    <p class="lede">Every platform that claims "just describe it" hides a step. Here are ours,
      up front.</p>
  </div>
  ${flowList(G.BUILD_LIMITS)}
</div></section>

<section><div class="wrap">
  <div class="sec-head"><p class="eyebrow">Where it lands</p><h2>Your app is a real app.</h2>
    <p class="lede">Whatever route you took, the result is the same shape as the ${counts.apps}
      applications already in the catalog — the same manifest, the same cockpit, the same rails.
      It opens at its own URL, it can be installed onto another box, and the assistant can route
      to it.</p></div>
  <div class="cta-row">
    <a class="btn primary" href="${url.productHub}">See what that looks like</a>
    <a class="btn" href="${url.install}">Install first</a>
  </div>
</div></section>`;

  return page({
    title: 'Add an application to oshal — describe it, and publish it',
    description: 'Adding an application to oshal takes a conversation, not a codebase. Four routes in: describe a bot in eight questions, draw a workflow by talking, import an existing skill, or copy a five-file example.',
    canonical: url.build,
    section: 'build',
    statusLeft: 'BUILD GUIDE',
    trail: [{ label: 'oshal', href: '/' }, { label: 'Add an application' }],
    body,
  });
}

module.exports = {
  renderProductHub, renderShelf, renderApp, renderPlatformHub, renderPlatformTopic,
  renderInstall, renderBuild, url, TOPICS,
};
