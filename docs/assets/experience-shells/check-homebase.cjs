/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: headless Playwright checks and preview capture for the three homebase presets.
 */
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
 const errors=[],requests=[];let checks=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
 const shots=path.join(__dirname,'previews');fs.mkdirSync(shots,{recursive:true});
 const fresh=async preset=>{await page.goto(pathToFileURL(path.join(__dirname,'homebase.html')).href+'?preset='+preset);await page.evaluate(()=>sessionStorage.clear());await page.reload();};
 const click=async(action,extra='')=>{const d=page.locator('dialog[open]');await (await d.count()?d:page).locator(`[data-action="${action}"]${extra}:visible`).first().click();};
 const close=async()=>{await page.keyboard.press('Escape');ok(await page.locator('dialog[open]').count()===0,'Modal closes with Escape');};
 const person=async id=>page.locator('#person-picker').selectOption(id);
 const fits=async label=>{const bad=await page.evaluate(()=>{const w=document.documentElement.clientWidth;return {overflow:document.documentElement.scrollWidth>w+1,controls:[...document.querySelectorAll('button,input,select,textarea,h1,h2')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<-2||r.right>w+2);}).map(e=>e.outerHTML.slice(0,100))};});assert.deepEqual(bad,{overflow:false,controls:[]},label+JSON.stringify(bad));checks++;};
 try{
  for(const preset of ['family','classroom','company']){
   await fresh(preset);await fits(preset+' desktop');
   ok(await page.locator('#person-picker option').count()===4,'Four example members');
   await page.screenshot({path:path.join(shots,`homebase-${preset}.png`),fullPage:true});
   const nav=await page.locator('.side-nav [data-page]').evaluateAll(es=>es.map(e=>e.dataset.page));
   for(const tab of nav){await click('page',`[data-page="${tab}"]`);ok(await page.locator(`.side-nav [data-page="${tab}"][aria-current="page"]`).count()===1,'Navigation '+tab);ok(await page.locator('.main-column .panel').count()>0,'Destination contains content');}
   await click('page','[data-page="home"]');
   await click('event');await page.locator('#event-title').fill('A shared example moment');await page.locator('#event-time').fill('16:15');await page.locator('#event-form button').click();
   ok((await page.locator('[data-module="calendar"]').innerText()).includes('A shared example moment'),'Calendar adds an example event');
   await person(preset==='company'?'sam':'mia');ok((await page.locator('[data-module="calendar"]').innerText()).includes('A shared example moment'),'Shared event visible in another role');
   await person(preset==='family'?'alex':preset==='classroom'?'rivera':'morgan');
   const appIds=await page.locator('.apps-row [data-app]').evaluateAll(es=>es.map(e=>e.dataset.app));
   for(const app of appIds){await page.locator(`.apps-row [data-app="${app}"]`).click();ok(await page.locator('dialog[open]').count()===1,'App preview opens '+app);await close();}
   await click('configure');await page.locator('#skin-choice').selectOption('professional');await page.locator('#density-choice').selectOption('compact');await page.locator('#show-updates').uncheck();await page.locator('#show-week').uncheck();await page.locator('#config-form button[type="submit"]').click();
   ok(await page.locator('.experience').getAttribute('data-skin')==='professional','Skin publication');
   ok(await page.locator('.experience').getAttribute('data-density')==='compact','Density publication');
   ok(await page.locator('[data-module="updates"]').count()===0,'Optional activity hidden');
   ok(await page.locator('.week-strip').count()===0,'Optional calendar strip hidden');
   await page.reload();ok(await page.locator('.experience').getAttribute('data-density')==='compact','Config persists on reload');
   await click('configure');await click('restore');ok(await page.locator('.experience').getAttribute('data-density')==='comfortable','Restore prior configuration');
   ok(await page.locator('[data-module="updates"]').count()>0,'Restored activity');
   await click('ask');await page.locator('#ask-input').fill('<img src=x onerror=alert(1)>');await page.locator('#ask-form button').click();ok(await page.locator('#ask-answer img').count()===0,'Conversation input stays text');await close();
   if(preset==='family'){
    ok(await page.locator('[data-module="finance"]').count()===1,'Parent gets personal finance');
    await person('jamie');ok(await page.locator('[data-module="finance"]').innerText().then(t=>t.includes('Jamie’s')),'Other parent has own view');ok(await page.locator('[data-action="configure"]').count()===0,'Non-admin parent has no shared configuration control');
    await person('mia');ok(await page.locator('[data-module="finance"]').count()===0,'Child does not render Finance');ok(await page.locator('[data-module="learning"]').count()===1,'Child has school view');
    await page.locator('#shopping-input').fill('Carrots');await page.locator('#shopping-form button').click();await person('alex');ok((await page.locator('[data-module="shopping"]').innerText()).includes('Carrots'),'Family list shared between views');
    await page.locator('#share-location').uncheck();ok((await page.locator('.location-person').first().innerText()).includes('Not sharing'),'Opt-out hides location');
    await person('mia');ok(await page.locator('#share-location').isChecked(),'Own location opt-in remains independent');
    await click('learning');await page.locator('[data-step="0"]').check();await close();ok(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow')==='1','Learning card refreshes after close');
    await person('leo');ok(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow')==='0','Sibling progress stays separate');ok(!(await page.locator('#share-location').isChecked()),'Example child can decline location sharing');
    await page.screenshot({path:path.join(shots,'homebase-family-child.png'),fullPage:true});
   }
   if(preset==='classroom'){
    ok(await page.locator('[data-module="teacher-roster"]').count()===1,'Teacher sees class progress');await click('requirements');await page.locator('#requirements-input').fill('Draw your seed.\nWrite one observation.\nAsk one question.');await page.locator('#requirements-form button').click();
    await person('mia');ok((await page.locator('[data-module="requirements"]').innerText()).includes('Draw your seed.'),'Published requirements reach student');ok(await page.locator('[data-module="teacher-roster"]').count()===0,'Student does not render teacher roster');ok(await page.locator('[data-action="requirements"]').count()===0,'Student cannot edit class requirements');
    await click('learning');await page.locator('[data-step="0"]').check();await click('submit-work');ok((await page.locator('#learning-feedback').innerText()).includes('recorded'),'Student submits own example');await close();
    await person('leo');await click('learning');ok(!(await page.locator('[data-step="0"]').isChecked()),'Other student checklist independent');await close();
    await person('rivera');ok((await page.locator('[data-module="teacher-roster"]').innerText()).includes('Submitted'),'Teacher sees example submission');
    await person('mia');await click('event');ok(await page.locator('#event-form').count()===0,'Student cannot publish classwide calendar event');await close();
    await page.screenshot({path:path.join(shots,'homebase-classroom-student.png'),fullPage:true});
   }
   if(preset==='company'){
    ok(await page.locator('[data-module="finance"]').count()===1,'Granted operations user has Finance');await person('sam');ok(await page.locator('[data-module="finance"]').count()===0,'Engineering lead does not inherit Finance');await click('project','[data-project="1"]');await click('review-project');ok((await page.locator('[data-module="projects"]').innerText()).includes('Reviewed'),'Lead review updates project');
    await person('jules');await click('project','[data-project="1"]');ok(await page.locator('[data-action="review-project"]').count()===0,'Member has no review action');await close();
    ok(await page.locator('[data-action="configure"]').count()===0,'Member cannot change shared configuration');await page.screenshot({path:path.join(shots,'homebase-company-member.png'),fullPage:true});
   }
   for(const width of [1440,1024,768,600,390,320]){
    await page.setViewportSize({width,height:1050});await fresh(preset);await fits(preset+' '+width);
    await click('configure');await fits(preset+' config '+width);await close();
    if(width===390)await page.screenshot({path:path.join(shots,`homebase-${preset}-mobile.png`),fullPage:true});
    const finalUser=preset==='company'?'jules':'mia';await person(finalUser);await fits(preset+' alternate role '+width);
   }
   await page.setViewportSize({width:1440,height:1050});console.log(preset+': role, navigation, configuration and responsive checks passed');
  }
  await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
  ok(await page.locator('.homebase-card').count()===3,'Gallery exposes all three presets');
  ok(await page.locator('.homebase-card img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)),'Preset thumbnails loaded');
  for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:1050});await fits('expanded gallery '+width);}
  await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:path.join(shots,'gallery.png'),fullPage:true});
  assert.deepEqual(errors,[]);checks++;assert.deepEqual(requests,[]);checks++;
  console.log(`PASS: ${checks} assertions. Three presets, role journeys, six viewport widths. No runtime errors or external HTTP requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
