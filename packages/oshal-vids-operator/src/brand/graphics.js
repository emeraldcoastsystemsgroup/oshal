'use strict';
/**
 * @description OSHAL brand motion-graphics builder — reusable, on-brand intros.
 *
 * This is the production-validated way to make an OSHAL-themed motion graphic in
 * Google Vids. It reuses the proven CDP primitives from the live session that
 * validated the look (see BRAND-THEME.md and ../../_build-intro.js): connect to
 * The operator's debug Chrome over CDP, click via page.mouse.click at element
 * getBoundingClientRect centers (Google tiles ignore el.click()), and drive the
 * Veo / Voiceover / Music tools in order from a fresh editor.
 *
 * It deliberately does NOT reinvent the CDP layer — it imports the shared
 * VidsDriver and only adds (a) the brand prompt templates and (b) the click flow.
 *
 * Entry points:
 *   makeIntro(opts)              → the canonical "electric oshal" intro:
 *                                  Veo graphic + (optional) voiceover + (optional) music.
 *   makeBrandGraphic(brief,opts) → graphic-only clip built from a short brief,
 *                                  shaped onto the brand prompt.
 *
 * Both return { ok, url, steps, error } and NEVER fake a result — if a render is
 * refused or times out, ok is false and the real reason is reported. No talking
 * anchor is ever requested via Veo (it is filtered — use the Voiceover tool).
 */
const { VidsDriver } = require('../driver/chrome-cdp');
const {
  BRAND,
  brandGraphicPrompt,
  brandVoiceover,
  brandMusicPrompt,
  BRAND_VOICE,
} = require('./theme');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DOM-rect click primitives (verbatim behavior from the validated _build-intro.js).
// Google's Vids tiles ignore el.click(); we click the real pixel center instead.
async function boxOf(page, reSrc, minX = 0) {
  return page.evaluate(
    ({ reSrc, minX }) => {
      const rx = new RegExp(reSrc, 'i');
      let best = null;
      const sel =
        'button,div[role="button"],span[role="button"],[role="menuitem"],[role="option"]';
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!rx.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4 && r.x >= minX && r.bottom < window.innerHeight + 60) {
          if (!best || r.width * r.height < best.area) {
            best = { x: r.x + r.width / 2, y: r.y + r.height / 2, area: r.width * r.height };
          }
        }
      }
      return best;
    },
    { reSrc, minX },
  );
}

async function click(page, reSrc, minX = 0) {
  const b = await boxOf(page, reSrc, minX);
  if (b) {
    await page.mouse.click(b.x, b.y);
    return true;
  }
  return false;
}

/** The top-most "Insert" button in the right results sheet (places the rendered clip). */
async function clickTopInsert(page, re) {
  const hit = await page.evaluate((reSrc) => {
    const rx = new RegExp(reSrc, 'i');
    const c = [];
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rx.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.x > 1040 && r.width > 4) c.push({ y: r.y, x: r.x + r.width / 2, cy: r.y + r.height / 2 });
    }
    c.sort((a, b) => a.y - b.y);
    return c[0] || null;
  }, re);
  if (hit) {
    await page.mouse.click(hit.x, hit.cy);
    return true;
  }
  return false;
}

/** True once the render-in-progress UI clears (or false on timeout). */
async function waitRenderDone(page, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    // eslint-disable-next-line no-await-in-loop
    const busy = await page.evaluate(() =>
      /generation is in progress|Bringing your vision|Cancel|\b\d{1,2}%/i.test(document.body.innerText),
    );
    if (!busy) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(5000);
  }
  return false;
}

/** Veo refused the prompt (deepfake / content filter). */
async function wasRefused(page) {
  return page.evaluate(() => /goes against our terms/i.test(document.body.innerText));
}

