/* vids-drive.js — drive Google Vids over CDP on the dedicated debug Chrome (9222).
 * Runs ON the video node. CDP dispatches REAL input events at exact PAGE coordinates
 * (dpr=1, so the page screenshot pixels == click coords) — no DOM/selector guessing.
 *
 * Verbs:
 *   shot [path]          screenshot the Vids PAGE (default out/vids-shot.png)
 *   click <x> <y>        left-click at page coords
 *   dblclick <x> <y>     double-click
 *   move <x> <y>         move mouse (hover)
 *   type <text...>       type text into the focused element
 *   key <Key>            press a key (e.g. Enter, Escape, Control+A)
 *   url                  print current page url/title
 *   maximize             maximize the browser window (CDP Browser.setWindowBounds)
 */
'use strict';
const { chromium } = require('playwright');
const CDP = process.env.VIDS_CDP || 'http://127.0.0.1:9222';
const OUT = 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator\\out\\vids-shot.png';

async function getVidsPage(browser) {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes('docs.google.com/videos')) return p;
  const ctx = browser.contexts()[0];
  return ctx ? ctx.pages()[0] : null;
}

(async () => {
  const args = process.argv.slice(2);
  const verb = args[0] || 'shot';
  let browser;
  try { browser = await chromium.connectOverCDP(CDP); }
  catch (e) { console.error('CDP_CONNECT_FAIL', e.message); process.exit(2); }
  try {
    const page = await getVidsPage(browser);
    if (!page) { console.error('NO_VIDS_PAGE'); process.exit(3); }
    await page.bringToFront().catch(() => {});

    if (verb === 'maximize') {
      const session = await page.context().newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await page.waitForTimeout(700);
      console.log('MAXIMIZED');
    } else if (verb === 'shot') {
      const path = args[1] || OUT;
      await page.waitForTimeout(400);
      await page.screenshot({ path });
      const vp = page.viewportSize() || {};
      console.log('SHOT', path, 'vp=' + vp.width + 'x' + vp.height, 'url=' + page.url());
    } else if (verb === 'click') {
      await page.mouse.click(Number(args[1]), Number(args[2]));
      await page.waitForTimeout(1200);
      console.log('CLICK', args[1], args[2], 'url=' + page.url());
    } else if (verb === 'dblclick') {
      await page.mouse.dblclick(Number(args[1]), Number(args[2]));
      await page.waitForTimeout(1500);
      console.log('DBLCLICK', args[1], args[2], 'url=' + page.url());
    } else if (verb === 'move') {
      await page.mouse.move(Number(args[1]), Number(args[2]));
      console.log('MOVE', args[1], args[2]);
    } else if (verb === 'type') {
      const text = args.slice(1).join(' ');
      await page.keyboard.type(text, { delay: 25 });
      console.log('TYPED', text.slice(0, 50));
    } else if (verb === 'typefile') {
      // type the contents of a file into the focused element (handles quotes/punctuation cleanly)
      const fs = require('fs');
      const text = fs.readFileSync(args.slice(1).join(' '), 'utf8').replace(/\r/g, '');
      await page.keyboard.type(text, { delay: 12 });
      await page.waitForTimeout(400);
      console.log('TYPEFILE len=' + text.length, '|', text.slice(0, 60));
    } else if (verb === 'settext') {
      // double-click into a text element at x,y, select all, replace with text
      const x = Number(args[1]), y = Number(args[2]);
      const text = args.slice(3).join(' ');
      await page.mouse.dblclick(x, y);
      await page.waitForTimeout(600);
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(200);
      await page.keyboard.type(text, { delay: 25 });
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      console.log('SETTEXT', x, y, '=', text.slice(0, 50));
    } else if (verb === 'key') {
      await page.keyboard.press(args[1]);
      await page.waitForTimeout(500);
      console.log('KEY', args[1]);
    } else if (verb === 'clicktype') {
      // click at x,y (focus an input), type text, press Enter
      const x = Number(args[1]), y = Number(args[2]);
      const text = args.slice(3).join(' ');
      await page.mouse.click(x, y);
      await page.waitForTimeout(700);
      await page.keyboard.type(text, { delay: 25 });
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      console.log('CLICKTYPE', x, y, '=', text);
    } else if (verb === 'goto') {
      await page.goto(args[1], { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);
      console.log('GOTO ->', page.url());
    } else if (verb === 'setfile') {
      // set a LOCAL file on the hidden <input type=file> — search ALL (same-origin) frames
      const file = args.slice(1).join(' ');
      let done = false;
      for (const frame of page.frames()) {
        try {
          const inputs = frame.locator('input[type=file]');
          const n = await inputs.count();
          if (n > 0) {
            await inputs.first().setInputFiles(file, { timeout: 15000 });
            await page.waitForTimeout(6000);
            console.log('SETFILE', file, '| frame=' + frame.url().slice(0, 70));
            done = true; break;
          }
        } catch (e) { /* cross-origin frame — skip */ }
      }
      if (!done) {
        console.log('frames=' + page.frames().map((f) => f.url().slice(0, 55)).join('  |  '));
        console.log('NO_FILE_INPUT_IN_ANY_FRAME');
      }
    } else if (verb === 'upload') {
      // click an upload trigger at x,y and hand the resulting file chooser a LOCAL file
      const x = Number(args[1]), y = Number(args[2]); const file = args.slice(3).join(' ');
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 20000 }),
        page.mouse.click(x, y),
      ]);
      await chooser.setFiles(file);
      await page.waitForTimeout(3000);
      console.log('UPLOADED', file);
    } else if (verb === 'url') {
      let n = 0;
      for (const ctx of browser.contexts()) for (const p of ctx.pages()) console.log('PAGE', ++n, p.url());
    } else { console.error('unknown verb', verb); }
  } catch (e) { console.error('ERR', e.message); process.exitCode = 1; }
  finally { try { await browser.close(); } catch {} }
})();
