'use strict';
/**
 * @description Computer-use loop — a packed Codex agent that operates the REAL
 * computer toward a goal. Each step: screenshot the real screen → Codex looks at
 * it and decides the SINGLE next action → execute it on the real desktop (the
 * operator's actual cursor moves and clicks) → repeat until the goal is done.
 *
 * Not a fixed recipe: the agent figures out the app from what's on screen. Works
 * on Google Vids or anything else. Honest: it only acts on what the screenshot
 * shows, narrates each action, and stops when it judges the goal complete.
 */
const fs = require('fs');
const path = require('path');
const { Desktop } = require('../desktop/win');
const { codexVision, getLastCodexError } = require('../bot/codex');
const { DATA_DIR } = require('../learn/store');

const ACTION_SPEC = `
You operate a real Windows computer to accomplish a goal. You see a screenshot of
the WHOLE screen (width W x height H). Decide the SINGLE next action. Coordinates
are NORMALIZED fractions of the screenshot: x in [0,1] from left, y in [0,1] from top.

Actions:
- {"action":"click","x":..,"y":..}            left-click a point
- {"action":"double_click","x":..,"y":..}     double-click (e.g. open a project)
- {"action":"move","x":..,"y":..}             move cursor only
- {"action":"type","text":"..."}              type into the ALREADY-focused field
- {"action":"key","key":"{ENTER}"}            SendKeys combo ({ENTER}, ^a, {TAB})
- {"action":"scroll","amount":-3}             wheel (negative = down)
- {"action":"wait","ms":1500}                 wait for the UI / a render
- {"action":"say","text":"..."}               REPORT and STOP (use when blocked/unsure)
- {"action":"done"}                           goal achieved; stop

HARD RULES — safety first:
- Only operate the app/site named in the GOAL. If it is NOT clearly visible on
  screen, do NOT click anything — return {"action":"say","text":"I don't see <the
  site>; what I see is <describe>"}. Never guess a click on the wrong window.
- NEVER click window close/minimize/maximize buttons (top-right), a browser tab's
  close "x", the address bar, the taskbar, or anything that could close/switch the
  app. Stay inside the app's content area.
- Include "confidence" 0..1. If confidence < 0.6, use "wait" or "say" — never a
  blind click. One wrong click can close the app, so when unsure, STOP.
- Set "done":true ONLY when the goal is visibly complete. Always include a short
  "reason". Click a field before typing. If a render is in progress, "wait".
`;

class ComputerUseAgent {
  constructor({ onEvent = () => {}, knowledge = '', addDirs = [], maxSteps = 30, runId = null } = {}) {
    this.onEvent = onEvent;
    this.knowledge = knowledge;
    this.addDirs = addDirs;
    this.maxSteps = maxSteps;
    this.runId = runId || `run-${Date.now().toString(36)}`;
    this.logDir = path.join(DATA_DIR, 'runs', this.runId);
    this.paused = false;
    this.aborted = false;
  }

