'use strict';
/**
 * @description Deterministic multi-scene "animate the same host photo" runner.
 *
 * The pixel agent (ComputerUseAgent) reliably opens Vids but keeps defaulting to
 * "Create from scratch" and skips attaching the host photo, so it can't make a
 * consistent talking-host. This runner instead drives the DETERMINISTIC tool
 * executor (forced, located clicks): start a blank video, then for each scene
 * animate_image(the SAME photo) + insert_clip. Same pause/abort surface as the
 * other agents so server.js can swap it in for jobs that carry `scenes`.
 */
const { Desktop } = require('../desktop/win');
const { ToolExecutor } = require('../tools/executor');

const DEFAULT_MOTION =
  'The person looks at the camera and speaks naturally with subtle head movement and blinking; steady studio lighting; still background; no on-screen text, no logos.';

class ScenesRunner {
  constructor({ onEvent = () => {}, addDirs = [], runId = null } = {}) {
    this.onEvent = onEvent;
    this.addDirs = addDirs;
    this.runId = runId;
    this.aborted = false;
    this.paused = false;
  }

  pause() { this.paused = true; Desktop.pauseTyping(); }
  resume() { this.paused = false; Desktop.resumeTyping(); }
  abort() { this.aborted = true; Desktop.cancelTyping('agent_aborted'); }
  async waitWhilePaused() {
    while (this.paused && !this.aborted) await Desktop.wait(250);
    if (this.aborted) throw new Error('aborted');
  }
  emit(type, data) { try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ } }

  /** @param {{scenes:string[], image:string, orientation?:string, motion?:string}} spec */
  async run(spec) {
    const scenes = Array.isArray(spec.scenes) ? spec.scenes : [];
    const image = spec.image || '';
    const orientation = spec.orientation || 'Landscape';
    const motion = spec.motion || DEFAULT_MOTION;
    if (!scenes.length) return { ok: false, reason: 'no scenes' };
    if (!image) return { ok: false, reason: 'no host image path' };

    const exec = new ToolExecutor({
      onEvent: this.onEvent,
      addDirs: this.addDirs,
      isAborted: () => this.aborted,
      waitWhilePaused: () => this.waitWhilePaused(),
    });

    // Start a fresh blank video. On the Vids HOME, click the "Start a new video" plus tile, which
    // opens a "Hello… let's start creating" dialog; click the "Blank vid" card to open the editor.
    // The editor MUST be open (modal dismissed) before animate_image, or the Veo/mode locates miss.
    this.emit('log', { message: 'Starting a new blank video…' });
    await this.waitWhilePaused();
    await exec.clickFind("the 'Start a new video' plus tile/card on the Google Vids home page", { optional: true });
    await Desktop.wait(2500); // creation dialog animates in
    // The creation dialog shows tiles (Veo, AI avatar, Convert Slides, …) and a "Blank vid" card.
    const blank = await exec.clickFind("the 'Blank vid' card (a large plus + icon labeled 'Blank vid') in the 'let's start creating' dialog", { optional: true });
    if (!blank) {
      // Fallback wording if the card label reads differently.
      await exec.clickFind("the option to start a blank/empty video in the new-video dialog", { optional: true });
    }
    await Desktop.wait(5000); // editor + timeline load before we open the Veo panel

    let made = 0;
    for (let i = 0; i < scenes.length; i++) {
      await this.waitWhilePaused();
      const prompt = `${motion} The host says: '${scenes[i]}'`;
      this.emit('log', { message: `Scene ${i + 1}/${scenes.length}: animate host photo + render` });
      this.emit('step', { status: 'act', action: 'scene-start', reason: `scene ${i + 1}: ${scenes[i].slice(0, 60)}` });
      // animate_image forces: open panel -> Animate an image -> Add image (the photo) -> prompt -> Generate -> wait
      await exec.runTool('animate_image', { image, prompt, orientation });
      await exec.runTool('insert_clip');
      made += 1;
      this.emit('step', { status: 'act', action: 'scene-done', reason: `scene ${i + 1} inserted` });
    }
    return { ok: made === scenes.length, steps: made, reason: `${made}/${scenes.length} scenes generated + inserted` };
  }
}

module.exports = { ScenesRunner };
