'use strict';
/**
 * @description Tool executor (ADR-073, Phase 2) — runs a registry tool's
 * deterministic steps on the REAL screen.
 *
 * The director decides WHICH tool to call; this runs the click-path. The only
 * vision used here is a FOCUSED locate ("where is THIS one control? → coords"),
 * which is far cheaper than the open-ended "what should I do next" loop. A fresh
 * screenshot is taken before each locate (the UI moves) and once after the whole
 * tool so the director can verify the result.
 */
const { Desktop } = require('../desktop/win');
const { codexVision } = require('../bot/codex');
const { resolveSteps } = require('./registry');

const LOCATE_TIMEOUT_MS = Number(process.env.VIDS_LOCATE_TIMEOUT_MS || 45_000);
const RENDER_TIMEOUT_MS = Number(process.env.VIDS_RENDER_TIMEOUT_MS || 240_000);
const MIN_CONFIDENCE = Number(process.env.VIDS_LOCATE_MIN_CONFIDENCE || 0.4);

class ToolExecutor {
  /**
   * @param {object} deps
   * @param {(e:object)=>void} [deps.onEvent]
   * @param {string[]} [deps.addDirs]    knowledge dirs for codex grounding
   * @param {()=>boolean} [deps.isAborted]
   * @param {()=>Promise<void>} [deps.waitWhilePaused]
   */
  constructor({ onEvent = () => {}, addDirs = [], isAborted = () => false, waitWhilePaused = async () => {} } = {}) {
    this.onEvent = onEvent;
    this.addDirs = addDirs;
    this.isAborted = isAborted;
    this.waitWhilePaused = waitWhilePaused;
  }

  emit(type, data) { try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ } }

  /**
   * Find one described control on the current screen. Returns absolute
   * {x,y} pixel coords, or null if not confidently found.
   */
  async locate(description) {
    const shot = await Desktop.screenshot();
    const prompt =
      `You see a screenshot of a Windows screen, ${shot.width} x ${shot.height} pixels. ` +
      `Find this ONE control and return its click point:\n"${description}"\n` +
      `Coordinates are NORMALIZED fractions: x in [0,1] from left, y in [0,1] from top. ` +
      `Return ONLY {"found":true|false,"x":..,"y":..,"confidence":0..1}. ` +
      `If you cannot clearly see it, return {"found":false}.`;
    const r = await codexVision(shot.path, prompt, { addDirs: this.addDirs, timeoutMs: LOCATE_TIMEOUT_MS });
    if (!r || r.found === false || r.x == null || r.y == null) return null;
    if (r.confidence != null && Number(r.confidence) < MIN_CONFIDENCE) return null;
    return {
      x: shot.originX + Number(r.x) * shot.width,
      y: shot.originY + Number(r.y) * shot.height,
      confidence: r.confidence,
    };
  }

  /**
   * Poll until the JUST-STARTED render finishes. Requires observing the render
   * actually IN PROGRESS before accepting "finished" — otherwise a leftover result
   * card from a previous clip makes this return instantly (false success).
   */
  async waitForRender() {
    const start = Date.now();
    const deadline = start + RENDER_TIMEOUT_MS;
    let sawProgress = false;
    await Desktop.wait(5000); // give the render a moment to actually start
    while (Date.now() < deadline) {
      await this.waitWhilePaused();
      if (this.isAborted()) throw new Error('aborted');
      const shot = await Desktop.screenshot();
      const r = await codexVision(
        shot.path,
        `You see the Google Vids editor just after clicking Generate on an AI video clip. ` +
          `Report the CURRENT state of THAT clip: "generating" if a progress percentage, ` +
          `progress bar, or spinner is visible; "finished" if a result clip card with a short ` +
          `duration badge (like 0:08) plus Insert/Extend buttons is shown; otherwise "idle". ` +
          `Return ONLY {"state":"generating"|"finished"|"idle"}.`,
        { addDirs: this.addDirs, timeoutMs: LOCATE_TIMEOUT_MS },
      );
      const state = r && r.state;
      if (state === 'generating') sawProgress = true;
      // Accept finished only once we've seen it generating (or enough time has passed
      // that a fast render could have started+finished between polls).
      if (state === 'finished' && (sawProgress || Date.now() - start > 30_000)) return true;
      await Desktop.wait(5000); // generation takes time; poll gently
    }
    throw new Error(`clip did not finish rendering within ${Math.round(RENDER_TIMEOUT_MS / 1000)}s`);
  }

  /** Click a described control; returns false if optional + not found. Retries the locate once. */
  async clickFind(find, { optional = false } = {}) {
    let at = await this.locate(find);
    if (!at) { await Desktop.wait(900); at = await this.locate(find); } // one retry — the focused locate can miss on first look
    if (!at) {
      if (optional) { this.emit('tool-step', { status: 'skip', find }); return false; }
      throw new Error(`could not find: ${find}`);
    }
    await Desktop.click(at.x, at.y);
    await Desktop.wait(700);
    return true;
  }

  /** Run one tool by name with params. Returns {ok, frame, reason}. */
  async runTool(name, params = {}) {
    const steps = resolveSteps(name, params); // throws on unknown tool
    this.emit('tool-start', { tool: name, params: redact(params) });
    for (const step of steps) {
      await this.waitWhilePaused();
      if (this.isAborted()) throw new Error('aborted');
      this.emit('tool-step', { status: 'start', tool: name, action: step.action, find: step.find });
      // eslint-disable-next-line no-await-in-loop
      await this.runStep(step);
    }
    // One verification frame after the whole tool.
    const shot = await Desktop.screenshot();
    this.emit('tool-end', { tool: name });
    return { ok: true, frame: shot.path };
  }

  async runStep(step) {
    switch (step.action) {
      case 'click':
        await this.clickFind(step.find, { optional: step.optional });
        return;
      case 'type': {
        if (step.find) await this.clickFind(step.find, { optional: step.optional });
        await Desktop.type(String(step.value || ''));
        await Desktop.wait(400);
        return;
      }
      case 'key':
        await Desktop.key(String(step.key || '{ENTER}'));
        await Desktop.wait(400);
        return;
      case 'wait':
        await Desktop.wait(Number(step.ms) || 1000);
        return;
      case 'wait_render':
        await this.waitForRender();
        return;
      case 'upload': {
        const found = await this.clickFind(step.find, { optional: step.optional });
        if (!found) return; // optional control absent
        await Desktop.wait(1200); // let the file dialog open
        await Desktop.type(String(step.file || ''));
        await Desktop.key('{ENTER}');
        await Desktop.wait(1500);
        return;
      }
      case 'ensure': {
        if (step.present && (await this.locate(step.present))) return; // already in target state
        await this.clickFind(step.find, { optional: step.optional });
        return;
      }
      default:
        throw new Error(`unknown step action: ${step.action}`);
    }
  }
}

function redact(params) {
  const p = { ...params };
  for (const k of Object.keys(p)) {
    if (typeof p[k] === 'string' && p[k].length > 80) p[k] = `${p[k].slice(0, 77)}...`;
  }
  return p;
}

module.exports = { ToolExecutor };
