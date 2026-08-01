'use strict';
/**
 * @description Local control panel + computer-use job runner.
 *
 * Serves a themed UI at http://localhost:<PORT>. You talk to a packed-Codex agent
 * that OPERATES YOUR REAL COMPUTER: it screenshots your screen, moves your real
 * cursor, and clicks the real buttons to accomplish a goal (generate a clip in
 * Google Vids, or anything else). The left pane mirrors your real screen; the
 * right pane is the chat. No fixed recipe, no invisible automation.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Desktop } = require('./desktop/win');
const { ComputerUseAgent } = require('./agent/loop');
const { ScenesRunner } = require('./agent/scenes-runner');
const { ToolDirector } = require('./tools/director');
const { getStoryStore } = require('./stories/store');
const { DATA_DIR } = require('./learn/store');
const Scenarios = require('./scenarios/store');

const PORT = Number(process.env.VIDS_PORT || 8074);
const LEGACY_UI_DIR = path.resolve(__dirname, 'ui');
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist');
const KNOWLEDGE_DIR = path.resolve(__dirname, '..', 'knowledge');

/** Prefer the built Vite surface (web/dist); fall back to the legacy panel. */
function uiRoot() {
  return fs.existsSync(path.join(WEB_DIST, 'index.html')) ? WEB_DIST : LEGACY_UI_DIR;
}

function makeId() {
  makeId._n = (makeId._n || 0) + 1;
  return `job_${Date.now().toString(36)}_${makeId._n}`;
}

/** Turn a storyboard plan into a step-by-step goal the computer-use agent executes. */
function buildProductionGoal(plan) {
  const shots = plan.shots
    .map((s) => `Shot ${s.n} (${s.role || 'shot'}, ${s.orientation || 'Landscape'}, then ${s.place || 'Insert'}):\n  "${s.prompt}"`)
    .join('\n');
  const layers = (plan.layers || []).map((l) => `- ${l.type}: ${l.detail}`).join('\n');
  const assembly = (plan.assembly || []).map((a, i) => `${i + 1}. ${a}`).join('\n');
  return (
    `Build this short video PRODUCTION in Google Vids — multiple shots stitched together, then layers. Work ONE shot at a time.\n\n` +
    `STORYBOARD:\n${shots}\n\n` +
    `For EACH shot: open the "AI video clip" (Veo) panel, type that shot's prompt into the description box, set its orientation, click Generate, then WAIT for the clip to actually finish rendering (a thumbnail with a duration appears) before doing anything else. Then place it — Insert = a new scene/cut, Extend = continue the previous beat. Move on to the next shot.\n\n` +
    (layers ? `AFTER the shots are placed, add layers:\n${layers}\n(Use the Text tool for titles/CTA — never type words into a Veo prompt. Use the Music tool for the bed.)\n\n` : '') +
    (assembly ? `ASSEMBLY NOTES:\n${assembly}\n\n` : '') +
    (plan.why ? `WHY this works: ${plan.why}\n\n` : '') +
    `Be methodical and patient: generation takes time, so WAIT after each Generate. If you can't find a control, say so and stop — never guess a click.`
  );
}

/**
 * Turn a resolved scenario job into a TIGHT, ordered checklist the computer-use
 * agent executes verbatim. The whole point: no exploration, no re-deriving the
 * UI — name the exact rail tool, mode, and button per step so the agent (and its
 * token budget) just follows along. Surfaces map to the Vids runbook.
 */
