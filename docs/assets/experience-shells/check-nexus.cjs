/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: headless Playwright checks and preview capture for the central-assistant prototype.
 */
const {chromium}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true});const page=await b.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
 const errors=[],requests=[];let checks=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 const ok=(v,m)=>{assert.ok(v,m);checks++;};
 const url=pathToFileURL(path.join(__dirname,'nexus.html')).href,shots=path.join(__dirname,'previews');fs.mkdirSync(shots,{recursive:true});
 const click=async(a,extra='')=>{const d=page.locator('dialog[open]');await (await d.count()?d:page).locator(`[data-action="${a}"]${extra}:visible`).first().click();};
 const close=async()=>{await page.keyboard.press('Escape');ok(await page.locator('dialog[open]').count()===0,'Escape closes modal');};
 const fits=async label=>{const actual=await page.evaluate(()=>{const w=document.documentElement.clientWidth;return {overflow:document.documentElement.scrollWidth>w+1,controls:[...document.querySelectorAll('button,input,textarea,select,h1,h2,h3')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<-2||r.right>w+2)}).map(e=>e.outerHTML.slice(0,130))};});assert.deepEqual(actual,{overflow:false,controls:[]},label+JSON.stringify(actual));checks++;};
 try{
  await page.goto(url);ok((await page.locator('[data-action="motion"]').innerText())==='Motion off','Reduced motion honored');
  ok(await page.locator('#core-canvas').evaluate(c=>c.width>0&&c.height>0),'Particle presence rendered');
  await page.screenshot({path:path.join(shots,'nexus-home.png'),fullPage:true});
  await page.locator('#intent-input').press('Enter');ok(await page.locator('.run-progress').count()===1,'Request starts staged workspace');
  await page.locator('.workspace-tabs').waitFor({timeout:10000});ok(await page.locator('[data-flight]').count()===3,'Actual demo stages produce visible results');
  ok((await page.locator('.assistant-message').innerText()).includes('$218'),'Lowest matching fare summarized');
  ok(await page.locator('[data-flight="f5"]').count()===0,'Cheaper conflicting weekend excluded');
  await page.screenshot({path:path.join(shots,'nexus-result.png'),fullPage:true});
  await click('week','[data-week="6"]');ok((await page.locator('.assistant-message').innerText()).includes('$238'),'Date selection updates summary');
  await click('all-weeks');await page.locator('#intent-input').fill('Only flights after 3pm');await page.locator('#intent-input').press('Enter');
  ok(await page.locator('#late').isChecked(),'Conversational refinement applies preference');ok(await page.locator('[data-flight="f1"]').count()===0,'Early departure excluded');
  await page.locator('#nonstop').check();ok(await page.locator('.empty-result').count()===1,'No matching offers is explicit');
  await click('clear-filters');await page.locator('#sort').selectOption('duration');ok((await page.locator('.flight').first().innerText()).includes('4h 06m'),'Duration ordering');
  await click('fare','[data-fare="f3"]');ok((await page.locator('dialog').innerText()).includes('NOT BOOKABLE'),'Details do not pretend to offer booking');await click('save-specific');
  await click('saved');ok((await page.locator('.shortlist-item').innerText()).includes('$318'),'Specific fare saved to local shortlist');await close();
  await click('travel');ok((await page.locator('.workspace-title').innerText()).includes('Travel'),'Open in Travel changes workspace, not conversation');ok(await page.locator('.request-bubble').count()===1,'Conversation preserved');
  await page.screenshot({path:path.join(shots,'nexus-travel.png'),fullPage:true});
  await click('tab','[data-tab="calendar"]');ok(await page.locator('.calendar-day.clear').count()===6,'Two three-day free windows shown');ok(await page.locator('.calendar-day.busy').count()===6,'Busy days distinguished');
  await page.locator('#tab-calendar').press('ArrowRight');ok(await page.locator('#tab-travel').getAttribute('aria-selected')==='true','Keyboard tab navigation');
  await click('sources-tab');ok((await page.locator('#workspace-content').innerText()).includes('Hand-authored'),'Provenance exposes fixture calendar');
  await click('settings');await page.locator('#assistant-name').fill('Nova');await page.locator('#origin').selectOption('ATL');await page.locator('#budget').fill('200');await page.locator('#settings-form button').click();
  ok((await page.locator('.assistant-brand strong').innerText())==='NOVA','Assistant name configurable');
  await click('tab','[data-tab="summary"]');ok((await page.locator('.trip-facts').innerText()).includes('ATL'),'Origin context updated');ok(await page.locator('[data-flight]').count()===1,'Budget filters changed fixture offers');
  await click('settings');await page.locator('#budget').fill('50');await page.locator('#settings-form button').click();ok(await page.locator('.empty-result').count()===1,'Budget empty state');
  await click('new');await page.locator('#intent-input').fill('<img src=x onerror=alert(1)> Vegas');await page.locator('#intent-input').press('Enter');await click('result');ok(await page.locator('.request-bubble img').count()===0,'User text escaped');
  await click('new');await click('demo');await click('stop');ok((await page.locator('.loading-body').innerText()).includes('Nothing runs without you'),'Stop state works');
  await page.waitForTimeout(3500);ok(await page.locator('.workspace-tabs').count()===0,'Stopped run cannot later produce results');
  for(const width of [1440,1024,768,600,390,320]){
   await page.setViewportSize({width,height:1050});await page.goto(url);await fits('home '+width);
   if(width===390)await page.screenshot({path:path.join(shots,'nexus-home-mobile.png'),fullPage:true});
   await click('result');await fits('results '+width);if(width===390)await page.screenshot({path:path.join(shots,'nexus-result-mobile.png'),fullPage:true});
   await click('tab','[data-tab="calendar"]');await fits('calendar '+width);
   await click('settings');await fits('preferences '+width);await close();
  }
  assert.deepEqual(errors,[]);checks++;assert.deepEqual(requests,[]);checks++;
  console.log(`PASS: ${checks} assertions; staged intent-to-workspace journey, refinements, sources, shortlist, cancellation, six viewport sizes; zero runtime errors or external HTTP requests.`);
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1;});