  /** Append a structured line to this run's transcript + echo to stdout. */
  record(entry) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'transcript.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* logging must never break a run */ }
    // eslint-disable-next-line no-console
    console.log(`[vids ${this.runId}]`, JSON.stringify(entry).slice(0, 300));
  }

  pause() { this.paused = true; this.emit('paused', {}); }
  resume() { this.paused = false; this.emit('resumed', {}); }
  abort() { this.aborted = true; }

  emit(type, data) {
    try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ }
  }

  async waitWhilePaused() {
    while (this.paused && !this.aborted) await Desktop.wait(250);
    if (this.aborted) throw new Error('aborted');
  }

  /** Run the agent toward `goal`. Returns { ok, steps, reason }. */
  async run(goal) {
    this.emit('goal-start', { goal });
    this.record({ kind: 'goal', goal, logDir: this.logDir });
    this.emit('log', { message: `logging this run to ${this.logDir}` });
    const history = [];
    for (let step = 0; step < this.maxSteps; step++) {
      await this.waitWhilePaused();

      const shot = await Desktop.screenshot();
      // Keep the exact frame the agent saw this step, so we can review its decision.
      const framePath = path.join(this.logDir, `step-${String(step + 1).padStart(2, '0')}.png`);
      try { fs.mkdirSync(this.logDir, { recursive: true }); fs.copyFileSync(shot.path, framePath); } catch { /* ignore */ }

      const prompt = [
        this.knowledge ? `Domain knowledge (use if relevant):\n${this.knowledge}` : '',
        ACTION_SPEC.replace('W x height H', `${shot.width} x height ${shot.height}`),
        `GOAL: ${goal}`,
        history.length ? `Recent actions:\n${history.slice(-8).join('\n')}` : 'No actions yet.',
        `Decide the next action now. Return ONLY the JSON object.`,
      ].filter(Boolean).join('\n\n');

      const decision = await codexVision(shot.path, prompt, { addDirs: this.addDirs });
      if (!decision || !decision.action) {
        const why = getLastCodexError();
        this.record({ kind: 'no-action', step: step + 1, frame: framePath, error: why, screen: `${shot.width}x${shot.height}` });
        this.emit('step', { status: 'fail', message: `vision returned no action${why ? ` — ${why}` : ''}` });
        return { ok: false, steps: step, reason: 'no action from vision' };
      }

      const absX = shot.originX + (Number(decision.x) || 0) * shot.width;
      const absY = shot.originY + (Number(decision.y) || 0) * shot.height;
      this.record({
        kind: 'step', step: step + 1, frame: framePath, screen: `${shot.width}x${shot.height}`,
        action: decision.action, x: decision.x, y: decision.y, abs: `${Math.round(absX)},${Math.round(absY)}`,
        text: decision.text, key: decision.key, reason: decision.reason,
      });
      this.emit('step', {
        status: 'act',
        action: decision.action,
        reason: decision.reason || '',
        x: decision.x,
        y: decision.y,
      });
      history.push(`${step + 1}. ${decision.action}${decision.text ? ` "${String(decision.text).slice(0, 40)}"` : ''} — ${decision.reason || ''}`);

      // Stop rather than guess: explicit "say", or a low-confidence click-type action.
      const clicky = ['click', 'double_click', 'right_click', 'type', 'key'].includes(decision.action);
      const lowConf = decision.confidence != null && Number(decision.confidence) < 0.6;
      if (decision.action === 'say' || (lowConf && clicky)) {
        const text = decision.action === 'say'
          ? (decision.text || decision.reason || 'stopping')
          : `not confident where to act (${decision.reason || ''}) — stopping instead of guessing`;
        this.record({ kind: 'say', step: step + 1, text, confidence: decision.confidence });
        this.emit('log', { message: text });
        this.emit('goal-end', { ok: false, reason: text });
        return { ok: false, steps: step + 1, reason: text };
      }

      if (decision.action === 'done' || decision.done) {
        this.record({ kind: 'done', step: step + 1, reason: decision.reason });
        this.emit('goal-end', { ok: true, reason: decision.reason || 'goal complete' });
        return { ok: true, steps: step + 1, reason: decision.reason || 'done' };
      }

      try {
        await this.execute(decision, shot);
      } catch (err) {
        this.emit('step', { status: 'fail', message: `action failed: ${String(err.message || err)}` });
        return { ok: false, steps: step + 1, reason: String(err.message || err) };
      }
      // Let the UI settle / animations play before the next look.
      await Desktop.wait(decision.action === 'wait' ? Number(decision.ms) || 1500 : 700);
    }
    this.emit('goal-end', { ok: false, reason: `hit step cap (${this.maxSteps})` });
    return { ok: false, steps: this.maxSteps, reason: 'step cap reached' };
  }

  /** Map a normalized decision to an absolute action on the real desktop. */
  async execute(d, shot) {
    const absX = shot.originX + (Number(d.x) || 0) * shot.width;
    const absY = shot.originY + (Number(d.y) || 0) * shot.height;
    switch (d.action) {
      case 'click': return Desktop.click(absX, absY);
      case 'double_click': return Desktop.click(absX, absY, { double: true });
      case 'right_click': return Desktop.click(absX, absY, { button: 'right' });
      case 'move': return Desktop.move(absX, absY);
      case 'type': return Desktop.type(String(d.text || ''));
      case 'key': return Desktop.key(String(d.key || '{ENTER}'));
      case 'scroll': return Desktop.scroll(Number(d.amount) || -3);
      case 'wait': return; // handled by the post-action delay
      default: throw new Error(`unknown action: ${d.action}`);
    }
  }
}

module.exports = { ComputerUseAgent };
