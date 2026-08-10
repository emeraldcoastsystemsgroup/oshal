#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build the multi-page product site: a catalog hub, one page per shelf, one page per application, a platform hub and one page per platform topic. Replaces the single-page /product build — a marketing site whose "learn more" is a modal has no URL to share, nothing for search to index and no room for the substance that makes an app page worth reading. Writes only inside the two generated roots and PRUNES pages whose app has been removed, so a delisted app cannot linger on the public site.
 */

const fs = require('fs');
const path = require('path');

const catalog = require('./lib/product-site/catalog');
const { renderProductHub, renderShelf, renderApp, renderPlatformHub, renderPlatformTopic, renderInstall, renderBuild, TOPICS } = require('./lib/product-site/render');

const REPO = path.resolve(__dirname, '..');
const SITE = path.join(REPO, 'site', 'oswarm.ai');

/**
 * The two directories this generator OWNS. Everything inside them is generated and prunable;
 * nothing outside them is ever written. Keeping the roots explicit is what makes the prune safe.
 */
const ROOTS = [path.join(SITE, 'product'), path.join(SITE, 'platform'), path.join(SITE, 'install'), path.join(SITE, 'build')];

/** Builds the full { relativePath -> html } map for the site. */
function renderAll(model) {
  const pages = new Map();
  pages.set(path.join('product', 'index.html'), renderProductHub(model));
  for (const shelf of model.shelves) {
    pages.set(path.join('product', shelf.slug, 'index.html'), renderShelf(model, shelf));
  }
  for (const app of model.apps) {
    pages.set(path.join('product', 'apps', app.name, 'index.html'), renderApp(model, app));
  }
  pages.set(path.join('platform', 'index.html'), renderPlatformHub(model));
  for (const topic of TOPICS) {
    pages.set(path.join('platform', topic.slug, 'index.html'), renderPlatformTopic(model, topic));
  }
  // The two guides: how to get a platform, and how to put something on it.
  pages.set(path.join('install', 'index.html'), renderInstall(model));
  pages.set(path.join('build', 'index.html'), renderBuild(model));
  return pages;
}

/** Every index.html currently sitting under the generated roots. */
function existingPages() {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'index.html') found.push(path.relative(SITE, full));
    }
  };
  ROOTS.forEach(walk);
  return found;
}

/** Removes a pruned page and any directories it leaves empty, without climbing past the roots. */
function removePage(rel) {
  const full = path.join(SITE, rel);
  fs.unlinkSync(full);
  let dir = path.dirname(full);
  while (ROOTS.some((r) => dir.startsWith(r)) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function main() {
  const check = process.argv.includes('--check');
  const model = catalog.build();

  if (model.missingStore) {
    // Fail SAFE, not open: a checkout without the sibling store trunk must never be able to
    // regenerate the site with 47 application pages missing, and --check must not call pages
    // stale that it has no way to verify.
    console.warn(`[product-site] store trunk not found at ${catalog.STORE_DIR} — leaving the committed pages untouched.`);
    console.warn('[product-site] set OSHAL_STORE_DIR to regenerate from a checkout elsewhere.');
    return;
  }

  const pages = renderAll(model);
  const stale = existingPages().filter((rel) => !pages.has(rel));

  const changed = [];
  for (const [rel, html] of pages) {
    const full = path.join(SITE, rel);
    const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (current !== html) changed.push(rel);
  }

  const c = model.counts;
  console.log(`[product-site] ${pages.size} pages: 1 catalog hub + ${model.shelves.length} shelves + ${model.apps.length} apps + 1 platform hub + ${TOPICS.length} platform topics + 2 guides`);
  console.log(`[product-site] catalog: ${c.apps} apps (${c.storeApps} store + ${c.kernelApps} kernel) across ${c.shelves} user-facing shelves`);
  console.log(`[product-site] counts: ${c.connectors} connectors, ${c.providers} providers, ${c.personas} personas, ${c.adrs} ADRs`);
  console.log(`[product-site] withheld: ${[...model.withheld.kernel, ...model.withheld.store].join(', ') || '(none)'}`);

  if (!changed.length && !stale.length) { console.log('[product-site] site already current.'); return; }

  if (check) {
    if (changed.length) console.error(`[product-site] STALE — ${changed.length} page(s) differ:\n  ${changed.slice(0, 10).join('\n  ')}`);
    if (stale.length) console.error(`[product-site] ORPHANED — ${stale.length} page(s) no longer have a source:\n  ${stale.join('\n  ')}`);
    console.error('[product-site] run: node scripts/site-product-pages.js');
    process.exit(1);
  }

  for (const [rel, html] of pages) {
    const full = path.join(SITE, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html);
  }
  // Prune AFTER writing: a delisted app whose page survived would keep selling something the
  // catalog no longer has, which is the drift this generator exists to prevent.
  for (const rel of stale) removePage(rel);

  console.log(`[product-site] wrote ${changed.length} page(s)${stale.length ? `, pruned ${stale.length}` : ''}.`);
}

module.exports = { renderAll, existingPages, SITE, ROOTS };

if (require.main === module) main();
