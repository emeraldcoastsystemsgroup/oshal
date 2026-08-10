/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared page shell for the multi-page product site. CSS is inlined into every generated page rather than linked: the site's rule is self-contained pages with no external requests, and a linked stylesheet that failed to stage would render all seventy pages unstyled — a failure mode worth more than the bytes it saves. Brand tokens follow docs/assets/oshal/visual-identity.md.
 */

/** Where a visitor actually opens an app. Already the public demo host on the main site. */
const APP_HOST = 'https://oshal.agenticfederal.us';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Attribute-safe single-line text (meta descriptions, titles). */
const attr = (s) => esc(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());

const CSS = `
:root{
  --night:#0B1020; --panel:#111A2E; --panel-2:#0E1526;
  --hairline:rgba(148,163,184,.16); --hairline-strong:rgba(148,163,184,.28);
  --cyan:#7DD3FC; --cyan-deep:#38BDF8; --green:#34D399; --amber:#FBBF24;
  --slate:#94A3B8; --body:#B7C3D6; --white:#F8FAFC;
  --mono:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,"SF Mono",Menlo,monospace;
  --sans:system-ui,"Segoe UI Variable Display","Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif;
  --w:1120px;
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{background:var(--night);color:var(--body);font-family:var(--sans);font-size:1rem;line-height:1.65;-webkit-font-smoothing:antialiased;overflow-x:hidden}
::selection{background:rgba(125,211,252,.28);color:var(--white)}
a{color:var(--cyan);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px;border-radius:2px}
img{max-width:100%;height:auto}
.wrap{max-width:var(--w);margin:0 auto;padding:0 24px}
@media (max-width:720px){.wrap{padding-inline:16px}}

.statusbar{border-bottom:1px solid var(--hairline);font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;color:var(--slate)}
.statusbar .wrap{display:flex;justify-content:space-between;align-items:center;height:34px;gap:16px}
.statusbar .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:7px;vertical-align:1px;box-shadow:0 0 6px rgba(52,211,153,.7)}
@media (max-width:720px){.statusbar .right{display:none}}

nav.top{position:sticky;top:0;z-index:50;background:rgba(11,16,32,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--hairline)}
nav.top .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:24px}
.brand{display:flex;align-items:center;gap:11px;color:var(--white)}
.brand:hover{text-decoration:none}
.brand svg{display:block;flex-shrink:0}
.brand .word{font-weight:750;letter-spacing:-.02em;font-size:1.06rem;white-space:nowrap}
.navlinks{display:flex;align-items:center;gap:24px;font-size:.9rem}
.navlinks a{color:var(--slate);white-space:nowrap}
.navlinks a:hover{color:var(--white);text-decoration:none}
.navlinks a[aria-current="page"]{color:var(--white)}
@media (max-width:820px){.navlinks>a:not(.btn){display:none}}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:44px;font-family:var(--mono);font-size:.84rem;font-weight:500;padding:10px 18px;border-radius:6px;border:1px solid var(--hairline-strong);color:var(--white);background:transparent;white-space:nowrap;cursor:pointer}
.btn:hover{border-color:var(--cyan);color:var(--cyan);text-decoration:none}
.btn.primary{background:var(--cyan);border-color:var(--cyan);color:#06121F;font-weight:700}
.btn.primary:hover{background:var(--cyan-deep);border-color:var(--cyan-deep);color:#06121F}

.crumbs{font-family:var(--mono);font-size:.74rem;letter-spacing:.06em;color:var(--slate);padding:22px 0 0}
.crumbs a{color:var(--slate)}
.crumbs a:hover{color:var(--cyan)}
.crumbs span{margin:0 8px;opacity:.5}

.eyebrow{font-family:var(--mono);font-size:.76rem;letter-spacing:.16em;text-transform:uppercase;color:var(--slate)}
.eyebrow b{color:var(--green);font-weight:500}
h1{margin:18px 0 22px;font-size:clamp(2.1rem,4.8vw,3.5rem);line-height:1.06;font-weight:800;letter-spacing:-.035em;color:var(--white);text-wrap:balance}
h1 .accent{color:var(--cyan)}
h2{font-size:clamp(1.5rem,3vw,2.15rem);line-height:1.16;font-weight:750;letter-spacing:-.028em;color:var(--white);text-wrap:balance}
h3{font-size:1.02rem;font-weight:700;color:var(--white);letter-spacing:-.01em}
.lede{max-width:42em;font-size:1.1rem;line-height:1.72}
.lede strong{color:var(--white);font-weight:600}
p+p{margin-top:14px}

header.page{padding:26px 0 56px;border-bottom:1px solid var(--hairline)}
section{border-bottom:1px solid var(--hairline);padding:64px 0}
section:last-of-type{border-bottom:none}
@media (max-width:720px){section{padding:48px 0}}
.sec-head{max-width:46em;margin-bottom:32px}
.sec-head h2{margin:12px 0 14px}

.cta-row{display:flex;gap:14px;margin-top:30px;flex-wrap:wrap}
.cta-note{font-family:var(--mono);font-size:.74rem;color:var(--slate);margin-top:14px}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;margin-top:44px;background:var(--hairline);border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
.stats>div{background:var(--panel-2);padding:18px}
.stats .n{font-family:var(--mono);font-size:1.6rem;font-weight:600;color:var(--cyan);line-height:1.1}
.stats .l{font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--slate);margin-top:7px}

.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,272px),1fr))}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr))}
.card{display:flex;flex-direction:column;gap:10px;background:var(--panel-2);border:1px solid var(--hairline);border-radius:10px;padding:20px;color:var(--body);transition:border-color .15s ease,transform .15s ease}
a.card:hover{border-color:var(--cyan);transform:translateY(-2px);text-decoration:none}
.card .top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.card h3{text-wrap:balance}
.card p{font-size:.9rem;line-height:1.6;flex:1;color:var(--body)}
.card .more{font-family:var(--mono);font-size:.74rem;color:var(--cyan)}
.card .tag{font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--slate)}
.badge{font-family:var(--mono);font-size:.62rem;letter-spacing:.09em;text-transform:uppercase;padding:3px 8px;border-radius:99px;border:1px solid var(--hairline-strong);color:var(--slate);white-space:nowrap}
.badge.core{border-color:rgba(52,211,153,.5);color:var(--green)}
.flag{display:inline-block;align-self:flex-start;font-family:var(--mono);font-size:.63rem;letter-spacing:.09em;text-transform:uppercase;padding:3px 8px;border-radius:99px;border:1px solid rgba(251,191,36,.45);color:var(--amber)}

.shelfcard{display:flex;flex-direction:column;gap:12px;background:var(--panel-2);border:1px solid var(--hairline);border-radius:12px;padding:26px;color:var(--body)}
a.shelfcard:hover{border-color:var(--cyan);transform:translateY(-2px);text-decoration:none}
.shelfcard .n{font-family:var(--mono);font-size:.72rem;color:var(--slate);letter-spacing:.1em}
.shelfcard h3{font-size:1.3rem;letter-spacing:-.02em}
.shelfcard p{font-size:.94rem;line-height:1.62;flex:1}
.shelfcard .names{font-family:var(--mono);font-size:.72rem;color:var(--slate);line-height:1.7}

.facts{display:grid;gap:1px;background:var(--hairline);border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
.facts>div{background:var(--panel-2);padding:16px 20px;display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr);gap:16px;align-items:baseline}
/* minmax(0,1fr), never a bare 1fr: a bare fr track keeps min-width:auto, so one unbreakable
   string (an install command, a long app name) widens the track past the viewport. */
@media (max-width:640px){.facts>div{grid-template-columns:minmax(0,1fr);gap:4px}}
.facts>div>*{min-width:0}
/* In the narrow sidebar the two-column form has ~86px left for the value, which breaks codes and
   labels character-by-character. Stack there regardless of viewport width. */
.aside .facts>div{grid-template-columns:minmax(0,1fr);gap:5px}
.aside .facts>div .v{font-size:.92rem}
/* A clipped install command reads as a broken page even though the box scrolls. Wrap it instead. */
.aside pre{white-space:pre-wrap;overflow-wrap:anywhere}
.facts dt,.facts .k{font-family:var(--mono);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--slate)}
.facts dd,.facts .v{font-size:.95rem;line-height:1.6;color:var(--body)}
code,.mono{font-family:var(--mono);font-size:.84em;background:rgba(125,211,252,.1);color:var(--cyan);padding:2px 6px;border-radius:4px;word-break:break-word}
pre{background:var(--panel-2);border:1px solid var(--hairline);border-radius:8px;padding:16px 18px;overflow-x:auto;margin-top:14px;max-width:100%}
pre code{background:none;padding:0;font-size:.85rem;color:var(--cyan)}

.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{font-family:var(--mono);font-size:.74rem;padding:7px 13px;border:1px solid var(--hairline-strong);border-radius:99px;color:var(--slate)}
.pill.screen{color:var(--body);border-color:var(--hairline-strong)}

ol.flow{list-style:none;counter-reset:none;display:grid;gap:1px;background:var(--hairline);border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
ol.flow>li{background:var(--panel-2);padding:22px 24px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:start}
ol.flow .step{font-family:var(--mono);font-size:.78rem;color:var(--cyan);letter-spacing:.08em;padding-top:2px}
ol.flow h3{margin-bottom:7px}
ol.flow p{font-size:.95rem;line-height:1.65}
@media (max-width:640px){ol.flow>li{grid-template-columns:minmax(0,1fr);gap:8px}}

/* Guide pages: a numbered step whose payload is a command you copy. Reuses ol.flow's chrome so a
   guide and an app page read as the same document family. */
ol.flow pre{margin-top:12px}
.cmd{display:block;font-family:var(--mono);font-size:.84rem;color:var(--cyan);background:var(--panel-2);border:1px solid var(--hairline);border-radius:8px;padding:14px 16px;margin-top:12px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.cmd .c{color:var(--slate)}
.checklist{display:grid;gap:1px;background:var(--hairline);border:1px solid var(--hairline);border-radius:10px;overflow:hidden;margin-top:8px}
.checklist>div{background:var(--panel-2);padding:16px 20px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start}
.checklist .tick{color:var(--green);font-family:var(--mono);font-size:.8rem;padding-top:2px}
.checklist .req{color:var(--amber)}
.checklist b{color:var(--white);display:block;margin-bottom:3px}
.checklist span{font-size:.93rem;line-height:1.6}
.lanes{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));margin-top:8px}
.lane{background:var(--panel-2);border:1px solid var(--hairline);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:12px}
.lane .n{font-family:var(--mono);font-size:.72rem;color:var(--cyan);letter-spacing:.1em}
.lane h3{font-size:1.15rem}
.lane p{font-size:.93rem;line-height:1.62;flex:1}
.quote{border-left:2px solid var(--cyan);padding:6px 0 6px 20px;margin:22px 0;font-size:1.12rem;line-height:1.6;color:var(--white);font-style:italic}

/* Screenshot figure. The image is framed and captioned; it scrolls inside its own box on narrow
   viewports rather than widening the page. Only real, vetted, same-origin captures are used here. */
figure.shot{margin:26px 0 0;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--panel-2)}
figure.shot .frame{background:#070B16;overflow-x:auto}
figure.shot img{display:block;width:100%;min-width:640px;height:auto}
figure.shot figcaption{padding:12px 18px;font-size:.86rem;line-height:1.55;color:var(--slate);border-top:1px solid var(--hairline)}
figure.shot figcaption b{color:var(--body);font-weight:600}
@media (max-width:720px){figure.shot img{min-width:560px}}

ul.bullets{list-style:none}
ul.bullets li{position:relative;padding-left:20px;margin-bottom:11px;font-size:.96rem;line-height:1.62}
ul.bullets li::before{content:"";position:absolute;left:4px;top:.66em;width:5px;height:5px;border-radius:50%;background:var(--cyan)}
ul.bullets strong{color:var(--white);font-weight:600}

.note{margin-top:24px;padding:18px 20px;border:1px solid var(--hairline);border-left:2px solid var(--amber);border-radius:0 8px 8px 0;background:var(--panel-2);font-size:.93rem;line-height:1.65}
.note b{color:var(--white)}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,340px);gap:44px;align-items:start}
.split>*{min-width:0}
@media (max-width:900px){.split{grid-template-columns:minmax(0,1fr);gap:32px}}
.aside{background:var(--panel-2);border:1px solid var(--hairline);border-radius:12px;padding:24px;position:sticky;top:88px}
@media (max-width:900px){.aside{position:static}}
.aside h3{margin-bottom:14px}
.aside .btn{width:100%;margin-bottom:10px}

/* ---- the catalog orb: a 3D sphere of every app, coloured by shelf ---- */
.orb-hero{border-bottom:1px solid var(--hairline);padding:40px 0 64px;overflow:hidden;position:relative}
.orb-hero .wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:40px;align-items:center}
@media (max-width:900px){.orb-hero .wrap{grid-template-columns:1fr;gap:8px}}
.orb-copy .orb-h1{font-size:clamp(2rem,4.4vw,3.3rem);margin:16px 0 18px}
.orb-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
.orb-key{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.74rem;color:var(--slate);border:1px solid var(--hairline);border-radius:99px;padding:6px 12px}
.orb-key:hover{color:var(--white);border-color:var(--hairline-strong);text-decoration:none}
.orb-key b{color:var(--body);font-weight:600}
.orb-key .dot{width:9px;height:9px;border-radius:50%;background:var(--h);box-shadow:0 0 8px var(--h)}
.orb-stage{position:relative;width:100%;height:clamp(360px,42vw,560px);touch-action:none}
.orb-stage.orb-live{cursor:grab}
.orb-stage.grabbing{cursor:grabbing}
.orb-glow{position:absolute;inset:0;margin:auto;width:66%;height:66%;border-radius:50%;background:radial-gradient(circle,rgba(125,211,252,.28),rgba(52,211,153,.10) 42%,transparent 68%);filter:blur(24px);pointer-events:none;animation:orbPulse 6s ease-in-out infinite}
@keyframes orbPulse{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}
/* faint sphere silhouette so the node cloud reads as one orb */
.orb-ring{position:absolute;inset:0;margin:auto;width:min(80%,80vmin);aspect-ratio:1;border-radius:50%;border:1px solid var(--hairline);box-shadow:inset 0 0 60px rgba(125,211,252,.10);pointer-events:none;opacity:.6}
.orb{position:absolute;inset:0;margin:auto;width:1px;height:1px}
@media (prefers-reduced-motion:reduce){.orb-glow{animation:none}}
/* Nodes are hidden until the engine places them, so a no-JS visitor sees the legend + catalog, not a pile. */
.orb-node{position:absolute;left:50%;top:50%;display:none;white-space:nowrap;font-family:var(--mono);font-size:.72rem;letter-spacing:.01em;padding:4px 10px;border-radius:99px;color:var(--white);background:color-mix(in srgb, var(--c) 16%, var(--night));border:1px solid color-mix(in srgb, var(--c) 55%, transparent);box-shadow:0 0 10px color-mix(in srgb, var(--c) 30%, transparent);will-change:transform,opacity;transition:background .15s,border-color .15s}
.orb-live .orb-node{display:inline-block}
.orb-node:hover{background:var(--c);color:#06121F;text-decoration:none;border-color:var(--c);box-shadow:0 0 18px var(--c);z-index:99999 !important;filter:none !important;opacity:1 !important}
.orb-node.back{pointer-events:none}
.orb-fallback{color:var(--slate);font-size:.9rem;text-align:center;padding-top:40%}
@media (prefers-reduced-motion:reduce){.orb-glow{filter:blur(12px)}}

footer{padding:44px 0 60px;color:var(--slate);font-size:.88rem;border-top:1px solid var(--hairline)}
footer .wrap{display:flex;flex-wrap:wrap;gap:16px 28px;justify-content:space-between}
footer a{color:var(--slate)}
footer a:hover{color:var(--cyan)}
`.trim();

