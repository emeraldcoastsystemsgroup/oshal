/* veo-grab-src.js — bypass the flaky File>Download export: find the generated Veo clip's
 * <video> element in any open Vids tab, read its src, and fetch the bytes IN-PAGE (works for
 * blob: and googleusercontent URLs) -> save to --out. Grabs the raw 8s clip directly. */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const CDP = 'http://127.0.0.1:9222';
const out = process.argv[2] || 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator\\out\\grabbed.mp4';
(async () => {
  const b = await chromium.connectOverCDP(CDP);
  for (const ctx of b.contexts()) for (const page of ctx.pages()) {
    let u = ''; try { u = page.url(); } catch { continue; }
    if (!u.includes('docs.google.com/videos/d/')) continue;
    let vids;
    try { vids = page.locator('video[aria-label^="Generated video"]'); } catch { continue; }
    const n = await vids.count().catch(() => 0);
    for (let k = 0; k < n; k++) {
      const src = await vids.nth(k).getAttribute('src').catch(() => null);
      console.log('tab', u.slice(35, 55), 'video', k, 'src', (src || '(none)').slice(0, 70));
      if (!src) continue;
      try {
        // Playwright request context carries the browser's auth cookies + is NOT CORS-bound.
        const resp = await page.context().request.get(src, { timeout: 90000 });
        if (resp.ok()) {
          const buf = await resp.body();
          if (buf.length > 60000) { fs.writeFileSync(out, buf); console.log('GRABBED', out, Math.round(buf.length / 1024) + 'KB'); await b.close(); return; }
          console.log('body too small', buf.length);
        } else console.log('request status', resp.status());
      } catch (e) { console.log('request err', e.message); }
    }
  }
  console.log('NO_GRABBABLE_VIDEO');
  await b.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