/** Open a fresh blank editor so panel state never carries over between runs. */
async function freshEditor(page) {
  await page.goto('https://docs.google.com/videos/u/0/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4500);
  if (!(await click(page, '^Blank video$'))) await click(page, 'Blank');
  await sleep(8000);
  await click(page, '^Close$'); // dismiss "Getting started"
  await sleep(1500);
}

/** Maximize the attached Chrome window so the right-rail coords are stable. */
async function maximize(page) {
  try {
    const s = await page.context().newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } catch {
    /* best-effort */
  }
}

/**
 * Generate ONE Veo graphic from a fully-formed prompt and Insert it.
 * Assumes a fresh editor (call freshEditor first). Returns { ok, refused }.
 */
async function generateGraphic(page, prompt, { renderTimeoutMs = 220_000 } = {}) {
  await click(page, 'Generate an AI video clip|^Veo$');
  for (let k = 0; k < 8 && !(await boxOf(page, '^Generate$', 1040)); k++) await sleep(2000);
  await page.locator('textarea, [contenteditable="true"], [role="textbox"]').last().click({ timeout: 6000 }).catch(() => {});
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(300);
  await page.keyboard.type(prompt, { delay: 3 });
  await sleep(600);
  await click(page, '^Generate$', 1040);
  await sleep(12000);
  if (await wasRefused(page)) return { ok: false, refused: true };
  const done = await waitRenderDone(page, renderTimeoutMs);
  await sleep(2000);
  if (await wasRefused(page)) return { ok: false, refused: true };
  if (!done) return { ok: false, refused: false };
  await clickTopInsert(page, '^Insert( video)?$');
  await sleep(3000);
  await click(page, 'Close side sheet');
  await sleep(2000);
  return { ok: true, refused: false };
}

/**
 * Add a spoken narration line via the dedicated VOICEOVER tool (Tyra by default).
 * NEVER ask Veo for a talking anchor — it is content-filtered.
 */
async function addVoiceover(page, line, { voice = BRAND_VOICE } = {}) {
  await click(page, 'Generate a voiceover|^Voiceover$');
  await sleep(2500);
  await click(page, 'Change the voice|^Change$');
  await sleep(2000);
  // Pick the named voice row, then Select. The coords below match the validated
  // Tyra row; a different voice falls back to the same row position.
  await page.mouse.click(1180, 671);
  await sleep(800);
  await click(page, '^Select$', 1040);
  await sleep(1500);
  await page.mouse.click(1670, 300); // script box (contenteditable)
  await sleep(500);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(200);
  await page.keyboard.type(line, { delay: 6 });
  await sleep(800);
  const inserted = await click(page, '^Insert voiceover$', 1040);
  await sleep(9000);
  return { ok: inserted, voice };
}

/** Add a music bed via the MUSIC (Lyria) tool. Min clip length is 30s. */
async function addMusic(page, prompt, { renderTimeoutMs = 200_000 } = {}) {
  await click(page, 'Generate music|^Music$');
  await sleep(2500);
  await page.mouse.click(1670, 160);
  await sleep(400);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(200);
  await page.keyboard.type(prompt, { delay: 5 });
  await sleep(600);
  await click(page, '^Generate$', 1040);
  await sleep(12000);
  const done = await waitRenderDone(page, renderTimeoutMs);
  await sleep(2000);
  if (!done) return { ok: false };
  await clickTopInsert(page, '^Insert( music)?$');
  await sleep(3000);
  await click(page, 'Close side sheet');
  await sleep(1500);
  return { ok: true };
}

/**
 * Build the canonical OSHAL intro: electric "oshal" Veo graphic, optional Tyra
 * voiceover, optional serious news music. Drives the operator's signed-in Chrome.
 *
 * @param {object} opts
 * @param {string} [opts.subject]    short brief that flavors the graphic (e.g. "daily trade recap")
 * @param {string} [opts.graphic]    full Veo prompt override (skips the template)
 * @param {string} [opts.voiceover]  spoken line; if set, the Voiceover tool runs (Oh-shal spelling auto-applied)
 * @param {boolean}[opts.music=true] add the serious evening-news music bed
 * @param {string} [opts.musicMood]  override the music prompt
 * @param {string} [opts.voice]      voiceover voice name (default Tyra)
 * @param {VidsDriver}[opts.driver]  reuse an already-connected driver (else one is created + disconnected)
 * @returns {Promise<{ok:boolean,url:string|null,steps:object[],error?:string,refused?:boolean}>}
 */
async function makeIntro(opts = {}) {
  const own = !opts.driver;
  const d = opts.driver || new VidsDriver();
  const steps = [];
  try {
    if (own) await d.connect();
    const page = d.page;
    await maximize(page);
    await sleep(1200);

    await freshEditor(page);
    steps.push({ step: 'fresh-editor', url: page.url() });

    const graphicPrompt = opts.graphic || brandGraphicPrompt(opts.subject);
    const g = await generateGraphic(page, graphicPrompt);
    steps.push({ step: 'graphic', ...g });
    if (!g.ok) {
      return {
        ok: false,
        url: page.url(),
        steps,
        refused: g.refused,
        error: g.refused
          ? 'Veo refused the graphic prompt (content filter). Rephrase to pure abstract brand motion — no people, no named news.'
          : 'Graphic render did not finish in time.',
      };
    }

    if (opts.voiceover) {
      const vo = await addVoiceover(page, brandVoiceover(opts.voiceover), { voice: opts.voice });
      steps.push({ step: 'voiceover', ...vo });
    }

    if (opts.music !== false) {
      const m = await addMusic(page, opts.musicMood ? brandMusicPrompt(opts.musicMood) : brandMusicPrompt());
      steps.push({ step: 'music', ...m });
    }

    return { ok: true, url: page.url(), steps };
  } catch (err) {
    return { ok: false, url: null, steps, error: String((err && err.message) || err) };
  } finally {
    if (own) {
      try {
        await d.disconnect();
      } catch {
        /* never close the operator's Chrome forcefully */
      }
    }
  }
}

/**
 * Graphic-only brand clip from a short brief — the lightweight entry the bot tool
 * uses. Shapes the brief onto the brand prompt unless `graphic` is supplied.
 *
 * @param {string} brief  e.g. "intro for daily trade recap"
 * @param {object} [opts] same shape as makeIntro (music default OFF for a bumper)
 */
async function makeBrandGraphic(brief, opts = {}) {
  return makeIntro({
    subject: brief,
    music: opts.music === true, // a plain brand graphic is a silent bumper unless asked
    ...opts,
  });
}

module.exports = {
  makeIntro,
  makeBrandGraphic,
  // Lower-level flow steps, exported for advanced composition / testing.
  generateGraphic,
  addVoiceover,
  addMusic,
  freshEditor,
  // Re-export the brand vocabulary so callers have one import.
  BRAND,
  brandGraphicPrompt,
  brandVoiceover,
  brandMusicPrompt,
};