const MARK = `<svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
<circle cx="15" cy="15" r="3.4" fill="#7DD3FC"/><circle cx="15" cy="15" r="7.5" stroke="#7DD3FC" stroke-opacity="0.45" stroke-width="1"/>
<circle cx="25" cy="8" r="2.1" fill="#34D399"/><circle cx="5.5" cy="10" r="2.1" fill="#34D399"/><circle cx="22" cy="24.5" r="2.1" fill="#34D399"/>
<path d="M17.8 12.6 23.4 9.3M12 13 7.4 10.9M17.3 17.6l3.4 5.2" stroke="#94A3B8" stroke-opacity="0.6" stroke-width="1"/></svg>`;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230B1020'/%3E%3Ccircle cx='16' cy='16' r='3.5' fill='%237DD3FC'/%3E%3Ccircle cx='16' cy='16' r='8' stroke='%237DD3FC' stroke-opacity='.45' fill='none'/%3E%3Ccircle cx='26' cy='8' r='2.2' fill='%2334D399'/%3E%3Ccircle cx='6' cy='10' r='2.2' fill='%2334D399'/%3E%3Ccircle cx='23' cy='25' r='2.2' fill='%2334D399'/%3E%3C/svg%3E";

/** Breadcrumb trail. Last entry renders as plain text — it is the page you are on. */
function crumbs(trail) {
  const parts = trail.map((c, i) => (i === trail.length - 1
    ? `<span aria-current="page" style="color:var(--body)">${esc(c.label)}</span>`
    : `<a href="${esc(c.href)}">${esc(c.label)}</a>`));
  return `<nav class="crumbs wrap" aria-label="Breadcrumb">${parts.join('<span>/</span>')}</nav>`;
}

