/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: headless Playwright checks of the speaking core over real local PCM playback, plus isolated audio-failure cases.
 */
// Real bundled PCM playback + analyser checks. Failure tests isolate browser audio faults.
const {chromium}=require('playwright');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1150},reducedMotion:'no-preference'});
 const url=pathToFileURL(path.join(__dirname,'nexus.html')).href;
 const errors=[],requests=[];let checks=0;
 const ok=(value,label)=>{assert.ok(value,label);checks++;};
 const track=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});};
 const play=()=>page.locator('[data-action="readback"]').click();
 const speaking=()=>page.waitForFunction(()=>document.querySelector('.readback')?.dataset.state==='speaking');
 const idle=()=>page.waitForFunction(()=>document.querySelector('.readback')?.dataset.state==='idle');
 track(page);
 try {
  await page.goto(url);
  ok(await page.locator('.readback').getAttribute('data-state')==='idle','No automatic speech on page load');
  await page.locator('#intent-input').fill('Keep my unsent draft');
  await play();await speaking();
  ok((await page.locator('[data-action="readback"]').innerText()).includes('Stop'),'Stop replaces Play after actual audio start');
  const measurements=await page.evaluate(async()=>{
   const values=[];for(let i=0;i<70;i++){
    const c=document.querySelector('#core-canvas');values.push({energy:Number(c.dataset.energy),scatter:Number(c.dataset.scatter)});
    await new Promise(r=>setTimeout(r,40));
   }return values;
  });
  ok(Math.max(...measurements.map(m=>m.energy))>.05,'Actual PCM creates measurable analyser energy');
  ok(Math.max(...measurements.map(m=>m.energy))-Math.min(...measurements.map(m=>m.energy))>.04,'Voice amplitude varies with the recording');
  ok(measurements.some(m=>m.scatter>.65),'Particles disperse while speaking');
  ok(await page.locator('#intent-input').inputValue()==='Keep my unsent draft','Speech does not rerender or erase the composer');
  await page.locator('#intent-input').fill('Find cheap flights to Vegas when I have a free weekend in November.');
  await page.screenshot({path:path.join(__dirname,'previews/nexus-speaking.png'),fullPage:true});
  await play();await idle();
  await page.waitForFunction(()=>Number(document.querySelector('#core-canvas').dataset.scatter)<.01);
  ok(await page.evaluate(()=>!window.NexusReadback.active&&window.NexusReadback.level===0),'Stop ends playback and resets analyser level');
  ok(Number(await page.locator('#core-canvas').getAttribute('data-scatter'))<.01,'Particles gather back after Stop');
  await play();await speaking();
  await page.locator('[data-action="motion"]').click();
  ok(await page.locator('.readback').getAttribute('data-reduced')==='true','Motion switch affects readback');
  ok(await page.locator('.readback').getAttribute('data-state')==='speaking','Motion off does not interrupt audio');
  const still=await page.locator('#core-canvas').evaluate(c=>c.toDataURL());
  await page.waitForTimeout(450);
  ok(await page.locator('#core-canvas').evaluate(c=>c.toDataURL())===still,'Motion off freezes the canvas throughout speech');
  ok(await page.locator('.voice-bars i').evaluateAll(es=>new Set(es.map(e=>getComputedStyle(e).height)).size===1),'Reduced motion disables meter vibration');
  await page.locator('[data-action="motion"]').click();
  await page.waitForFunction(()=>Number(document.querySelector('#core-canvas').dataset.scatter)>.5);
  ok(await page.locator('.readback').getAttribute('data-state')==='speaking','Motion can resume while the same sample plays');
  await page.locator('[data-action="result"]').click();
  ok(await page.locator('.readback').getAttribute('data-state')==='idle','Workspace transition cancels stale speech');
  await play();await speaking();
  await page.getByRole('button',{name:'New',exact:true}).click();
  ok(await page.locator('.readback').getAttribute('data-state')==='idle','New conversation stops audio');
  await page.locator('summary').click();
  ok((await page.locator('.readback details').innerText()).includes('Prerecorded placeholder'),'Transcript identifies non-live sample');
  await play();await speaking();
  await page.waitForFunction(()=>document.querySelector('.readback-status').textContent.includes('COMPLETE'),null,{timeout:35000});
  await page.waitForFunction(()=>Number(document.querySelector('#core-canvas').dataset.scatter)<.01);
  ok((await page.locator('[data-action="readback"]').innerText()).includes('Play'),'Natural audio completion restores Play');
  ok(await page.evaluate(()=>window.NexusReadback.level===0),'Natural completion zeroes the measured level');

  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('[data-action="motion"]').textContent==='Motion off');
  ok((await page.locator('[data-action="motion"]').innerText())==='Motion off','OS reduced-motion change disables motion without reload');
  const stillReduced=await page.locator('#core-canvas').evaluate(c=>c.toDataURL());
  await play();await speaking();await page.waitForTimeout(400);
  ok(await page.locator('#core-canvas').evaluate(c=>c.toDataURL())===stillReduced,'OS reduced motion stays static during readback');
  await play();
  for(const width of [1440,1024,768,600,390,320]){
   await page.setViewportSize({width,height:1150});await page.goto(url);await page.locator('summary').click();
   const fits=()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1&&[...document.querySelectorAll('.readback button,.readback summary')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
   ok(await fits(),'Expanded transcript/readback fits home '+width);
   await page.locator('[data-action="result"]').click();await page.locator('summary').click();
   ok(await fits(),'Expanded transcript/readback fits workspace '+width);
   if(width===390)await page.screenshot({path:path.join(__dirname,'previews/nexus-readback-mobile.png'),fullPage:true});
  }

  // Fault injection is limited to these pages; all audio/level checks above used real Web Audio.
  for(const fault of ['missing','decode','resume','delayed']){
   const p=await browser.newPage();track(p);
   await p.addInitScript(f=>{
    if(f==='missing'){window.AudioContext=undefined;window.webkitAudioContext=undefined;return;}
    const Real=window.AudioContext;let failed=false;
    window.AudioContext=class extends Real {
     decodeAudioData(bytes){
      if(f==='decode'&&!failed){failed=true;return Promise.reject(new Error('Fixture decode failure'));}
      if(f==='delayed')return new Promise((resolve,reject)=>setTimeout(()=>super.decodeAudioData(bytes).then(resolve,reject),500));
      return super.decodeAudioData(bytes);
     }
     resume(){if(f==='resume'&&!failed){failed=true;return Promise.reject(new Error('Fixture playback denied'));}return super.resume();}
    };
   },fault);
   await p.goto(url);await p.locator('[data-action="readback"]').click();
   if(fault==='delayed'){
    await p.locator('[data-action="readback"]').click();await p.waitForTimeout(800);
    ok(await p.locator('.readback').getAttribute('data-state')==='idle','Stop during decoding rejects stale playback');
    ok(await p.evaluate(()=>!window.NexusReadback.active),'Late decode cannot resurrect cancelled source');
   }else{
    await p.waitForFunction(()=>document.querySelector('.readback-status').textContent.includes('UNAVAILABLE'));
    ok(await p.locator('.readback details').getAttribute('open')!==null,'Readable transcript on '+fault+' failure');
    ok((await p.locator('[data-action="readback"]').innerText()).includes('Play'),'Retry control on '+fault+' failure');
    if(fault==='decode'||fault==='resume'){
     await p.locator('[data-action="readback"]').click();
     await p.waitForFunction(()=>document.querySelector('.readback').dataset.state==='speaking');
     ok(await p.evaluate(()=>window.NexusReadback.active),'Successful retry after temporary '+fault+' failure');
     await p.locator('[data-action="readback"]').click();
    }
   }
   await p.close();
  }
  assert.deepEqual(errors,[]);checks++;assert.deepEqual(requests,[]);checks++;
  console.log(`PASS: ${checks} readback assertions; real local PCM playback, measured voice energy, scatter/reassembly, natural end, Stop/replay, reduced motion, preserved draft, six widths and isolated audio failures. Zero runtime errors or external requests.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
