'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extend-story runner: drive Google Vids over CDP to animate a story across N continuous beats (prefer the Extend button, fall back to fresh generate), src-fetch each clip, concat into one MP4.
 */
/**
 * @description StoryExtendRunner — build a multi-scene STORY video in Google Vids
 * over CDP, then hand back one downloaded MP4.
 *
 * Built on the two mechanisms proven against live Vids (scripts/veo-clip.js):
 *   1. DOM-targeted control (Veo card, Mode combobox, hidden file input,
 *      Generate button, the `video[aria-label^="Generated video"]` render signal).
 *   2. Reliable download by fetching the rendered clip's <video> src through the
 *      browser's auth'd request context — the full project export stalls.
 *
 * For each beat it generates a Veo clip; from beat 2 on it PREFERS the "Extend"
 * affordance so Veo conditions the next shot on the previous frame (character +
 * style continuity — the whole reason to use Extend for a story). If the Extend
 * control isn't present it falls back to a fresh create-from-scratch generation
 * (continuity is then carried by the prompt only). Every beat is src-fetched to a
 * local stage dir; src/media/assemble.js concatenates them into the story MP4.
 *
 * Honesty: never reports a scene done without the real render signal; on failure
 * it stops with the real error and returns whatever clips already landed.
 *
 * NOTE: the Extend/Insert click-paths target visible labels as observed; the
 * exact selectors want one live tuning pass against real Vids (same open item as
 * the tool-director in BACKLOG.md). The generate + src-fetch + concat spine is
 * the proven, reliable path and always yields a downloadable video.
 */
const fs = require('fs');
const path = require('path');
const { concatClips } = require('../media/assemble');

const CDP = process.env.VIDS_CDP || process.env.VIDS_CDP_URL || 'http://127.0.0.1:9222';
// 2026-07-07 18:00:00 (maintainer@emeraldcoastsystemsgroup.com): per-scene fresh-tab
// retries (VIDS_SCENE_ATTEMPTS, default 3) + failure screenshots — Veo generations
// intermittently never complete at evening peak; a single stalled scene must not fail
// the whole 10-scene unit (unit retries re-render everything from scratch).
const RENDER_TIMEOUT_MS = Number(process.env.VIDS_RENDER_TIMEOUT_MS || 240000);
// Per-scene fresh-tab attempts before the unit fails (storyboard mode only).
const SCENE_ATTEMPTS = Number(process.env.VIDS_SCENE_ATTEMPTS || 3);
const CREATE_URL = 'https://docs.google.com/videos/create';

class StoryExtendRunner {
  /** @param {{onEvent?:function, stageDir?:string, cdp?:string, isAborted?:function, waitWhilePaused?:function}} deps runner dependencies */
  constructor({ onEvent = () => {}, stageDir, cdp, isAborted = () => false, waitWhilePaused = async () => {} } = {}) {
    this.onEvent = onEvent;
    this.cdp = cdp || CDP;
    this.stageDir = stageDir || path.join(process.env.VIDS_DATA_DIR || path.join(require('os').homedir(), '.oshal-vids'), 'stage');
    this.isAborted = isAborted;
    this.waitWhilePaused = waitWhilePaused;
  }

