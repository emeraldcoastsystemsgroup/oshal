/* veo-clip.js — reliably generate ONE Veo "Animate an image" clip and download it.
 * DOM-targeted over CDP (:9222): no pixel guessing, no native file dialog (sets the hidden
 * input directly), and it WAITS for the real render signal — the whole point of a reliable
 * driver vs. improvised clicking. Discovered + proven against live Vids 2026-07-01.
 *
 *   node veo-clip.js --headshot <png> --say <promptfile|text> --out <mp4> [--keepproject]
 *
 * Flow: new tab -> create URL -> Getting-started -> Veo card -> Mode "Animate an image"
 *   -> setInputFiles(headshot) -> fill prompt -> Generate -> wait for the "Generated video"
 *   element -> Insert -> File > Download > MP4 -> capture from Downloads -> copy to --out
 *   -> close the tab (keeps Chrome alive if another tab exists).
 * Prints VEO_CLIP_OK <out> on success, or VEO_CLIP_ERR/FAIL on failure (never fabricates).
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const CDP = process.env.VIDS_CDP || 'http://127.0.0.1:9222';
const DL = process.env.VIDS_DOWNLOADS || 'C:\\Users\\the operator\\Downloads';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
const log = (...a) => console.log('[veo-clip]', ...a);
const sleep = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const headshot = arg('headshot');
  const out = arg('out');
  let say = arg('say') || '';
  if (!headshot || !out || !say) { console.error('need --headshot --say --out'); process.exit(2); }
  if (fs.existsSync(say)) say = fs.readFileSync(say, 'utf8').replace(/\r/g, '').trim();
  if (!fs.existsSync(headshot)) { console.error('headshot not found: ' + headshot); process.exit(2); }

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error('no browser context'); process.exit(3); }
  const keeperExists = ctx.pages().length >= 1; // an existing tab keeps Chrome alive after we close ours
  const page = await ctx.newPage();
  let saved = false;
  try {
    log('new video (create URL)…');
    await page.goto('https://docs.google.com/videos/create', { waitUntil: 'domcontentloaded' });

    // Getting-started dialog -> the Veo card (fallback: the editor right-rail Veo button).
    let opened = false;
    try {
      const veoCard = page.locator('button:has-text("Generate 8-second")').first();
      await veoCard.waitFor({ state: 'visible', timeout: 40000 });
      await veoCard.click(); opened = true;
    } catch {
      const rail = page.locator('[aria-label="Generate an AI video clip"]').first();
      await rail.waitFor({ state: 'visible', timeout: 20000 });
      await rail.click(); opened = true;
    }
    if (!opened) throw new Error('could not open the Veo panel');

    // Mode -> "Animate an image"
    log('mode -> Animate an image…');
    const mode = page.locator('[role=combobox][aria-label="Mode"]').first();
    await mode.waitFor({ state: 'visible', timeout: 30000 });
    await mode.click();
    const animate = page.locator('[role=option]:has-text("Animate an image")').first();
    await animate.waitFor({ state: 'visible', timeout: 15000 });
    await animate.click();
    await sleep(page, 800);

    // Headshot via the HIDDEN file input (no native dialog) — search all same-origin frames.
    log('headshot -> hidden input…');
    let setDone = false;
    for (const frame of page.frames()) {
      try { const inp = frame.locator('input[type=file]').first(); if (await inp.count()) { await inp.setInputFiles(headshot, { timeout: 20000 }); setDone = true; break; } } catch { /* cross-origin */ }
    }
    if (!setDone) throw new Error('no file input found for the headshot');
    await sleep(page, 4500);

    // Prompt
    log('prompt…');
    // In "Animate an image" mode the textarea's aria-label differs from scratch mode, so target
    // the visible textarea in the panel (there's exactly one) and TYPE it via real key events
    // (keystrokes reliably enable the Generate button; fill() sometimes doesn't).
    const prompt = page.locator('textarea:visible').first();
    await prompt.waitFor({ state: 'visible', timeout: 20000 });
    await prompt.click();
    await prompt.pressSequentially(say, { delay: 6 });
    await sleep(page, 1300);

    // Generate
    log('generate…');
    await page.getByRole('button', { name: 'Generate', exact: true }).first().click();

    // Wait for the REAL render — the "Generated video" element appears (up to ~4 min).
    log('waiting for render…');
    const rendered = page.locator('video[aria-label^="Generated video"]').first();
    await rendered.waitFor({ state: 'visible', timeout: 240000 });
    log('rendered.');

    // Grab the clip DIRECTLY from its <video> src — a usercontent.google.com/download URL — via the
    // request context (carries the browser's auth cookies, NOT CORS-bound). RELIABLE: the
    // File>Download>MP4 project export stalls ("Preparing download" never lands). No Insert, no menu.
    log('grabbing clip src…');
    let clipSrc = null;
    for (let i = 0; i < 24; i++) {
      clipSrc = await rendered.getAttribute('src').catch(() => null);
      if (clipSrc && /^https?:/.test(clipSrc)) break;
      await sleep(page, 1500);
    }
    if (!clipSrc || !/^https?:/.test(clipSrc)) throw new Error('generated clip has no fetchable https src');
    const resp = await page.context().request.get(clipSrc, { timeout: 90000 });
    if (!resp.ok()) throw new Error('clip src fetch HTTP ' + resp.status());
    const buf = await resp.body();
    if (buf.length < 60000) throw new Error('clip too small (' + buf.length + ' bytes)');
    fs.writeFileSync(out, buf); saved = true;
    log('saved ->', out, Math.round(buf.length / 1024) + 'KB');
    log('saved ->', out);
  } finally {
    // On SUCCESS close our tab (Chrome stays alive via the keeper). On FAILURE leave it OPEN so the
    // rendered clip can be downloaded by hand without re-rendering.
    try { if (saved && keeperExists) await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }

  if (fs.existsSync(out) && fs.statSync(out).size > 120000) console.log('VEO_CLIP_OK', out, Math.round(fs.statSync(out).size / 1024) + 'KB');
  else { console.error('VEO_CLIP_FAIL output missing/too small'); process.exit(1); }
})().catch((e) => { console.error('VEO_CLIP_ERR', e.message); process.exit(1); });
