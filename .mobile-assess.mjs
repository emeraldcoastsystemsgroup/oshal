import { chromium } from 'playwright-core';
import { pathToFileURL } from 'url';

const targets = [
  { name: 'rides', file: 'any-bot/server/services/tools/transportation/rides-app.html' },
  { name: 'cockpit', file: 'src/pages/cockpit/index.html' },
];
const viewport = { width: 390, height: 844 }; // iPhone 12/13/14

const exe = process.env.PW_CHROME || undefined;
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0,120)); });

for (const t of targets) {
  const url = pathToFileURL(process.cwd() + '/' + t.file).href;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 8000 }).catch(()=>{});
    await page.waitForTimeout(800);
    const out = `.mobile-${t.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    // measure key boxes
    const m = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if(!e) return null; const b = e.getBoundingClientRect(); return {x:Math.round(b.x), w:Math.round(b.width), h:Math.round(b.height)}; };
      return { vw: window.innerWidth, body: r('body'), header: r('.header-bar'), main: r('.main-content'), chat: r('.chat-panel'), ribbon: r('.ribbon-nav'), status: r('.status-bar'), wrap: r('.wrap'), opt: r('.opt') };
    });
    console.log(`\n[${t.name}] ${out}`);
    console.log('  ', JSON.stringify(m));
  } catch (e) {
    console.log(`[${t.name}] ERROR`, e.message);
  }
}
await browser.close();
