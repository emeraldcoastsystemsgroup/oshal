/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Renderers for the multi-page product site: catalog hub, shelf pages, one page per application, platform hub, one page per platform topic. Content is baked into static HTML rather than rendered from a JSON island by client script — a catalog that only exists after JavaScript runs is invisible to search, to link previews and to anyone who opens the page with a flaky connection, which is a large part of why a single-page version of this reads as a brochure instead of a product site.
 */

const { page, esc, APP_HOST } = require('./theme');
const { TOPICS } = require('./platform-content');

/** Site-absolute URLs. One place, so a path change cannot half-happen across seventy pages. */
const url = {
  productHub: '/product/',
  shelf: (slug) => `/product/${slug}/`,
  app: (name) => `/product/apps/${name}/`,
  platformHub: '/platform/',
  topic: (slug) => `/platform/${slug}/`,
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

function factTable(rows) {
  return `<div class="facts">${rows.map(([k, v]) => `
      <div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
    </div>`;
}

/* ────────────────────────────── catalog hub ────────────────────────────── */

function renderProductHub(model) {
  const { counts, shelves, apps } = model;
  const shelfCards = shelves.map((shelf, i) => `<a class="shelfcard" href="${url.shelf(shelf.slug)}">
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
<header class="page"><div class="wrap">
  <p class="eyebrow"><b>●</b> ${counts.apps} applications · ${counts.shelves} shelves · one login</p>
  <h1>Every app you'd want an assistant for — <span class="accent">on hardware you own</span>.</h1>
  <p class="lede">oshal is an orchestration platform for agentic AI. The platform underneath never changes:
    a cockpit, a queue, a set of databases, a connector vault, and accountable bot identities that do
    the work. <strong>Applications are what you install on top</strong> — each one a packaged bot with
    its own screens, its own connectors and its own domain.</p>
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
</div></header>

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

  if (app.tools && app.tools.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">What you can ask it</p>
      <h2>Tools the bot can actually call.</h2>
      <p class="lede">Registered server-side, scoped to the signed-in user. The bot calls the tool —
        it never shells out, and it never handles the credential behind it.</p></div>
      ${bulletList(app.tools.map((t) => `<strong>${esc(t.label)}.</strong> ${esc(t.description)}`))}
    </div></section>`);
  }

  if (app.capabilities && app.capabilities.length) {
    blocks.push(`<section><div class="wrap"><div class="sec-head">
      <p class="eyebrow">Accountability</p>
      <h2>What its bot is trusted to do.</h2>
      <p class="lede">Every capability is declared in the app's manifest and attached to a named bot
        identity, so the work has an owner and its cost has a line item.</p></div>
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

function renderPlatformTopic(model, topic) {
  const { counts } = model;
  const others = TOPICS.filter((t) => t.slug !== topic.slug);

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

module.exports = { renderProductHub, renderShelf, renderApp, renderPlatformHub, renderPlatformTopic, url, TOPICS };