  emit(type, data) { try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ } }

  /**
   * @description Produce the story: one clip per beat, stitched into one MP4.
   * Modes: 'extend' (default — Extend-chain continuity, overlap-trimmed) or
   * 'storyboard' (I2V — scene 1 from scratch, then its extracted HERO FRAME
   * anchors every later scene via "Animate an image" + motion-only prompts;
   * beats extension drift because nothing accumulates).
   * @param {{beats:{n:number,prompt:string,narration?:string}[], filename?:string, orientation?:string, characterImage?:string, useExtend?:boolean, mode?:string, outFile?:string}} spec the built story script + output options
   * @returns {Promise<{ok:boolean, file?:string, clips:string[], sceneCount:number, mode:string, notes:string[], error?:string}>} result
   */
  async run(spec) {
    const beats = Array.isArray(spec.beats) ? spec.beats : [];
    if (!beats.length) return { ok: false, clips: [], sceneCount: 0, mode: 'none', notes: [], error: 'no beats to build' };
    const storyboard = spec.mode === 'storyboard';
    const useExtend = !storyboard && spec.useExtend !== false && process.env.VIDS_STORY_EXTEND !== '0';
    const orientation = spec.orientation || 'Landscape';
    const characterImage = spec.characterImage && fs.existsSync(spec.characterImage) ? spec.characterImage : null;
    fs.mkdirSync(this.stageDir, { recursive: true });

    const { chromium } = require('playwright');
    let browser;
    const clips = [];
    const notes = [];
    const extendedFlags = []; // per-scene: produced via Extend? (drives overlap trim at the stitch — MUST be function-scoped, the stitch runs after the page block)
    let extendedCount = 0;
    try {
      try {
        browser = await chromium.connectOverCDP(this.cdp, { timeout: 60000 });
      } catch (err) {
        // Root-caused live 2026-07-07: a LONG-LIVED debug Chrome accumulates hundreds of
        // execution contexts and can carry a hung target; connectOverCDP initializes every
        // target and stalls on the dead one, timing out even though /json/version and raw
        // ws work. Recovery = restart the DEDICATED video profile (never the main browser).
        if (/Timeout.*exceeded/i.test(String(err && err.message))) {
          throw new Error(
            `connectOverCDP timed out on ${this.cdp}. Likely a bloated/hung debug Chrome ` +
            `(too many targets). Restart the DEDICATED video profile: kill only chrome.exe ` +
            `processes whose command line contains "oshal-video-chrome", then relaunch ` +
            `chrome --remote-debugging-port=9222 --user-data-dir=<video profile> https://docs.google.com/videos`,
          );
        }
        throw err;
      }
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('no browser context on the debug Chrome (is Vids open on :9222?)');
      const keeperExists = ctx.pages().length >= 1;
      const page = await ctx.newPage();
      try {
        this.emit('log', { message: `Opening a new Vids project for a ${beats.length}-scene story…` });
        await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });

        const seenSrcs = new Set(); // every clip src already grabbed or present pre-Generate
        let heroImage = storyboard ? (characterImage || null) : null; // I2V anchor (extracted after scene 1 when not supplied)
        for (let i = 0; i < beats.length; i++) {
          if (this.isAborted()) throw new Error('aborted');
          await this.waitWhilePaused();
          const beat = beats[i];
          this.emit('step', { status: 'act', action: 'scene-start', reason: `scene ${i + 1}/${beats.length}` });
          const outPath = path.join(this.stageDir, `${(spec.filename || 'story').replace(/\.mp4$/i, '')}_scene${String(i + 1).padStart(2, '0')}.mp4`);

          let extended = false;
          if (storyboard) {
            // FRESH PROJECT TAB PER SCENE — the veo-clip.js/recap-SOP proven flow (a
            // reused panel's mode/upload state machine is where scene 2+ kept dying).
            // v6 (full recipe): spec.stills[i] = this beat's OWN directed panel.
            // Fallback: scene 1 from scratch, scenes 2+ animate the shared hero frame.
            const still = Array.isArray(spec.stills) && spec.stills[i] && fs.existsSync(spec.stills[i]) ? spec.stills[i] : null;
            const sceneImg = still || (i === 0 ? characterImage : heroImage);
            // Veo generations intermittently never complete (evening-peak stalls / soft
            // refusals) — retry THIS scene in a fresh tab instead of failing the unit.
            // A unit-level retry re-renders every scene from scratch (live 2026-07-07:
            // 5 random-scene stalls killed two episodes while 40 sibling scenes passed).
            let lastErr = null;
            for (let attempt = 1; attempt <= SCENE_ATTEMPTS; attempt++) {
              try { lastErr = null; await this._produceSceneFreshTab(ctx, beat.prompt, { image: sceneImg, orientation, outPath }); break; }
              catch (err) {
                lastErr = err;
                // Retry stalls AND policy refusals — the filter is inconsistent (the same
                // text passed on sibling scenes), so a fresh attempt often goes through.
                if (!/render timed out|render refused/i.test(String(err && err.message)) || attempt === SCENE_ATTEMPTS) break;
                this.emit('log', { message: `scene ${i + 1}: render never appeared (attempt ${attempt}/${SCENE_ATTEMPTS}) — retrying in a fresh tab…` });
              }
            }
            if (lastErr) throw lastErr;
          } else {
            if (i > 0 && useExtend) {
              extended = await this._tryExtend(page).catch(() => false);
              if (extended) extendedCount++;
              else notes.push(`scene ${i + 1}: Extend affordance not found — fresh generate (prompt-only continuity)`);
            }
            if (!extended) await this._openBeat(page, { first: i === 0, characterImage, orientation });

            await this._typePrompt(page, beat.prompt);
            // Baseline the clip srcs that exist BEFORE this generation (panel keeps prior
            // renders + inserted timeline copies in the DOM — root-caused live 2026-07-07:
            // an index-based grab kept re-downloading scene 1). Only a NEW src counts.
            for (const s of await this._collectSrcs(page)) seenSrcs.add(s);
            await this._generate(page);
            const src = await this._waitNewRender(page, seenSrcs);
            seenSrcs.add(src);
            await this._grabClip(page, src, outPath);
            // Also place the render onto the Vids timeline so the PROJECT holds the
            // merged story. Best-effort: the downloaded clip is already safe.
            try { await this._insertExact(page); } catch { notes.push(`scene ${i + 1}: timeline Insert button not found (clip still captured)`); }
          }
          clips.push(outPath);
          extendedFlags.push(extended);
          if (storyboard && i === 0 && !heroImage && !(Array.isArray(spec.stills) && spec.stills.some(Boolean))) {
            // Freeze the world: scene 1's mid-clip frame becomes the anchor for every later scene.
            const { extractFrame } = require('../media/assemble');
            const hero = extractFrame(outPath, path.join(this.stageDir, `${(spec.filename || 'story').replace(/\.mp4$/i, '')}_hero.png`));
            if (hero.ok) { heroImage = hero.file; this.emit('log', { message: `Hero frame extracted → ${path.basename(hero.file)} (anchors scenes 2-${beats.length}).` }); }
            else notes.push(`hero frame extraction failed (${hero.error}) — falling back to prompt-only continuity`);
          }
          this.emit('step', { status: 'act', action: 'scene-done', reason: `scene ${i + 1} captured (${storyboard ? 'storyboard' : extended ? 'extend' : 'generate'})` });
        }
      } finally {
        try { if (keeperExists) await page.close(); } catch { /* keep chrome alive */ }
      }

      const outFile = spec.outFile || path.join(this.stageDir, spec.filename || 'story.mp4');

      // v5: OUR narrator speaks the actual script over the animation (Veo's in-clip
      // speech is a roulette — audio renders but the words are unreliable, which made
      // the story unintelligible). Clip audio becomes a ducked ambience bed.
      let narrations = [];
      if (spec.narrate !== false && process.env.VIDS_LOCAL_NARRATION !== '0') {
        try {
          const { narrateBeats } = require('../media/narrate');
          const base = (spec.filename || 'story').replace(/\.mp4$/i, '');
          // v9 (operator law): NEVER dub over mouths. Dialogue is Veo's (in-clip,
          // lip-synced). Local audio = [VO] narrator lines ONLY, at their windows,
          // with windowed ducking so in-clip dialogue stays untouched.
          const nr = await narrateBeats(beats, this.stageDir, base, { onEvent: this.onEvent });
          narrations = nr.entries; // {file, atMs}|null per beat — [VO] rows only
          const spoken = narrations.filter(Boolean).length;
          if (spoken) this.emit('log', { message: `Narrator ready: ${spoken} [VO] lines (${nr.engine}).` });
          if (nr.failures) notes.push(`${nr.failures} narration lines failed to synth`);
        } catch (err) {
          notes.push(`local narration unavailable (${String(err && err.message)}) — clip audio kept`);
        }
      }

      this.emit('log', { message: `Stitching ${clips.length} scene clips into ${path.basename(outFile)} (extend-overlap trim on ${extendedFlags.filter(Boolean).length} joins${narrations.some(Boolean) ? ', narrated' : ''})…` });
      // Extended clips begin with the previous clip's ~0.25s tail (the conditioning
      // lead-in) — trim it so the join plays once, not twice.
      const asm = concatClips(clips, outFile, { trimHeads: extendedFlags, narrations, clipAudio: spec.clipAudio, tailPadSec: spec.tailPadSec });
      if (!asm.ok) return { ok: false, clips, sceneCount: clips.length, mode: storyboard ? 'storyboard' : (extendedCount ? 'extend' : 'generate'), notes, error: `assemble failed: ${asm.error}` };
      notes.push(`${extendedCount}/${Math.max(0, beats.length - 1)} transitions used Extend`);
      return { ok: true, file: asm.file, bytes: asm.bytes, clips, sceneCount: clips.length, mode: storyboard ? 'storyboard' : (extendedCount ? 'extend' : 'generate'), notes };
    } catch (err) {
      return { ok: false, clips, sceneCount: clips.length, mode: storyboard ? 'storyboard' : (extendedCount ? 'extend' : 'generate'), notes, error: String((err && err.message) || err) };
    } finally {
      try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
  }

  /** @description Produce ONE scene in a FRESH project tab — a direct port of the veo-clip.js flow proven live against Vids (2026-07-01) and mandated by the recap SOP ("every clip is a brand-new video"): new tab → /videos/create → Veo card → (mode → Animate an image → hidden input upload)? → prompt → Generate → wait for the Generated-video element → src-fetch → close ONLY this tab. Sidesteps the reused-panel state machine entirely. @param {object} ctx browser context @param {string} prompt scene prompt @param {{image:?string, orientation:string, outPath:string}} o options @returns {Promise<void>} */
  async _produceSceneFreshTab(ctx, prompt, o) {
    const page = await ctx.newPage();
    try {
      await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });
      await this._dismissStartDialog(page);
      await this._openVeoPanel(page);
      if (o.image) {
        // Mode FIRST, THEN the hidden file input (recap SOP order; the input only exists in
        // that mode, and the native dialog must never open).
        await this._setMode(page, 'Animate an image');
        await page.waitForTimeout(800);
        await this._setFile(page, o.image);
        await page.waitForTimeout(4500);
      }
      await this._setOrientation(page, o.orientation);
      await this._typePrompt(page, prompt);
      // Baseline BEFORE Generate — even a fresh project's Veo panel now lists the
      // account's RECENT generations, so "any https src" stole 10 old gallery clips
      // in 70s flat (live 2026-07-07 21:08 run). Only a src that appears after our
      // click counts as this scene's render — and only after a realistic generation
      // time (the gallery keeps hydrating old entries long past the baseline).
      const pre = new Set(await this._collectSrcs(page));
      await this._generate(page);
      // Fingerprint = this scene's most distinctive prompt line (a says-line when there
      // is one) — the finished render's aria-label quotes the prompt back verbatim.
      const lines = String(prompt).split('\n').map((l) => l.trim()).filter(Boolean);
      const key = (lines.find((l) => /says:/.test(l)) || lines[0] || '').slice(0, 80);
      const src = await this._waitNewRender(page, pre, { minMs: Number(process.env.VIDS_MIN_RENDER_MS || 110000), key });
      await this._grabClip(page, src, o.outPath);
    } catch (err) {
      // Diagnostic: what was the Veo panel actually showing (soft-refusal card,
      // stuck spinner, error banner)? Best-effort — the failure still propagates.
      try {
        const shot = path.join(this.stageDir, `scene-fail-${Date.now()}.jpg`);
        await page.screenshot({ path: shot, type: 'jpeg', quality: 60, timeout: 5000 });
        this.emit('log', { message: `scene failure screenshot → ${path.basename(shot)}` });
      } catch { /* ignore */ }
      throw err;
    } finally {
      // Close ONLY this scene's tab; the keeper (and the run's main page) stay open.
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  /** @description Open a fresh Veo generation for a beat (panel → mode → optional image → orientation). @param {object} page Playwright page @param {{first:boolean,characterImage:?string,orientation:string}} o beat options @returns {Promise<void>} */
  async _openBeat(page, o) {
    await this._openVeoPanel(page);
    await this._setMode(page, o.characterImage ? 'Animate an image' : 'Create from scratch');
    if (o.characterImage) { await this._setFile(page, o.characterImage); await page.waitForTimeout(3000); }
    await this._setOrientation(page, o.orientation);
  }

  /** @description Open the Veo "AI video clip" panel (getting-started card or the right-rail button). The rail icon TOGGLES the panel — clicking it while the panel is already open (e.g. scene 2+ in storyboard mode, right after a render) closes it and strands the run (live-found 2026-07-06). Skip when a prompt box is already visible; recover once if a click left it closed. @param {object} page Playwright page @returns {Promise<void>} */
  async _openVeoPanel(page) {
    if (await this._promptBox(page).count().catch(() => 0)) return; // panel already open
    try {
      const card = page.locator('button:has-text("Generate 8-second")').first();
      await card.waitFor({ state: 'visible', timeout: 8000 });
      await card.click();
      return;
    } catch { /* the pre-Omni getting-started card is gone in the 2026-07-30 UI */ }
    const rail = page.locator('[aria-label="Generate an AI video clip"]').first();
    await rail.waitFor({ state: 'visible', timeout: 20000 });
    await rail.click();
    await page.waitForTimeout(1500);
    if (!(await this._promptBox(page).count().catch(() => 0))) {
      await rail.click(); // the first click toggled it closed — reopen
      await page.waitForTimeout(1500);
    }
  }

  /**
   * @description Dismiss the Omni start dialog that Vids began showing on every new project
   * (observed 2026-07-30). It is MODAL: while it is up, the right-rail "Generate an AI video clip"
   * button is visible but not clickable, so the old flow died on a 30s click timeout with no
   * explanation. "Blank vid" is the dialog's own way of saying "just open the editor".
   * @param {object} page Playwright page
   * @returns {Promise<void>} nothing
   */
  async _dismissStartDialog(page) {
    for (const sel of ['button:has-text("Blank vid")', '[aria-label="Close"]']) {
      const el = page.locator(sel).filter({ visible: true }).first();
      if (await el.count().catch(() => 0)) {
        await el.click({ timeout: 10000 }).catch(() => { /* fall through to Escape */ });
        break;
      }
    }
    await page.keyboard.press('Escape').catch(() => { /* nothing focused */ });
    await page.waitForTimeout(2500);
  }

  /**
   * @description The generation prompt box. Vids replaced the old `textarea` with a
   * contenteditable `div[role=textbox]` ("Add your image, then describe what should happen in your
   * vid") on 2026-07-30; both are matched so this works either side of that change.
   * @param {object} page Playwright page
   * @returns {object} a Playwright locator for the prompt box
   */
  _promptBox(page) {
    return page.locator('textarea:visible, div[role=textbox]:visible').first();
  }

  /**
   * @description Choose how the clip is generated. Vids replaced the Mode combobox with TABS —
   * Create / Edit / Animate — on 2026-07-30. "Animate an image" is the Animate tab; anything else
   * is Create. The old combobox is still tried first so a node on the previous UI keeps working.
   * @param {object} page Playwright page
   * @param {string} mode option label ("Animate an image" | "Create from scratch")
   * @returns {Promise<void>} nothing
   */
  async _setMode(page, mode) {
    try {
      const combo = page.locator('[role=combobox][aria-label="Mode"]').first();
      await combo.waitFor({ state: 'visible', timeout: 5000 });
      await combo.click();
      const opt = page.locator(`[role=option]:has-text("${mode}")`).first();
      await opt.waitFor({ state: 'visible', timeout: 8000 });
      await opt.click();
      await page.waitForTimeout(700);
      return;
    } catch { /* the combobox is gone — fall through to the tabs */ }
    const tabName = /animate/i.test(mode) ? 'Animate' : 'Create';
    try {
      const tab = page.locator(`button[role=tab]:has-text("${tabName}")`).first();
      await tab.waitFor({ state: 'visible', timeout: 20000 });
      await tab.click({ timeout: 10000 });
      await page.waitForTimeout(2500);
      // The inspiration gallery covers the controls on a fresh panel; collapse it when offered.
      const gallery = page.locator('button:has-text("Hide gallery")').filter({ visible: true }).first();
      if (await gallery.count().catch(() => 0)) {
        await gallery.click({ timeout: 6000 }).catch(() => { /* already hidden */ });
        await page.waitForTimeout(1200);
      }
    } catch { /* single-mode UI */ }
  }

  /** @description Set a still on the hidden file input across any same-origin frame. @param {object} page Playwright page @param {string} file absolute image path @returns {Promise<void>} */
  async _setFile(page, file) {
    for (const frame of page.frames()) {
      try {
        const inp = frame.locator('input[type=file]').first();
        if (await inp.count()) { await inp.setInputFiles(file, { timeout: 20000 }); return; }
      } catch { /* cross-origin frame */ }
    }
    throw new Error('no file input found for the character image');
  }

  /** @description Best-effort orientation chip selection. @param {object} page Playwright page @param {string} orientation Landscape|Portrait|Square @returns {Promise<void>} */
  async _setOrientation(page, orientation) {
    try {
      const chip = page.locator(`button:has-text("${orientation}"), [aria-label*="${orientation}" i]`).first();
      if (await chip.count()) { await chip.click({ timeout: 4000 }); }
    } catch { /* default orientation */ }
  }

  /** @description Enter the prompt: bulk-fill instantly, then REAL keystrokes for the tail. fill() alone sometimes leaves Generate disabled (no key events); per-char typing of a full v3 prompt (~1600 chars) blows the 30s action timeout over CDP — the hybrid does both jobs. @param {object} page Playwright page @param {string} text prompt @returns {Promise<void>} */
  async _typePrompt(page, text) {
    const box = this._promptBox(page);
    await box.waitFor({ state: 'visible', timeout: 20000 });
    await box.click();
    const t = String(text);
    const tail = t.slice(-8);
    const head = t.slice(0, -8);
    // `fill()` only works on real form controls. The 2026-07-30 UI's contenteditable needs the text
    // inserted through the keyboard/clipboard path instead, or it stays empty and Generate never enables.
    const isFormControl = await box.evaluate((el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT').catch(() => true);
    if (isFormControl) {
      await box.fill(head, { timeout: 30000 });
    } else {
      await box.evaluate((el) => { el.focus(); }).catch(() => { /* click already focused it */ });
      await page.evaluate((s) => document.execCommand('insertText', false, s), head).catch(async () => {
        await box.pressSequentially(head.slice(0, 400), { delay: 1, timeout: 30000 });
      });
    }
    await box.pressSequentially(tail, { delay: 25, timeout: 30000 });
    await page.waitForTimeout(1000);
  }

  /** @description Click the blue Generate button. @param {object} page Playwright page @returns {Promise<void>} */
  async _generate(page) {
    await page.getByRole('button', { name: 'Generate', exact: true }).first().click({ timeout: 20000 });
  }

  /** @description All fetchable https srcs of rendered-clip elements currently in the DOM. @param {object} page Playwright page @returns {Promise<string[]>} srcs */
  async _collectSrcs(page) {
    // Veo 3.1 panel (probed live 2026-07-07 22:15): renders live on
    // contribution-rt.usercontent.google.com; the panel ALSO embeds Google's
    // inspiration-gallery demo videos from ssl.gstatic.com (a rapper, a lion, a
    // sushi chef…) — the source of tonight's stolen-clip episodes. Exclude those
    // always; read currentSrc too (src may be set as a property, not an attribute).
    const entries = await this._videoEntries(page);
    return entries.map((e) => e.src);
  }

  /** @description All real render <video>s on the page: {src, aria}. Demo/stock videos excluded. @param {object} page Playwright page @returns {Promise<{src:string,aria:string}[]>} entries */
  async _videoEntries(page) {
    return page.evaluate(() => [...document.querySelectorAll('video')]
      .map((v) => ({ src: v.currentSrc || v.getAttribute('src') || '', aria: (v.getAttribute('aria-label') || '').replace(/\s+/g, ' ') }))
      .filter((e) => /^https?:/.test(e.src) && !/ssl\.gstatic\.com/.test(e.src))).catch(() => []);
  }

  /** @description Wait for a rendered clip whose src is NEW (not in seen). The panel keeps prior renders in the DOM, so identity is the src URL — never an element index. @param {object} page Playwright page @param {Set<string>} seen already-known srcs @returns {Promise<string>} the new clip's src */
  async _waitNewRender(page, seen, opts = {}) {
    const start = Date.now();
    const deadline = start + RENDER_TIMEOUT_MS;
    // A real Veo render takes minutes. The panel's recent-generations gallery keeps
    // lazy-loading OLD entries after any baseline snapshot, so a "new" src appearing
    // sooner than minMs is a gallery ghost — absorb it into the baseline and keep
    // waiting (live 2026-07-07: two junk episodes of stolen gallery clips, 70s/scene).
    const minMs = Number(opts.minMs || 0);
    // Veo 3.1: a finished render's aria-label contains its PROMPT text — a fingerprint
    // that identifies OUR clip with certainty among recents (probed live 2026-07-07).
    const key = opts.key ? String(opts.key).replace(/\s+/g, ' ').trim() : '';
    // Vids shows a policy card instead of a render when the prompt trips the content
    // filter (operator-observed live 2026-07-07: "something in the text can't be
    // generated"). Fail FAST on it — waiting the full window reads as a mystery stall.
    const refusal = page.getByText(/can.?t be generated|couldn.?t be generated|against (our|the) (policies|terms)|try a different prompt/i).first();
    let lastWake = 0;
    // Srcs that appeared AFTER Generate but which we have not accepted yet. Keeping them as
    // candidates instead of folding them into `seen` is what makes a fast render survive: the old
    // code absorbed anything arriving before minMs as a gallery ghost and could then never return
    // it, so a clip that rendered in 90s timed out with the finished video visible on screen
    // (live 2026-07-30, the Omni pipeline is quicker than Veo 3.1 was).
    const candidates = [];
    while (Date.now() < deadline) {
      if (this.isAborted()) throw new Error('aborted');
      const entries = await this._videoEntries(page);
      if (key) {
        const mine = entries.find((e) => e.aria.includes(key) && e.src && !seen.has(e.src));
        if (mine) return mine.src;
      }
      for (const { src } of entries) {
        if (seen.has(src) || candidates.includes(src)) continue;
        candidates.push(src);
      }
      // The fingerprint is preferred but no longer required: the Omni panel does not always quote
      // the prompt back in an aria-label. In a FRESH project tab, a video src that was not present
      // before Generate and has outlived the ghost window is this scene's render.
      if (candidates.length && Date.now() - start >= minMs) return candidates[candidates.length - 1];
      if (await refusal.count().catch(() => 0)) throw new Error('render refused (content-policy card shown)');
      // In a fresh tab the finished clip stays an UNMOUNTED thumbnail (timed out 3x
      // with the render on screen) — after a realistic render time, poke the newest
      // duration badge every ~10s so the player mounts and exposes its src.
      if (Date.now() - start > Math.max(minMs, 110000) && Date.now() - lastWake > 10000) {
        lastWake = Date.now();
        try {
          const badge = page.getByText(/^\d+:\d{2}$/).first();
          if (await badge.count()) await badge.click({ force: true, timeout: 3000 });
        } catch { /* wake is best-effort */ }
      }
      await page.waitForTimeout(2000);
    }
    throw new Error('render timed out (no NEW Generated video src appeared)');
  }

  /** @description Save a rendered clip by fetching its src through the auth'd request context. @param {object} page Playwright page @param {string} src the clip's https src @param {string} outPath destination @returns {Promise<void>} */
  async _grabClip(page, src, outPath) {
    const resp = await page.context().request.get(src, { timeout: 90000 });
    if (!resp.ok()) throw new Error(`clip src fetch HTTP ${resp.status()}`);
    const buf = await resp.body();
    if (buf.length < 60000) throw new Error(`clip too small (${buf.length} bytes)`);
    // Atomic publish: a kill mid-write would otherwise leave a fresh-mtime PARTIAL mp4
    // at the final path, which passes every staleness/size guard and silently shortens
    // the episode (2026-07-08 review). Rename is atomic within an NTFS volume.
    const tmp = `${outPath}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, outPath);
  }

  /** @description Place the just-rendered clip onto the timeline. TWO steps (operator-observed live 2026-07-06): click the newest card's exact-name Insert (the gallery is newest-first, so .first(); a loose "Insert" match hits the "Insertion" rail menu), then a "Previewing" popup appears with [Retry] [Insert in new scene] — click the blue "Insert in new scene" confirm or the clip never lands on the timeline. Best-effort — callers must not let failure kill the run. @param {object} page Playwright page @returns {Promise<void>} */
  async _insertExact(page) {
    // filter({visible}) matters: .first() alone can select a HIDDEN match (e.g. inside the
    // dismissed getting-started dialog) and waitFor then times out even though a visible
    // twin exists — this silently skipped scenes 3-16 on the 2026-07-06 run.
    const btn = page.getByRole('button', { name: 'Insert', exact: true }).filter({ visible: true }).first();
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(1200);
    // The confirm popup. If it doesn't appear (UI variant), the card Insert alone did the job.
    const confirm = page.getByRole('button', { name: 'Insert in new scene' }).filter({ visible: true }).first();
    await confirm.waitFor({ state: 'visible', timeout: 6000 });
    await confirm.click();
    await page.waitForTimeout(1000);
  }

  /** @description Continue the previous clip via the card's Extend button (exact name — a loose match can hit rail menus). Confirmed live: the panel switches to an "Extend" header with a "what should happen next" prompt box. @param {object} page Playwright page @returns {Promise<boolean>} true if Extend was engaged */
  async _tryExtend(page) {
    try {
      // visible filter + .first(): the gallery is newest-first, so the first VISIBLE
      // Extend belongs to the newest render (hidden matches would break waitFor).
      const ext = page.getByRole('button', { name: 'Extend', exact: true }).filter({ visible: true }).first();
      await ext.waitFor({ state: 'visible', timeout: 6000 });
      await ext.click();
      await page.waitForTimeout(1200);
      return true;
    } catch { return false; }
  }
}

module.exports = { StoryExtendRunner };
