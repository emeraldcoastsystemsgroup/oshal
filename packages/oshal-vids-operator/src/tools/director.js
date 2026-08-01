'use strict';
/**
 * @description Tool director (ADR-073, Phase 2) — composes a video by CALLING
 * named tools, never by figuring out clicks.
 *
 * Each step: screenshot the real screen → Codex picks the SINGLE next tool call
 * from the registry (reasoning about the video, not the pixels) → the executor
 * runs that tool's deterministic click-path → the next screenshot lets the
 * director verify and choose the next call. This is the function-calling
 * counterpart to ComputerUseAgent (which decides every pixel itself) and exposes
 * the same run/pause/resume/abort surface so the server can drive either one.
 */
const fs = require('fs');
const path = require('path');
const { Desktop } = require('../desktop/win');
const { codexJson, getLastCodexError } = require('../bot/codex');
const { DATA_DIR } = require('../learn/store');
const { catalogText, get } = require('./registry');
const { ToolExecutor } = require('./executor');

class ToolDirector {
  constructor({ onEvent = () => {}, knowledge = '', addDirs = [], maxCalls = 24, runId = null } = {}) {
    this.onEvent = onEvent;
    this.knowledge = knowledge;
    this.addDirs = addDirs;
    this.maxCalls = maxCalls;
    this.runId = runId || `tools-${Date.now().toString(36)}`;
    this.logDir = path.join(DATA_DIR, 'runs', this.runId);
    this.paused = false;
    this.aborted = false;
    this.executor = new ToolExecutor({
      onEvent,
      addDirs,
      isAborted: () => this.aborted,
      waitWhilePaused: () => this.waitWhilePaused(),
    });
  }

  pause() { this.paused = true; Desktop.pauseTyping(); this.emit('paused', {}); }
  resume() { this.paused = false; Desktop.resumeTyping(); this.emit('resumed', {}); }
  abort() { this.aborted = true; Desktop.cancelTyping('agent_aborted'); }

  emit(type, data) { try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ } }

  record(entry) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'transcript.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* logging must never break a run */ }
  }

  async waitWhilePaused() {
    while (this.paused && !this.aborted) await Desktop.wait(250);
    if (this.aborted) throw new Error('aborted');
  }

  /** Drive `goal` to completion via tool calls. Returns {ok, calls, reason}. */
  async run(goal) {
    this.emit('goal-start', { goal });
    this.record({ kind: 'goal', goal, mode: 'tools', logDir: this.logDir });
    const history = [];

    for (let i = 0; i < this.maxCalls; i++) {
      await this.waitWhilePaused();
      const shot = await Desktop.screenshot();

      const prompt = [
        this.knowledge ? `Domain knowledge (use if relevant):\n${this.knowledge}` : '',
        `You are directing a video build in Google Vids by CALLING TOOLS. You do NOT click; ` +
          `each tool runs its own click-path. Look at the attached screenshot to verify state, ` +
          `then choose the SINGLE next tool to call.`,
        `TOOLS:\n${catalogText()}`,
        `GOAL: ${goal}`,
        history.length ? `Calls so far:\n${history.join('\n')}` : 'No calls yet.',
        `RULES: Only operate Google Vids — if it is not visible, return ` +
          `{"blocked":true,"reason":"<what you see instead>"}. Generate a clip BEFORE placing it. ` +
          `Place a clip (insert_clip/extend_clip) after it renders. When the GOAL is fully achieved, ` +
          `return {"done":true,"reason":"..."}.`,
        `Return ONLY one JSON object: {"tool":"<name>","params":{...},"done":false,"blocked":false,"reason":"..."}.`,
      ].filter(Boolean).join('\n\n');

      // eslint-disable-next-line no-await-in-loop
      const decision = await codexJson(prompt, { image: shot.path, addDirs: this.addDirs });
      if (!decision) {
        const why = getLastCodexError();
        this.record({ kind: 'no-decision', call: i + 1, error: why });
        this.emit('goal-end', { ok: false, reason: `director returned nothing${why ? ` — ${why}` : ''}` });
        return { ok: false, calls: i, reason: 'no decision from director' };
      }

      if (decision.blocked) {
        const reason = decision.reason || 'blocked';
        this.record({ kind: 'blocked', call: i + 1, reason });
        this.emit('goal-end', { ok: false, reason });
        return { ok: false, calls: i + 1, reason };
      }
      if (decision.done) {
        this.record({ kind: 'done', call: i + 1, reason: decision.reason });
        this.emit('goal-end', { ok: true, reason: decision.reason || 'goal complete' });
        return { ok: true, calls: i + 1, reason: decision.reason || 'done' };
      }

      const toolName = decision.tool;
      if (!toolName || !get(toolName)) {
        const reason = `director asked for unknown tool "${toolName}"`;
        this.record({ kind: 'bad-tool', call: i + 1, tool: toolName });
        this.emit('goal-end', { ok: false, reason });
        return { ok: false, calls: i + 1, reason };
      }

      const params = decision.params || {};
      this.record({ kind: 'call', call: i + 1, tool: toolName, params, reason: decision.reason });
      this.emit('step', { status: 'act', action: `call ${toolName}`, reason: decision.reason || '' });
      history.push(`${i + 1}. ${toolName}(${Object.keys(params).join(', ')}) — ${decision.reason || ''}`);

      try {
        // eslint-disable-next-line no-await-in-loop
        await this.executor.runTool(toolName, params);
      } catch (err) {
        const reason = `tool ${toolName} failed: ${String(err.message || err)}`;
        this.record({ kind: 'tool-fail', call: i + 1, tool: toolName, error: reason });
        this.emit('step', { status: 'fail', message: reason });
        this.emit('goal-end', { ok: false, reason });
        return { ok: false, calls: i + 1, reason };
      }
      // eslint-disable-next-line no-await-in-loop
      await Desktop.wait(600); // let the UI settle before the verification screenshot
    }

    this.emit('goal-end', { ok: false, reason: `hit call cap (${this.maxCalls})` });
    return { ok: false, calls: this.maxCalls, reason: 'call cap reached' };
  }
}

module.exports = { ToolDirector };
