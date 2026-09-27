/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: read-only source inventory behind reskin-inventory.json. Core root path deepened by one level because the directory moved from mockups/swarm-home to docs/assets/experience-shells.
 */
// Read-only source inventory. Output is evidence, not a live feature acceptance result.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const yaml = require('js-yaml');
const core = path.resolve(__dirname, '../../..');
const store = path.resolve(core, '../oshal-applications');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const revision = cwd => cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const rows = JSON.parse(fs.readFileSync(path.join(store, 'marketplace.json'), 'utf8')).apps.map(app => {
 const dir = path.join(store, app.source.path);
 const manifest = yaml.load(fs.readFileSync(path.join(dir, 'oshal-app.yaml'), 'utf8'));
 const files = walk(dir).filter(f => !/[\\/](tests|node_modules|vendor)[\\/]/.test(f));
 const html = files.filter(f => f.endsWith('.html'));
 const texts = html.map(f => fs.readFileSync(f, 'utf8'));
 return { name: app.name, folder: app.source.path, theme: manifest.theme || null, authorizationCatalog: !!manifest.authorization?.catalog, summary: !!manifest.summary,
  declaredStaticSurfaces: (manifest.ui?.static || []).length, htmlFiles: html.length,
  htmlUsingThemeBootstrap: texts.filter(t => t.includes('surface-theme.js')).length,
  htmlWithLiteralHex: texts.filter(t => /#[0-9a-f]{3,8}\b/i.test(t)).length };
});
const pageFiles = walk(path.join(core, 'src/pages'));
const result = { capturedAt: new Date().toISOString(), coreRevision: revision(core), storeRevision: revision(store), method: 'Static manifest and source scan; package tests/node_modules/vendor excluded. HTML documents are not a count of unique reachable screens. Literal hex is a migration-review indicator, not proof of broken theming. Working tree content may differ from these commit anchors.',
 totals: { catalogEntries: rows.length, declaredStaticSurfaces: rows.reduce((n,r)=>n+r.declaredStaticSurfaces,0), packageHtmlFiles: rows.reduce((n,r)=>n+r.htmlFiles,0), packageHtmlUsingThemeBootstrap: rows.reduce((n,r)=>n+r.htmlUsingThemeBootstrap,0), packageHtmlWithLiteralHex: rows.reduce((n,r)=>n+r.htmlWithLiteralHex,0), manifestsWithTheme: rows.filter(r=>r.theme).length, manifestsWithSummary: rows.filter(r=>r.summary).length, manifestsWithAuthorizationCatalog: rows.filter(r=>r.authorizationCatalog).length, corePageHtmlFiles: pageFiles.filter(f=>f.endsWith('.html')).length, corePageCssFiles: pageFiles.filter(f=>f.endsWith('.css')).length }, packages: rows };
console.log(JSON.stringify(result, null, 2));
