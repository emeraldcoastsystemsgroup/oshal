/* veo-download-test.js — exercise ONLY the File>Download>MP4 flow against the already-open
 * Vids project tab (no re-render), to nail the menu mechanics cheaply. */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const CDP = 'http://127.0.0.1:9222'; const DL = 'C:\\Users\\the operator\\Downloads';
const OUT = 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator\\out';
const out = process.argv[2] || path.join(OUT, 'dl-test.mp4');
const sh = (p) => path.join(OUT, p);
(async () => {
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0];
  let page = null; for (const p of ctx.pages()) if (p.url().includes('docs.google.com/videos/d/')) page = p;
  if (!page) { console.log('NO_VIDEOS_TAB'); process.exit(3); }
  await page.bringToFront().catch(() => {});
  await page.screenshot({ path: sh('dl-test-before.png') }).catch(() => {});
  const clickBox = async (loc) => { const bb = await loc.boundingBox(); if (!bb) throw new Error('no box'); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); };
  const moveBox = async (loc) => { const bb = await loc.boundingBox(); if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); };
  const fileItem = page.getByRole('menuitem', { name: 'File', exact: true }).first();
  const dlItem = page.locator('[role=menuitem]:has-text("Download"):visible').first();
  let menuOpen = false;
  for (let i = 0; i < 5; i++) {
    await clickBox(fileItem);                       // click File FIRST (no flicker)
    await page.waitForTimeout(900);
    if (await dlItem.isVisible().catch(() => false)) { menuOpen = true; break; }
    console.log('file-open attempt', i, 'download-visible=false');
    await page.keyboard.press('Escape').catch(() => {});  // only Escape+retry if it didn't open
    await page.waitForTimeout(400);
  }
  if (!menuOpen) { console.log('FILE_MENU_WONT_OPEN'); await page.screenshot({ path: sh('dl-test-fail.png') }).catch(() => {}); await b.close(); process.exit(1); }
  console.log('file menu OPEN');
  const before = new Set(fs.readdirSync(DL).filter((f) => /\.mp4$/i.test(f)));
  const mp4 = page.locator('[role=menuitem]:has-text("MP4 video"):visible').first();
  let mp4box = null;
  for (let i = 0; i < 6; i++) { await moveBox(dlItem); await page.waitForTimeout(1100); if (await mp4.isVisible().catch(() => false)) { mp4box = await mp4.boundingBox(); if (mp4box) break; } }
  if (!mp4box) { console.log('MP4_NOT_REVEALED'); await page.screenshot({ path: sh('dl-test-fail.png') }).catch(() => {}); await b.close(); process.exit(1); }
  await page.mouse.click(mp4box.x + mp4box.width / 2, mp4box.y + mp4box.height / 2);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: sh('dl-test-postmp4.png') }).catch(() => {});
  console.log('clicked MP4 — screenshotted post-click state — polling Downloads (up to 5 min)…');
  let src = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    const fresh = fs.readdirSync(DL).filter((f) => /\.mp4$/i.test(f) && !before.has(f) && !/\.crdownload$/i.test(f));
    if (fresh.length) { const p = path.join(DL, fresh[0]); const s = fs.statSync(p).size; await page.waitForTimeout(1500); if (fs.existsSync(p) && fs.statSync(p).size === s && s > 120000) { src = p; break; } }
  }
  if (src) { fs.copyFileSync(src, out); console.log('DL_TEST_OK', out, Math.round(fs.statSync(out).size / 1024) + 'KB'); }
  else console.log('DL_TEST_NO_FILE (menu worked, export never landed)');
  await b.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
