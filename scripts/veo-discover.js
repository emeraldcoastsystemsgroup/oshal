/* veo-discover.js — map the live Vids DOM so veo-clip.js can target elements reliably
 * (by text/role/aria, not pixel guesses). Connects to the debug Chrome (:9222), optionally
 * performs a click first (by DOM text or by coords), then dumps every VISIBLE interactive
 * element across all same-origin frames: {tag, role, text, aria, center x/y, rect}.
 *
 *   node veo-discover.js                       # just dump current state (+ screenshot)
 *   node veo-discover.js text "New video"      # click the element whose text/aria matches, then dump
 *   node veo-discover.js click 1200 640        # click page coords, then dump
 *   node veo-discover.js goto <url>            # navigate, then dump
 * Writes out\veo-shot.png + out\veo-dom.json; prints a compact element list.
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const CDP = process.env.VIDS_CDP || 'http://127.0.0.1:9222';
const OUTDIR = 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator\\out';

async function getVidsPage(browser) {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) { const u = p.url(); if (u.includes('docs.google.com/videos') || u.includes('vids.google.com')) return p; }
  const ctx = browser.contexts()[0]; return ctx ? ctx.pages()[0] : null;
}

async function dumpFrame(frame) {
  try {
    return await frame.evaluate(() => {
      const out = [];
      const sel = 'button,[role=button],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=combobox],[role=listbox],a[href],[aria-label],textarea,input,[contenteditable="true"]';
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5 || r.y < -50) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
        const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 55);
        const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 55);
        if (!text && !aria) continue;
        const key = text + '|' + aria + '|' + Math.round(r.x) + '|' + Math.round(r.y);
        if (seen.has(key)) continue; seen.add(key);
        out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text, aria,
          cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
      }
      return out;
    });
  } catch { return []; }
}

(async () => {
  const args = process.argv.slice(2);
  const browser = await chromium.connectOverCDP(CDP);
  const page = await getVidsPage(browser);
  if (!page) { console.error('NO_VIDS_PAGE'); process.exit(3); }
  await page.bringToFront().catch(() => {});

  if (args[0] === 'goto') { await page.goto(args[1], { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000); }
  else if (args[0] === 'click') { await page.mouse.click(Number(args[1]), Number(args[2])); await page.waitForTimeout(1500); }
  else if (args[0] === 'text') {
    const want = args.slice(1).join(' ').toLowerCase();
    let clicked = false;
    for (const frame of page.frames()) {
      const els = await dumpFrame(frame);
      const hit = els.find((e) => (e.text && e.text.toLowerCase() === want) || (e.aria && e.aria.toLowerCase() === want))
               || els.find((e) => (e.text && e.text.toLowerCase().includes(want)) || (e.aria && e.aria.toLowerCase().includes(want)));
      if (hit) { await page.mouse.click(hit.cx, hit.cy); await page.waitForTimeout(1500); console.log('CLICKED', JSON.stringify(hit)); clicked = true; break; }
    }
    if (!clicked) console.log('NO_MATCH for', want);
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: OUTDIR + '\\veo-shot.png' });
  const frames = [];
  for (const frame of page.frames()) { const els = await dumpFrame(frame); if (els.length) frames.push({ frame: frame.url().slice(0, 70), els }); }
  fs.writeFileSync(OUTDIR + '\\veo-dom.json', JSON.stringify(frames, null, 1));
  for (const f of frames) {
    console.log(`\n--- FRAME ${f.frame} (${f.els.length}) ---`);
    for (const e of f.els) console.log(`[${e.cx},${e.cy} ${e.w}x${e.h}] <${e.tag}${e.role ? ' ' + e.role : ''}> ${JSON.stringify(e.text)}${e.aria ? ' aria=' + JSON.stringify(e.aria) : ''}`);
  }
  console.log('\nURL', page.url());
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