function buildScenarioGoal(job) {
  const o = job.orientation || 'Landscape';
  const place = job.insertMode && String(job.insertMode).toLowerCase() !== 'none' ? job.insertMode : 'Insert';
  const stop = `If any control named above is missing, say so and STOP — never guess a click.`;

  if (job.surface === 'veo-scratch') {
    return (
      `Produce ONE clip in Google Vids. Follow these steps EXACTLY, in order:\n` +
      `1. In the right rail, click the "Veo" icon to open the "AI video clip" panel.\n` +
      `2. Make sure the mode dropdown reads "Create from scratch".\n` +
      `3. Click the prompt box and type EXACTLY: "${job.script || job.prompt}"\n` +
      `4. Set orientation to ${o} using the orientation chip.\n` +
      `5. Click "Generate". WAIT until a result card with a duration badge (e.g. 0:08) appears — do not click anything else while it renders.\n` +
      `6. Click "${place}" to place the clip on the timeline.\n` +
      stop
    );
  }

  // Default + 'avatar' fall through to the proven animate-a-still path.
  const motion = job.motion || 'The person looks at the camera and speaks naturally with subtle head movement and blinking; steady lighting; still background. No on-screen text, no logos.';
  // Spoken line in single quotes so the outer prompt's double-quotes stay clean.
  const veoPrompt = `${motion} The host says: '${job.script || job.prompt}'`;
  let n = 0;
  const step = (s) => `${(n += 1)}. ${s}`;
  const lines = [
    `Produce ONE talking-host clip in Google Vids by animating a still image. Follow these steps EXACTLY, in order:`,
    step(`In the right rail, click the "Veo" icon to open the "AI video clip" panel.`),
    step(`In the mode dropdown (top of the panel, default "Create from scratch"), choose "Animate an image".`),
    step(`Add the still: click "Ingredients" (or "Add image"). When the file picker opens, type this exact path and press Enter: ${job.ingredientPath}`),
    step(`Click the prompt box and type EXACTLY this: "${veoPrompt}"`),
    step(`Set orientation to ${o} using the orientation chip.`),
    step(`Click "Generate". WAIT until a result card with a duration badge (e.g. 0:08) appears — generation takes time; do not click anything else while it renders.`),
    step(`Click "${place}" to place the clip on the timeline.`),
  ];
  if (job.captions) lines.push(step(`In the right rail, click "Captions" and turn on auto-captions so the spoken line is subtitled.`));
  lines.push(stop);
  return lines.join('\n');
}

/**
 * Multi-scene consistent-host recap: animate the SAME still image once per scene and Insert each
 * onto ONE timeline, driven by the pixel agent (the proven path). Keeps the host identical across
 * stitched ~8s scenes — the reason "Animate an image" exists. job.scenes = spoken lines.
 */
function buildAnimateScenesGoal(job) {
  const o = job.orientation || 'Landscape';
  const img = job.ingredientPath || (job.files && job.files[0]) || '';
  const motion = job.motion ||
    'The person looks at the camera and speaks naturally with subtle head movement and blinking; steady studio lighting; still background; no on-screen text, no logos.';
  const lines = [
    `Build ONE multi-scene talking-host video in Google Vids. EVERY scene must ANIMATE THE SAME PHOTO so the host is the same person throughout.`,
    `Host photo path (attach this EXACT file in every scene): ${img}`,
    `CRITICAL RULES: (a) Use the "Animate an image" mode, NEVER "Create from scratch". (b) You MUST attach the host photo via the "Add image" box before generating. (c) The blue "Generate" button stays GREYED OUT until the photo is attached — if Generate looks greyed, the photo is NOT attached yet, so attach it first. Treat a greyed Generate as proof the image step is incomplete.`,
    `If you are on the Vids home/start screen, first start a NEW blank video. Then build ${job.scenes.length} scenes IN ORDER. For EACH scene do these steps, then move on to the next scene:`,
  ];
  job.scenes.forEach((line, i) => {
    lines.push(
      `\nSCENE ${i + 1} of ${job.scenes.length}:\n` +
      `  1. Open the "AI video clip" panel: click the "Veo" tool icon in the right-side vertical toolbar. If the panel is already open, skip this.\n` +
      `  2. At the TOP of the panel is a mode dropdown. It MUST read "Animate an image". If it reads "Create from scratch", click it and choose "Animate an image".\n` +
      `  3. ATTACH THE PHOTO (required): click the dashed "Add image" box in the panel. When the Windows file picker opens, type EXACTLY this path and press Enter: ${img}\n` +
      `     After this, a thumbnail of the photo must appear in the panel. Do not continue until it does.\n` +
      `  4. Click the description/prompt box and type EXACTLY: "${motion} The host says: '${line}'"\n` +
      `  5. Make sure orientation is ${o}.\n` +
      `  6. Confirm the "Generate" button is now BLUE/enabled (it is greyed until the photo is attached). Click "Generate" and WAIT until the result card shows a duration badge (e.g. 0:08) — do NOT click anything else while it renders.\n` +
      `  7. Click "Insert" to add this scene to the timeline as a new scene.`,
    );
  });
  lines.push(`\nWhen all ${job.scenes.length} scenes are inserted on the timeline, you are DONE. If a named control is missing, say so and STOP — never guess a click.`);
  return lines.join('\n');
}