/**
 * Wraps page content in the full document. `section` drives which nav link is marked current, and
 * `canonical` is a site-absolute path — every generated page declares one so the multi-page site
 * does not read as duplicate content.
 */
function page({ title, description, canonical, section, trail, body, statusLeft }) {
  const cur = (id) => (section === id ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${attr(title)}</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="https://oshal.ai${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="https://oshal.ai${esc(canonical)}">
<meta property="og:type" content="website">
<style>${CSS}</style>
</head>
<body>
<div class="statusbar"><div class="wrap">
  <div class="left"><span class="dot"></span>${esc(statusLeft || 'OSHAL APPLICATIONS')}</div>
  <div class="right">AGPL-3.0 · SELF-HOSTED · YOUR KEYS</div>
</div></div>
<nav class="top" aria-label="Primary"><div class="wrap">
  <a class="brand" href="/" aria-label="oshal home">${MARK}<span class="word">oshal</span></a>
  <div class="navlinks">
    <a href="/product/"${cur('product')}>Applications</a>
    <a href="/platform/"${cur('platform')}>Platform</a>
    <a href="/build/"${cur('build')}>Build</a>
    <a href="/install/"${cur('install')}>Install</a>
    <a class="btn" href="${APP_HOST}/guest">Live demo</a>
    <a class="btn primary" href="/#get-started">Install</a>
  </div>
</div></nav>
${trail && trail.length ? crumbs(trail) : ''}
${body}
<footer><div class="wrap">
  <div><a href="/">oshal.ai</a> · <a href="/product/">Applications</a> · <a href="/platform/">Platform</a> ·
  <a href="/build/">Add an app</a> · <a href="/install/">Install</a> ·
  <a href="https://github.com/emeraldcoastsystemsgroup/oshal">core repo</a> ·
  <a href="https://github.com/emeraldcoastsystemsgroup/oshal-apps">app store</a></div>
  <div>AGPL-3.0-or-later. Your infrastructure, your keys, your data.</div>
</div></footer>
</body>
</html>
`;
}

module.exports = { page, esc, attr, APP_HOST };
