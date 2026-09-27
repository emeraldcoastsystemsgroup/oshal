/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: retained first-pass Playwright checks over the ?scale=sample pages; screenshots go to previews/first-pass/. Its gallery link check now drops a ?query or #fragment before testing that the linked file exists: the gallery's homebase links carry ?preset=, so the unmodified copy failed that check on every run. It still asserts every linked file exists.
 */
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
 const browser = await chromium.launch({ headless: true });
 const shots = path.join(__dirname, 'previews', 'first-pass');
 fs.mkdirSync(shots, { recursive: true });
 const issues = [];
 let checks = 0;
 const pass = condition => { assert.ok(condition); checks++; };
 const url = file => pathToFileURL(path.join(__dirname, file)).href;
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
 page.on('pageerror', error => issues.push(error.message));
 const fresh = async layout => {
  await page.goto(url(layout + '.html') + '?scale=sample');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('.app-shell').waitFor();
 };
 const click = async (action, extra = '') => {
  const selector = `[data-action="${action}"]${extra}:visible`;
  const dialog = page.locator('#prototype-dialog[open]');
  const scope = await dialog.count() ? dialog : page;
  if (action === 'workflow' && !(await scope.locator(selector).count())) {
   await page.keyboard.press('Control+k');
   await page.locator('#search-input').fill('workflow');
   await page.locator('#prototype-dialog [data-action="workflow"]').click();
   return;
  }
  await scope.locator(selector).first().click();
 };
 const close = async () => { await page.keyboard.press('Escape'); pass(await page.locator('#prototype-dialog').count() === 0); };
 const content = async selector => (await page.locator(selector).innerText()).trim();
 try {
  for (const layout of ['studio', 'jarvis', 'orbit', 'commons']) {
   await fresh(layout);
   pass(await page.locator('h1').count() >= 1);
   await page.mouse.move(0, 0);
   await page.screenshot({ path: path.join(shots, `${layout}-desktop.png`), fullPage: true });
   await page.keyboard.press('Control+k');
   await page.locator('#search-input').fill('research');
   pass((await content('#search-results')).includes('Research'));
   await page.locator('#search-input').fill('no-such-sample-item');
   pass((await content('#search-results')).includes('No matches'));
   await close();
   await click('workflow');
   await page.locator('#workflow-mode').selectOption('automatic');
   pass((await content('#flow-final')).includes('Deliver automatically'));
   await click('publish-workflow');
   pass((await content('#workflow-feedback')).includes('Version 4'));
   await close();
   await click('workflow');
   pass(await page.locator('#workflow-mode').inputValue() === 'automatic');
   await click('restore-workflow');
   pass(await page.locator('#workflow-mode').inputValue() === 'approval');
   await close();
   await click('document');
   pass((await content('.document')).includes('Two decisions'));
   await click('review');
   await click('approve');
   pass(await page.locator('#prototype-dialog').count() === 0);
   if (layout !== 'orbit') {
    await page.locator('#message-input').fill('Help me plan one focused hour');
    await page.locator('#message-input').press('Enter');
    pass((await content('.app-shell')).includes('15 minutes reviewing'));
    await page.locator('#message-input').fill('<img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Send sample message' }).click();
    pass(await page.locator('.user-message img').count() === 0);
    pass((await content('.app-shell')).includes('<img src=x onerror=alert(1)>'));
   }
   if (layout === 'studio') {
    await click('new'); pass((await content('h1')).includes('working on'));
    await click('prompt'); pass((await content('.conversation-list')).includes('sample'));
    await click('apps'); await click('app', '[data-app="office"]');
    pass((await content('#dialog-title')) === 'Office'); await close();
   }
   if (layout === 'jarvis') {
    await click('settings'); await page.locator('#routine-enabled').uncheck(); await close();
    await click('settings'); pass(!(await page.locator('#routine-enabled').isChecked())); await close();
    await click('calendar'); pass((await content('.drawer')).includes('Friday launch review')); await close();
   }
   if (layout === 'orbit') {
    await click('node', '[data-node="office"]'); pass((await content('.inspector-title')).includes('Office'));
    await click('map', '[data-map="people"]');
    await click('node', '[data-node="sam"]'); pass((await content('.inspector-title')).includes('Sam Rivera'));
    await click('node-open'); await page.locator('#direct-message').fill('Can we review the deck?');
    await page.getByRole('button', { name: 'Send in preview' }).click();
    pass((await content('#direct-response')).includes('Sam Rivera')); await close();
    await click('map', '[data-map="activity"]'); pass(await page.locator('.orbit-node').count() === 6);
   }
   if (layout === 'commons') {
    await page.locator('#message-input').fill('Draft intended for launch only');
    await click('room', '[data-room="design"]'); pass((await content('h1')).includes('Design room'));
    pass(await page.locator('#message-input').inputValue() === '');
    await click('room', '[data-room="launch"]');
    pass(await page.locator('#message-input').inputValue() === 'Draft intended for launch only');
    await click('room', '[data-room="design"]');
    pass(!(await content('.room-messages')).includes('15 minutes reviewing'));
    await click('room-tab', '[data-tab="board"]'); await click('move-task');
    pass((await content('.board-column:last-child')).includes('Confirm rollout date'));
    await page.locator('#tab-board').focus(); await page.keyboard.press('ArrowRight');
    pass(await page.locator('#tab-files').getAttribute('aria-selected') === 'true');
    pass(await page.locator('.room-files .file-tile').count() === 4);
    await click('room-tab', '[data-tab="conversation"]'); await click('react');
    pass(await page.locator('[data-action="react"]').getAttribute('aria-pressed') === 'true');
   }
   for (const width of [1440, 1024, 768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await fresh(layout);
    const overflow = await page.evaluate(() => {
     const width = document.documentElement.clientWidth;
     return { page: document.documentElement.scrollWidth > width + 1, elements: [...document.querySelectorAll('button,input,textarea,select,h1,h2,h3')].filter(e => {
      const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
      return r.width > 0 && s.visibility !== 'hidden' && (r.right > width + 2 || r.left < -2);
     }).map(e => e.outerHTML.slice(0, 180)) };
    });
    assert.deepEqual(overflow, { page: false, elements: [] }, `${layout} overflows at ${width}: ${JSON.stringify(overflow)}`); checks++;
    if (width === 390) { await page.mouse.move(0, 0); await page.screenshot({ path: path.join(shots, `${layout}-mobile.png`), fullPage: true }); }
    await click('document');
    const modalFits = await page.locator('.drawer').evaluate(e => e.scrollWidth <= e.clientWidth + 1);
    pass(modalFits); await close();
   }
   await page.setViewportSize({ width: 1440, height: 1000 });
   console.log(`${layout}: browser journeys and responsive checks passed`);
  }
  await page.goto(url('index.html'));
  await page.locator('.concept-card').first().waitFor();
  pass(await page.locator('.concept-card').count() === 4);
  pass(await page.locator('.concept-preview img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
  await page.screenshot({ path: path.join(shots, 'gallery.png'), fullPage: true });
  for (const width of [1024, 768, 390, 320]) {
   await page.setViewportSize({ width, height: 1000 });
   pass(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  }
  const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => a.getAttribute('href')));
  for (const link of links) pass(fs.existsSync(path.join(__dirname, link.split(/[?#]/)[0])));
  assert.deepEqual(issues, [], 'No browser runtime errors'); checks++;
  console.log(`PASS: ${checks} assertions; four desktop and mobile previews plus gallery saved. No runtime errors.`);
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