/**
 * Goal text for the TOOL DIRECTOR (Phase 2). Unlike buildScenarioGoal (which
 * spells out clicks for the pixel agent), this DESCRIBES the desired video and
 * lets the director pick tools (generate_clip, animate_image, add_caption, …).
 */
function buildToolsGoal(job) {
  const o = job.orientation || 'Landscape';
  let goal;
  if (job.scenario && job.surface === 'animate-image') {
    goal =
      `Animate the still image at "${job.ingredientPath}" into a talking-host clip. ` +
      `Motion: ${job.motion || 'natural, looking at camera'}. The host says: '${job.script || job.prompt}'. ` +
      `Orientation ${o}. Then place the clip on the timeline.` +
      (job.captions ? ' Then add captions.' : '');
  } else if (job.scenario) {
    goal =
      `Generate a clip from this prompt: "${job.script || job.prompt}". Orientation ${o}. ` +
      `Then place the clip on the timeline.` + (job.captions ? ' Then add captions.' : '');
  } else {
    goal = job.prompt; // free-form: the director composes the tools it needs
  }
  if (job.files && job.files.length) {
    goal += `\n\nAsset files available (use add_image / animate_image as fitting): ${job.files.join(' ; ')}.`;
  }
  return goal;
}

function loadKnowledge() {
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8'))
      .join('\n\n')
      .slice(0, 12_000);
  } catch {
    return '';
  }
}

class Operator {
  constructor() {
    this.queue = [];
    this.history = [];
    this.current = null;
    this.agent = null;
    this.ready = false; // desktop control confirmed
    this.clients = new Set();
    this.tickerTimer = null;
    this.knowledge = loadKnowledge();
    this.addDirs = fs.existsSync(KNOWLEDGE_DIR) ? [KNOWLEDGE_DIR] : [];
    this.bot = null; // Veo prompt-craft advisor (optional)
    this.stories = getStoryStore();
    this.removePairedTypingListener = Desktop.onPairedTyping((state) => {
      this.broadcast({ type: 'paired-typing', state });
    });
  }

  /**
   * PUSH a story: plan it (if only an idea), queue the build, and return the
   * story record. PULL it back later with stories.get(id) / GET /api/stories/:id.
   */
  async createStory(spec) {
    const idea = spec.idea || spec.prompt || '';
    const story = this.stories.create({ idea, plan: spec.plan || null, source: spec.source || 'api', siteUrl: spec.siteUrl || null });
    let plan = spec.plan || null;
    if (!plan && idea && this.bot && this.bot.planProduction) {
      this.stories.update(story.id, { status: 'planning' });
      plan = await this.bot.planProduction(idea, { spoke: spec.spoke }).catch(() => null);
    }
    this.stories.update(story.id, { plan: plan || null, status: 'building' });
    const job = this.makeJob({ plan: plan || undefined, prompt: idea, kind: 'vids', source: 'story', siteUrl: spec.siteUrl, files: spec.files, storyId: story.id });
    this.stories.update(story.id, { jobId: job.id });
    this.queue.push(job);
    this.broadcast({ type: 'queued', job });
    this.drain();
    return this.stories.get(story.id);
  }

  /**
   * Synchronous story build for the swarm worker: plan, build to completion, and
   * return the finished story so the caller can pull the result straight back.
   */
  async runStorySync(spec) {
    const idea = spec.idea || spec.prompt || '';
    const story = this.stories.create({ idea, plan: spec.plan || null, source: spec.source || 'swarm', siteUrl: spec.siteUrl || null });
    let plan = spec.plan || null;
    if (!plan && idea && this.bot && this.bot.planProduction) {
      this.stories.update(story.id, { status: 'planning' });
      plan = await this.bot.planProduction(idea, { spoke: spec.spoke }).catch(() => null);
    }
    this.stories.update(story.id, { plan: plan || null, status: 'building' });
    const job = this.makeJob({ plan: plan || undefined, prompt: idea, kind: 'vids', source: spec.source || 'swarm', siteUrl: spec.siteUrl, files: spec.files, storyId: story.id });
    this.stories.update(story.id, { jobId: job.id });
    await this.runJob(job); // drives the screen to completion
    return this.stories.get(story.id);
  }

