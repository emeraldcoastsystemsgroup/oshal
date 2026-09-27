/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: headless Playwright checks and preview capture for the four full-catalog layouts. Its game-preview assertion now expects the fictional name the page shows; no other assertion changed.
 */
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

(async () => {
 const sandbox = { window: {} };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'catalog-data.js'), 'utf8'), sandbox);
 const catalog = sandbox.window.OSHAL_CATALOG.apps;
 const browser = await chromium.launch({ headless: true });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
 const screenshots = path.join(__dirname, 'previews');
 fs.mkdirSync(screenshots, { recursive: true });
 const errors = [];
 const requests = [];
 let checks = 0;
 const ok = (value, message) => { assert.ok(value, message); checks++; };
 page.on('pageerror', e => errors.push(e.message));
 page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
 const url = file => pathToFileURL(path.join(__dirname, file)).href;
 const fresh = async layout => {
  await page.goto(url(layout + '.html'));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('.app-shell').waitFor();
 };
 const click = async (action, extra = '') => {
  const dialog = page.locator('#full-dialog[open]');
  const scope = await dialog.count() ? dialog : page;
  await scope.locator(`[data-action="${action}"]${extra}:visible`).first().click();
 };
 const close = async () => { await page.keyboard.press('Escape'); ok(!(await page.locator('#full-dialog').count()), 'Escape closes panel'); };
 const text = selector => page.locator(selector).innerText();
 const directory = async () => { await page.keyboard.press('Control+k'); await page.locator('#app-search').waitFor(); };
 const layoutCheck = async label => {
  const problems = await page.evaluate(() => {
   const width = document.documentElement.clientWidth;
   return { pageOverflow: document.documentElement.scrollWidth > width + 1, elements: [...document.querySelectorAll('button,input,textarea,select,h1,h2,h3')].filter(e => {
    if(e.closest('dialog:not([open])'))return false;
    const r=e.getBoundingClientRect();return r.width>0 && (r.right>width+2||r.left < -2);
   }).map(e=>e.outerHTML.slice(0,170)) };
  });
  assert.deepEqual(problems,{pageOverflow:false,elements:[]},label+': '+JSON.stringify(problems));checks++;
 };
 try {
  ok(catalog.length === 62, 'Snapshot contains all 62 entries');
  ok(new Set(catalog.map(a => a.id)).size === 62, 'Unique package identifiers');
  for(const layout of ['studio','jarvis','orbit','commons']){
   await page.setViewportSize({width:1440,height:1050});
   await fresh(layout);
   await page.mouse.move(0,0);
   await page.screenshot({path:path.join(screenshots,`${layout}-desktop.png`),fullPage:true});
   await directory();
   ok(await page.locator('[data-catalog-app]').count() === 62, `${layout}: full inventory visible`);
   for(const [suite,count] of [['ai-finance',8],['ai-engineering',11],['ai-creative',13],['ai-productivity',12],['ai-home',13],['ai-knowledge',5],['games',3]]){
    await click('filter',`[data-suite="${suite}"]`);
    ok(await page.locator('[data-catalog-app]').count()===count,`${layout} ${suite} filter count`);
   }
   await click('filter','[data-suite="all"]');
   await page.locator('#app-search').fill('Intelligent Career');
   const careerIds=await page.locator('[data-catalog-app]').evaluateAll(es=>es.map(e=>e.dataset.catalogApp));
   ok(careerIds.includes('career-hunter')&&careerIds.includes('intelligent-career'),'Both Career package IDs are reachable');
   await page.locator('#app-search').fill('no-such-application-123');
   ok((await text('#catalog-results')).includes('No matching apps'),'Empty search state');
   await page.locator('#app-search').fill('');
   await click('pin','[data-app="circuit-lab"]');
   await click('filter','[data-suite="pinned"]');
   ok(await page.locator('[data-catalog-app]').count()===7,'Pin adds to pinned inventory');
   ok(await page.locator('[data-catalog-app="circuit-lab"]').count()===1,'Pinned application visible');
   await click('pin','[data-app="circuit-lab"]');
   ok(await page.locator('[data-catalog-app]').count()===6,'Unpin removes from filtered view');
   await click('filter','[data-suite="all"]');
   await click('open-app','[data-app="finance"]');
   ok((await text('#full-dialog-title'))==='Finance','Actual app detail');
   ok((await text('.app-description')).includes('Plaid'),'Catalog description retained');
   await click('open-app','[data-app="world"]');
   ok((await text('#full-dialog-title'))==='World Intelligence','Declared cross-app relationship works');
   await close();
   await directory();await click('open-app','[data-app="games"]');
   ok(await page.locator('.dependency-list [data-app="dnd"]').count()===1,'Games declares Dungeon Master');
   ok(await page.locator('.dependency-list [data-app="game-show"]').count()===1,'Games declares Game Show');
   await click('artifact','[data-app="games"]');ok((await text('.game-players')).includes('Taylor'),'Game preview has shared players');
   await click('workflow');
   await page.locator('#workflow-mode').selectOption('automatic');await click('publish');
   ok((await text('#workflow-status')).includes('Version 4'),'Publish one workflow version');
   await click('restore');ok(await page.locator('#workflow-mode').inputValue()==='approval','Restore prior approval step');await close();
   if(layout!=='orbit'){
    await page.locator('#message-input').fill('Show me games for tonight');await page.locator('#message-input').press('Enter');
    ok((await text('.app-shell')).includes('Games is in Creative'),'Conversation resolves real application');
    await page.locator('#message-input').fill('<img src=x onerror=alert(1)>');await page.locator('#message-input').press('Enter');
    ok(await page.locator('.user-message img').count()===0,'Input remains text');
   }
   if(layout==='studio'){
    await directory();await click('pin','[data-app="circuit-lab"]');await close();
    ok(await page.locator('.pinned-nav [data-app="circuit-lab"]').count()===1,'Pin updates the underlying sidebar after closing the catalog');
    await click('select-app','[data-app="cad-studio"]');ok((await text('.context-app')).includes('CAD Studio'),'Selected app context changes');
    await directory();await click('open-app','[data-app="circuit-lab"]');await click('use-context');
    ok((await text('.context-token')).includes('Circuit Lab'),'Use application as conversation context');
   }
   if(layout==='orbit'){
    ok(await page.locator('.suite-node').count()===6,'Top-level graph uses six suites');
    await click('orbit-suite','[data-suite="ai-engineering"]');ok(await page.locator('.orbit-app').count()===11,'Engineering drill-down shows 11 apps');
    await click('select-app','[data-app="circuit-lab"]');ok((await text('.inspector-title')).includes('Circuit Lab'),'App selection updates inspector');
    await page.locator('.full-orbit-inspector [data-action="select-app"][data-app="animatronics"]').click();
    ok(await page.locator('.orbit-app').count()===13,'Cross-suite connection opens the target Creative suite');
    ok((await text('.inspector-title')).includes('Animatronics'),'Cross-suite connection updates the inspector');
    await click('orbit-back');ok(await page.locator('.suite-node').count()===6,'Back to entire swarm');
   }
   if(layout==='commons'){
    await page.locator('#message-input').fill('Draft for engineering only');
    await click('room','[data-suite="ai-finance"]');ok(await page.locator('#message-input').inputValue()==='','Drafts do not leak between rooms');
    await click('room','[data-suite="ai-engineering"]');ok(await page.locator('#message-input').inputValue()==='Draft for engineering only','Room draft is restored');
    await click('room-tab','[data-tab="apps"]');ok(await page.locator('.room-app-grid [data-catalog-app]').count()===11,'Room exposes its whole suite');
    await page.locator('#full-tab-apps').press('ArrowRight');ok(await page.locator('#full-tab-board').getAttribute('aria-selected')==='true','Keyboard tab navigation');
    await click('room','[data-suite="games"]');ok((await text('h1')).includes('Game room'),'Game room is accessible');
    await directory();await click('open-app','[data-app="cad-studio"]');await click('use-context');
    ok((await text('h1')).includes('Engineering'),'App detail leads to its room');
    ok((await text('.context-token')).includes('Engineering'),'Room and conversation context agree');
   }
   await page.locator('#scene-picker').selectOption('evening');
   ok((await text('.app-shell')).includes(layout==='commons'?'Willowmere':layout==='jarvis'?'Your evening':'game'),'Evening scenario changes visible experience');
   await page.mouse.move(0,0);await page.screenshot({path:path.join(screenshots,`${layout}-evening.png`),fullPage:true});
   for(const width of [1440,1024,768,600,390,320]){
    await page.setViewportSize({width,height:1050});await fresh(layout);await layoutCheck(`${layout} home ${width}`);
    if(width===390){await page.mouse.move(0,0);await page.screenshot({path:path.join(screenshots,`${layout}-mobile.png`),fullPage:true});}
    await directory();await click('filter','[data-suite="ai-engineering"]');await layoutCheck(`${layout} catalog ${width}`);
    ok(await page.locator('.directory-panel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Catalog panel fits');
    if(width===1440&&layout==='studio')await page.screenshot({path:path.join(screenshots,'full-catalog.png'),fullPage:true});
    await click('open-app','[data-app="cad-studio"]');await layoutCheck(`${layout} app panel ${width}`);await close();
   }
   console.log(`${layout}: catalog, navigation, interaction, and six viewport sizes passed`);
  }
  await page.setViewportSize({width:1440,height:1050});await fresh('studio');
  for(const app of catalog){await directory();await click('open-app',`[data-app="${app.id}"]`);ok((await text('#full-dialog-title'))===app.name,'Open '+app.id);await close();}
  await page.goto(url('index.html'));
  ok(await page.locator('.concept-card').count()===4,'Four gallery entries');
  ok(await page.locator('.concept-preview img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)),'Real screenshots loaded');
  await page.mouse.move(0,0);await page.screenshot({path:path.join(screenshots,'gallery.png'),fullPage:true});
  for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:1050});await layoutCheck('gallery '+width);}
  assert.deepEqual(errors,[],'No runtime errors');checks++;
  assert.deepEqual(requests,[],'New mockups have no external network dependencies');checks++;
  console.log(`PASS: ${checks} assertions, every catalog entry opens, four layouts, six viewport sizes, no runtime errors or external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