  broadcast(event) {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
  log(level, message, extra = {}) {
    this.broadcast({ type: 'log', level, message, ts: new Date().toISOString(), ...extra });
  }

  /** Confirm desktop control by taking one screenshot. No mirror — you watch your own screen. */
  async connect() {
    await Desktop.screenshot(); // throws if PowerShell/screen capture unavailable
    this.ready = true;
    const mons = await Desktop.monitors().catch(() => []);
    this.log('info', `Screen control ready. Capturing monitor ${process.env.VIDS_MONITOR ?? 'primary'}. Monitors: ${mons.join(' | ')}. Put Vids fullscreen on one and set VIDS_MONITOR to its index if needed.`);
    return { connected: true };
  }

  makeJob(spec) {
    return {
      id: spec.id || makeId(),
      status: 'queued',
      prompt: String(spec.prompt || spec.goal || '').trim(),
      orientation: spec.orientation || undefined,
      insertMode: spec.insertMode || undefined,
      mode: spec.mode || undefined,            // 'tools' = drive via the tool-director (Phase 2)
      scenario: spec.scenario || undefined,   // canned preset id (deterministic goal)
      surface: spec.surface || undefined,      // animate-image | veo-scratch | avatar
      script: spec.script || undefined,        // the filled spoken line
      motion: spec.motion || undefined,        // how the still should move
      captions: spec.captions || undefined,
      ingredientPath: spec.ingredientPath || undefined, // still/clip to condition on
      scenes: Array.isArray(spec.scenes) && spec.scenes.length ? spec.scenes : undefined, // multi-scene animate-image recap (one line per scene)
      siteUrl: spec.siteUrl || undefined,
      plan: spec.plan || undefined, // production storyboard (multi-shot + layers)
      files: Array.isArray(spec.files) && spec.files.length ? spec.files : undefined, // reference assets to use as Ingredients
      storyId: spec.storyId || undefined,
      kind: spec.kind || 'vids', // 'vids' = generate a clip; 'goal' = arbitrary task
      source: spec.source || 'panel',
      createdAt: new Date().toISOString(),
    };
  }

  enqueue(spec) {
    const job = this.makeJob(spec);
    if (!job.prompt) throw new Error('Tell me what you want.');
    this.queue.push(job);
    this.broadcast({ type: 'queued', job });
    this.drain();
    return job;
  }

  async drain() {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    try {
      await this.runJob(job);
    } finally {
      this.history.unshift(job);
      this.history = this.history.slice(0, 50);
      this.current = null;
      this.agent = null;
      setImmediate(() => this.drain());
    }
  }

  /** Build the goal sentence for a job and let the computer-use agent achieve it. */
  async runJob(job) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.broadcast({ type: 'job-start', job });
    try {
      if (!this.ready) await this.connect();

      let goal = job.prompt;
      if (job.kind === 'vids') {
        // Anchor first: bring Google Vids to the FRONT so the agent is actually
        // looking at the site it must drive (not the chat panel or another window).
        // VIDS_SITE_URL lets you point at YOUR exact project editor (…/videos/d/<id>/edit)
        // so it lands where the AI-clip panel is, instead of the flaky home screen.
        const siteUrl = job.siteUrl || process.env.VIDS_SITE_URL || 'https://docs.google.com/videos';
        this.log('info', `Opening ${siteUrl} …`);
        try {
          await Desktop.openSite(siteUrl);
          await Desktop.wait(6000); // let the page load before any clicking
        } catch (e) {
          this.log('error', `Could not open Vids: ${String(e.message || e)}`);
        }

        const front =
          `Google Vids (docs.google.com/videos) was just opened in the browser and should be the FRONT window. ` +
          `If you do NOT see Google Vids, STOP and say so — do not click. `;

        if (job.scenario) {
          // Canned preset: run a deterministic checklist (no exploration). This is
          // the token-saving path — the agent follows exact steps instead of
          // re-deriving the Vids UI every run.
          job.finalPrompt = job.script || job.prompt;
          this.log('info', `Scenario "${job.scenario}" (${job.surface || 'animate-image'}) — deterministic checklist.`);
          goal = front + buildScenarioGoal(job);
        } else if (Array.isArray(job.scenes) && job.scenes.length) {
          // Multi-scene consistent-host recap: animate the SAME still per scene + Insert, one timeline.
          job.finalPrompt = job.scenes.join(' || ');
          this.log('info', `Producing ${job.scenes.length}-scene animate-image recap (host still: ${job.ingredientPath || (job.files && job.files[0]) || 'none'}).`);
          goal = front + buildAnimateScenesGoal(job);
        } else if (job.plan && Array.isArray(job.plan.shots) && job.plan.shots.length) {
          // Advanced control: execute the storyboard — multi-shot + layers + stitch.
          job.finalPrompt = job.plan.shots.map((s) => s.prompt).join(' || ');
          this.log('info', `Producing ${job.plan.shots.length}-shot build: ${job.plan.title || ''}`);
          goal = front + buildProductionGoal(job.plan);
        } else {
          // Single clip (no plan — e.g. a worker/API job).
          let veoPrompt = job.prompt;
          if (this.bot && this.bot.optimizeJob) {
            const refined = await this.bot.optimizeJob(job).catch(() => null);
            if (refined && refined.prompt) { veoPrompt = refined.prompt; job.finalPrompt = refined.prompt; if (refined.orientation) job.orientation = refined.orientation; }
          }
          goal = front +
            `Open the "AI video clip" (Veo) panel (start a new/blank video first if on the home page). ` +
            `Type this prompt into the description box, set orientation to ${job.orientation || 'Landscape'}, ` +
            `click Generate, wait for the render, then Insert it onto the timeline. Prompt: "${veoPrompt}"`;
        }
        if (job.files && job.files.length) {
          goal += `\n\nReference files to use as INGREDIENTS for relevant shots: ${job.files.join(' ; ')}. ` +
            `To add one: click "Ingredients" in the Veo panel; when the file picker opens, type the full path and press Enter.`;
        }
      }

      // Tool-director (Phase 2): the LLM calls named tools instead of deciding
      // every pixel. Opt in per job (mode:'tools') or globally (VIDS_TOOL_MODE=1).
      // Multi-shot `plan` jobs stay on the pixel agent for now.
      const useTools = (job.mode === 'tools' || process.env.VIDS_TOOL_MODE === '1') && job.kind === 'vids' && !job.plan;
      const onEvent = (e) => {
        this.broadcast({ ...e, jobId: job.id });
        if (job.storyId && e.type === 'step' && e.status === 'act') {
          const cur = this.stories.get(job.storyId);
          this.stories.update(job.storyId, { progress: { steps: (cur?.progress?.steps || 0) + 1, lastAction: `${e.action} ${e.reason || ''}`.slice(0, 140) } });
        }
      };
      let result;
      if (Array.isArray(job.scenes) && job.scenes.length) {
        // Multi-scene consistent-host recap: deterministic executor (forces "Animate an image" +
        // Add image) — the pixel agent won't attach the photo. New blank video + per-scene
        // animate_image + insert_clip, all on one timeline.
        this.log('info', `Deterministic ${job.scenes.length}-scene animate-image run (host photo: ${job.ingredientPath || (job.files && job.files[0]) || 'none'}).`);
        this.agent = new ScenesRunner({ onEvent, addDirs: this.addDirs, runId: job.id });
        result = await this.agent.run({
          scenes: job.scenes,
          image: job.ingredientPath || (job.files && job.files[0]) || '',
          orientation: job.orientation,
          motion: job.motion,
        });
      } else if (useTools) {
        goal = (job.kind === 'vids' ? goal.split('\n\n')[0] + '\n\n' : '') + buildToolsGoal(job);
        this.log('info', 'Tool-director mode: the director calls named Vids tools (screen capture verifies).');
        this.agent = new ToolDirector({ knowledge: this.knowledge, addDirs: this.addDirs, runId: job.id, onEvent });
        result = await this.agent.run(goal);
      } else {
        this.agent = new ComputerUseAgent({
          knowledge: this.knowledge,
          addDirs: this.addDirs,
          runId: job.id,
          maxSteps: job.plan ? 90 : 30,
          onEvent,
        });
        result = await this.agent.run(goal);
      }
      job.status = result.ok ? 'done' : 'failed';
      job.result = result;
      job.finishedAt = new Date().toISOString();
      if (job.storyId) this.stories.update(job.storyId, { status: result.ok ? 'done' : 'failed', result: this.buildStoryResult(job, result) });
      this.broadcast({ type: 'job-end', job });
    } catch (err) {
      job.status = 'failed';
      job.error = String((err && err.message) || err);
      job.finishedAt = new Date().toISOString();
      if (job.storyId) this.stories.update(job.storyId, { status: 'failed', result: { ok: false, reason: job.error } });
      this.log('error', `Job failed: ${job.error}`, { jobId: job.id });
      this.broadcast({ type: 'job-end', job });
    }
    return job;
  }

  /** Assemble the pull-back result for a story: status, run artifacts, final frame. */
  buildStoryResult(job, result) {
    const runDir = path.join(DATA_DIR, 'runs', job.id);
    let lastFrame = null;
    try {
      const pngs = fs.readdirSync(runDir).filter((f) => f.startsWith('step-') && f.endsWith('.png')).sort();
      if (pngs.length) lastFrame = path.join(runDir, pngs[pngs.length - 1]);
    } catch { /* no frames */ }
    return {
      ok: result.ok,
      reason: result.reason,
      steps: result.steps,
      finalPrompt: job.finalPrompt || job.prompt,
      plan: job.plan || null,
      runDir,
      transcript: path.join(runDir, 'transcript.jsonl'),
      lastFrame,
    };
  }

  control(action) {
    if (!this.agent) return { ok: false, message: 'Nothing running.' };
    if (action === 'pause') this.agent.pause();
    else if (action === 'resume') this.agent.resume();
    else if (action === 'abort') this.agent.abort();
    else return { ok: false, message: `Unknown action: ${action}` };
    return { ok: true };
  }

  async setPairedTyping(enabled) {
    if (this.current) throw new Error('Change paired typing only while the operator is idle.');
    const state = await Desktop.setPairedTyping(Boolean(enabled));
    this.log(
      'info',
      state.enabled
        ? 'Paired typing enabled. Each ordinary key advances one prepared character; F8 pauses/resumes and F9 cancels.'
        : 'Paired typing disabled.',
    );
    return state;
  }

  state() {
    return {
      connected: this.ready,
      current: this.current,
      queue: this.queue,
      history: this.history,
      botReady: Boolean(this.bot),
      pairedTyping: Desktop.pairedTypingState(),
    };
  }

  /** Resolve a scenario id + args into a queued job, or a helpful error reply. */
  runScenario(id, args = {}, source = 'api') {
    const r = Scenarios.resolve(id, args);
    if (!r.ok) {
      if (r.missing) return { error: `Scenario "${id}" needs: ${r.missing.join(', ')}.`, missing: r.missing };
      return { error: r.error };
    }
    // `mode=tools` in the args routes the scenario through the tool-director.
    const mode = args.mode === 'tools' ? 'tools' : undefined;
    const job = this.enqueue({ ...r.spec, mode, source });
    return { job, script: r.spec.script };
  }

  async chat(message, history) {
    // Canned scenario shortcut: "scenario:stock-picks date=... picks=... image=..."
    const inv = Scenarios.parseInvocation(message);
    if (inv) {
      const r = this.runScenario(inv.id, inv.args, 'chat');
      if (r.error) return { reply: r.error };
      const preview = r.script.length > 80 ? `${r.script.slice(0, 77)}...` : r.script;
      return { reply: `Queued "${inv.id}" — checklist run, no guessing. Saying: "${preview}"`, jobId: r.job.id };
    }
    // Tool-director shortcut: "tools: <describe the video>" — the director calls
    // named Vids tools to build it (screen capture verifies between calls).
    const tm = String(message || '').match(/^tools:\s*(.+)$/is);
    if (tm) {
      const job = this.enqueue({ prompt: tm[1].trim(), kind: 'vids', mode: 'tools', source: 'chat' });
      return { reply: `On it via the tool-director: "${tm[1].trim().slice(0, 80)}"`, jobId: job.id };
    }
    if (!this.bot || !this.bot.chat) {
      // No advisor: treat any message as a goal for the agent to operate toward.
      const job = this.enqueue({ goal: message, kind: 'goal', source: 'chat' });
      return { reply: `On it — operating your screen toward: "${message}".`, jobId: job.id };
    }
    const result = await this.bot.chat(message, history);
    if (result && result.generate && result.generate.prompt) {
      const job = this.enqueue({ ...result.generate, kind: 'vids', source: 'chat' });
      return { reply: result.reply, jobId: job.id };
    }
    return result;
  }
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(res, relPath) {
  const root = uiRoot();
  const rel = relPath === '/' || relPath === '' ? 'index.html' : relPath.replace(/^\/+/, '');
  const full = path.join(root, rel);
  if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

function start() {
  const op = new Operator();
  try {
    const { createBot } = require('./bot/operator');
    op.bot = createBot(op);
  } catch {
    /* codex/bot unavailable — agent still operates via vision, just without prompt-craft. */
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, op.state());
      if (req.method === 'POST' && pathname === '/api/connect') {
        const r = await op.connect().catch((e) => ({ error: String(e.message || e) }));
        return sendJson(res, r.error ? 502 : 200, r);
      }
      if (req.method === 'GET' && pathname === '/api/scenarios') {
        return sendJson(res, 200, { scenarios: Scenarios.list() });
      }
      if (req.method === 'GET' && pathname === '/api/tools') {
        return sendJson(res, 200, { tools: require('./tools/registry').catalog() });
      }
      if (req.method === 'POST' && pathname === '/api/jobs') {
        const body = await readBody(req);
        // A scenario job carries {scenario, <blanks>, image} — resolve it to a
        // deterministic spec. A raw clip job (already has `script`/`prompt`) is
        // enqueued as-is.
        if (body.scenario && !body.script) {
          const r = op.runScenario(body.scenario, body, 'panel');
          if (r.error) return sendJson(res, 400, { error: r.error, missing: r.missing });
          return sendJson(res, 200, r.job);
        }
        try { return sendJson(res, 200, op.enqueue(body)); }
        catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && pathname === '/api/control') {
        const body = await readBody(req);
        return sendJson(res, 200, op.control(body.action));
      }
      if (req.method === 'POST' && pathname === '/api/paired-typing') {
        const body = await readBody(req);
        const state = await op.setPairedTyping(body.enabled);
        return sendJson(res, 200, state);
      }
      if (req.method === 'POST' && pathname === '/api/chat') {
        const body = await readBody(req);
        const r = await op.chat(body.message, body.history || []).catch((e) => ({ reply: `Error: ${e.message || e}` }));
        return sendJson(res, 200, r);
      }
      // --- Story connector: PUSH a story, PULL it back ---
      if (req.method === 'POST' && pathname === '/api/stories') {
        const body = await readBody(req);
        try { return sendJson(res, 201, await op.createStory(body)); }
        catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'GET' && pathname === '/api/stories') {
        return sendJson(res, 200, { stories: op.stories.list(Number(url.searchParams.get('limit')) || 50) });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/stories/')) {
        const story = op.stories.get(decodeURIComponent(pathname.slice('/api/stories/'.length)));
        return story ? sendJson(res, 200, story) : sendJson(res, 404, { error: 'story not found' });
      }
      // Static surface (built Vite app or legacy panel). SPA fallback to index.html.
      if (req.method === 'GET' && !pathname.startsWith('/api')) {
        return serveStatic(res, path.extname(pathname) ? pathname : 'index.html');
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    op.clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: op.state() }));
    ws.on('close', () => op.clients.delete(ws));
  });
  server.on('close', () => {
    Desktop.setPairedTyping(false);
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  Vids Operator (computer-use) → http://localhost:${PORT}`);
    console.log(`  Veo advisor: ${op.bot ? 'ready' : 'absent'} | desktop control: PowerShell\n`);
  });
  return { server, op };
}

module.exports = { start, Operator, PORT, buildScenarioGoal, buildToolsGoal };
