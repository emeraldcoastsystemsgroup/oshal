'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Harden the remote-node worker (retry/backoff, re-register when the control plane forgets us, best-effort deregister) and add content.* tools (extend-story producer + creative cycler + library/produced listing).
 */
/**
 * @description OSHAL swarm worker — joins the swarm as a remote client so the
 * swarm can queue background generate/story jobs to this machine's Chrome.
 *
 * Speaks the framework's existing remote-client API (no server change needed):
 *   POST /api/remote-clients/register
 *   POST /api/remote-clients/:id/heartbeat        (loop)
 *   GET  /api/remote-clients/:id/tasks/next        (poll)
 *   POST /api/remote-clients/:id/tasks/:taskId/complete | /fail
 *
 * Hardening (2026-07-07): the poll/heartbeat loop retries with capped exponential
 * backoff instead of hammering, and RE-REGISTERS automatically when the control
 * plane returns 401/404 (restarted and forgot this client) — the previous loop
 * spun silently forever after a server restart. Shutdown best-effort deregisters.
 *
 * Tasks arrive as `mcp.call-tool` with input { name, arguments }; results post back.
 * Honest: a failed render posts /fail with the real error, never a fake success.
 */
const os = require('os');
const { Operator } = require('../server');
const { produceStory } = require('../stories/produce');
const store = require('../storage/store');
const library = require('../content/library');

function cfg() {
  const base = (process.env.VIDS_SWARM_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('VIDS_SWARM_URL is required for worker mode (the OSHAL control-plane base URL).');
  return {
    base,
    secret: process.env.VIDS_SWARM_SECRET || '',
    authHeader: (process.env.VIDS_SWARM_AUTH_HEADER || 'x-remote-client-key').toLowerCase(),
    clientId: process.env.VIDS_CLIENT_ID || `vids-${os.hostname()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    name: process.env.VIDS_CLIENT_NAME || `Vids Operator (${os.hostname()})`,
    agentId: process.env.VIDS_AGENT_ID || undefined,
    heartbeatMs: Number(process.env.VIDS_HEARTBEAT_MS || 10_000),
    pollMs: Number(process.env.VIDS_POLL_MS || 2_500),
    backoffCapMs: Number(process.env.VIDS_BACKOFF_CAP_MS || 30_000),
  };
}

const TOOLS = [
  { name: 'content.produce', description: 'Animate ONE story across ~10 continuous scenes in Google Vids (Extend chain), download it, and save to the content folder + Google Drive. Args: storyId (library id) OR {title, script} OR idea; optional beats, orientation, characterImage.' },
  { name: 'content.next', description: 'Produce the NEXT unproduced story from the rotating library (fables / fairytales / famous sayings) — the creative cycler entry point. No args needed; optional beats, packOrder.' },
  { name: 'content.list', description: 'List stories already produced + stored (from their manifests). Args: limit.' },
  { name: 'content.library', description: 'List the available content packs and stories the cycler can make.' },
  { name: 'vids.story', description: 'Push a STORY (idea or storyboard plan, optional spoke) — the bot storyboards + builds it in Google Vids and returns the result to pull back.' },
  { name: 'vids.generate', description: 'Generate a single Veo clip from a prompt and place it on the timeline.' },
  { name: 'vids.chat', description: 'Ask the Veo specialist how to get a result out of the tool.' },
  { name: 'brand.graphic', description: 'Build an ON-BRAND OSHAL motion graphic (the validated electric-"oshal" look) from a short brief, in Google Vids. Returns the project URL.' },
  { name: 'brand.intro', description: 'Build the canonical OSHAL intro: electric-"oshal" Veo graphic + optional Tyra voiceover + serious evening-news music. Returns the project URL.' },
  { name: 'episode.assemble', description: 'POST-PRODUCTION (no Veo, no cost): stitch an already-rendered episode from its scene clips — optional series intro first — and save it. Args: episodeId, title, clips[] (paths on this node), optional series, introClip, tailPadSec. Fails loudly on a missing or truncated clip.' },
];

/** @description A completion/failure response signalling the client is unknown to the control plane. @param {number} status HTTP status @returns {boolean} true if we should re-register */
function isForgotten(status) { return status === 401 || status === 403 || status === 404; }

class VidsWorker {
  constructor(c, operator) {
    this.c = c;
    this.op = operator;
    this.running = false;
    this.registered = false;
    this.backoffMs = c.pollMs;
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.c.secret) {
      h[this.c.authHeader] = this.c.secret;
      h.authorization = `Bearer ${this.c.secret}`;
    }
    return h;
  }

  async api(method, pathSuffix, body) {
    return fetch(`${this.c.base}${pathSuffix}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** @description Register once; sets this.registered on success. @returns {Promise<boolean>} success */
  async register() {
    try {
      const res = await this.api('POST', '/api/remote-clients/register', {
        clientId: this.c.clientId,
        agentId: this.c.agentId,
        name: this.c.name,
        description: 'Screen-driving Veo studio operator (drives Google Vids in a local Chrome).',
        transport: 'http',
        platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
        controlPlaneUrl: this.c.base,
        mcpServerName: 'vids-operator',
        capabilities: TOOLS.map((t) => t.name),
        tags: ['vids', 'veo', 'desktop', 'worker', 'creative'],
      });
      if (!res.ok) { console.warn(`[vids-worker] register HTTP ${res.status}`); return false; }
      this.registered = true;
      this.backoffMs = this.c.pollMs;
      console.log(`[vids-worker] registered as ${this.c.clientId} → ${this.c.base}`);
      return true;
    } catch (err) {
      console.warn('[vids-worker] register error:', err.message || err);
      return false;
    }
  }

  async heartbeat() {
    try {
      const res = await this.api('POST', `/api/remote-clients/${this.c.clientId}/heartbeat`, {
        clientId: this.c.clientId,
        agentId: this.c.agentId,
        status: 'online',
        controlPlaneReachable: true,
        mcpReady: true,
        toolCount: TOOLS.length,
        lastSeenAt: new Date().toISOString(),
      });
      if (res && isForgotten(res.status)) { this.registered = false; console.warn('[vids-worker] heartbeat rejected — will re-register'); }
    } catch (err) {
      console.warn('[vids-worker] heartbeat error:', err.message || err);
    }
  }

  /** @description Poll once for a task. On a forgotten client, flip to re-register. @returns {Promise<boolean>} true if we handled a task */
  async pollOnce() {
    let res;
    try { res = await this.api('GET', `/api/remote-clients/${this.c.clientId}/tasks/next`); }
    catch (err) { this.backoffMs = Math.min(this.backoffMs * 2, this.c.backoffCapMs); console.warn('[vids-worker] poll network error, backoff', this.backoffMs, err.message || err); return false; }
    if (isForgotten(res.status)) { this.registered = false; return false; }
    this.backoffMs = this.c.pollMs; // healthy response resets backoff
    if (res.status === 204 || !res.ok) return false;
    const data = await res.json().catch(() => null);
    if (!data || !data.claimed || !data.task) return false;
    await this.handleTask(data.task);
    return true;
  }

  async handleTask(task) {
    const { taskId, correlationId, intent, input = {} } = task;
    console.log(`[vids-worker] task ${taskId} intent=${intent} tool=${input.name || ''}`);
    try {
      let output;
      if (intent === 'mcp.initialize') output = { ok: true, server: 'vids-operator' };
      else if (intent === 'mcp.list-tools') output = { tools: TOOLS };
      else if (intent === 'status.sync') output = { ok: true };
      else if (intent === 'mcp.shutdown') output = { ok: true };
      else if (intent === 'mcp.call-tool') output = await this.callTool(input.name, input.arguments || {});
      else throw new Error(`unsupported intent: ${intent}`);
      await this.complete(taskId, correlationId, output, input.name);
    } catch (err) {
      await this.fail(taskId, correlationId, String((err && err.message) || err));
    }
  }

  async callTool(name, args) {
    const workerLog = (e) => { if (e && e.message) console.log('[content]', e.message); };

    // POST-PRODUCTION. Runs where the media already is: the scene clips live in this node's
    // stage folder, so stitching here avoids shipping tens of MB back to the controller just
    // to concatenate them. No Veo call, no cost — a re-assembly is free, a re-render is not.
    if (name === 'episode.assemble') {
      const episodeId = String(args.episodeId || '').trim();
      const title = String(args.title || '').trim();
      const clips = Array.isArray(args.clips) ? args.clips.map(String) : [];
      if (!episodeId || !title) throw new Error('episode.assemble requires episodeId and title');
      if (!clips.length) throw new Error('episode.assemble requires clips[]');

      const { concatClips } = require('../media/assemble');
      const path = require('path');
      const fs = require('fs');
      const stageDir = path.join(process.env.VIDS_DATA_DIR || path.join(os.homedir(), '.oshal-vids'), 'stage');
      fs.mkdirSync(stageDir, { recursive: true });

      // The series intro is prepended when present. A missing intro is not silently dropped —
      // an episode without its intro is a different video than the one that was approved.
      const inputs = [];
      if (args.introClip) {
        if (!fs.existsSync(String(args.introClip))) throw new Error(`intro clip missing: ${args.introClip}`);
        inputs.push(String(args.introClip));
      }
      inputs.push(...clips);

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'episode';
      const outFile = path.join(stageDir, `${slug}.mp4`);
      // concatClips FAILS LOUD on a missing/truncated input rather than dropping it — a short
      // episode reported as a success is worse than an honest failure.
      const asm = concatClips(inputs, outFile, { tailPadSec: Number(args.tailPadSec ?? 0.45) });
      if (!asm.ok) throw new Error(`assemble failed: ${asm.error}`);

      const saved = await store.saveStory(asm.file, {
        pack: String(args.series || 'series'),
        id: episodeId,
        title,
        moral: '',
        filename: `${slug}.mp4`,
        sceneCount: inputs.length,
        mode: 'assembled',
      });
      if (!saved.ok) throw new Error(`save failed: ${saved.error}`);

      console.log(`[assemble] ${title}: ${inputs.length} clips -> ${saved.localPath}`);
      return {
        ok: true,
        episodeId,
        assembledPath: saved.localPath,
        clipCount: inputs.length,
        bytes: asm.bytes,
        // Never claim a Drive delivery that saveStory did not actually make.
        driveUrl: saved.drive && saved.drive.webViewLink ? saved.drive.webViewLink : null,
        drivePending: Boolean(saved.drivePending),
      };
    }

    if (name === 'content.produce' || name === 'content.next') {
      const spec = { ...args, onEvent: workerLog };
      if (name === 'content.next') spec.next = true; // cycler: pick the next unproduced story
      const r = await produceStory(spec);
      if (!r.ok) throw new Error(r.error || 'story production failed');
      return r;
    }
    if (name === 'content.list') return { produced: store.listProduced(Number(args.limit) || 50) };
    if (name === 'content.library') {
      return {
        packs: library.listPacks(),
        stories: library.allStories().map((s) => ({ id: s.id, pack: s.pack, title: s.title, moral: s.moral })),
        produced: [...store.producedIds()],
      };
    }

    if (name === 'vids.story') {
      const story = await this.op.runStorySync({ ...args, source: 'swarm' });
      return { ok: Boolean(story.result && story.result.ok), storyId: story.id, status: story.status, spoke: story.plan && story.plan.spoke, plan: story.plan, result: story.result };
    }
    if (name === 'vids.chat') {
      if (!this.op.bot) throw new Error('Veo bot not available (codex CLI missing).');
      const r = await this.op.bot.chat(String(args.message || args.text || ''), args.history || []);
      return { reply: r.reply };
    }
    if (name === 'brand.graphic' || name === 'brand.intro') {
      const { makeIntro, makeBrandGraphic } = require('../brand/graphics');
      const brief = String(args.brief || args.subject || args.prompt || '').trim();
      const opts = { subject: args.subject || brief, voiceover: args.voiceover, music: args.music, musicMood: args.musicMood, voice: args.voice, graphic: args.graphic };
      const r = name === 'brand.intro' ? await makeIntro(opts) : await makeBrandGraphic(brief, opts);
      if (!r.ok) throw new Error(r.error || (r.refused ? 'Veo refused the prompt (content filter).' : 'brand graphic failed'));
      return { ok: true, url: r.url, steps: r.steps };
    }
    if (name === 'vids.generate') {
      const job = this.op.makeJob({ ...args, source: 'swarm' });
      if (!job.prompt) throw new Error('vids.generate requires a prompt.');
      const done = await this.op.runJob(job);
      if (done.status !== 'done') throw new Error(done.error || `generation ${done.status}` + (done.result && done.result.failedAt ? ` at ${done.result.failedAt}` : ''));
      return { ok: true, jobId: done.id, finalPrompt: done.finalPrompt || done.prompt, steps: (done.result && done.result.steps) || [], healedSteps: (done.result && done.result.healedSteps) || [] };
    }
    throw new Error(`unknown tool: ${name}`);
  }

  async complete(taskId, correlationId, output, toolName) {
    await this.api('POST', `/api/remote-clients/${this.c.clientId}/tasks/${taskId}/complete`, { correlationId, output, toolName }).catch((e) => console.warn('[vids-worker] complete post error:', e.message || e));
    console.log(`[vids-worker] completed ${taskId}`);
  }

  async fail(taskId, correlationId, error) {
    await this.api('POST', `/api/remote-clients/${this.c.clientId}/tasks/${taskId}/fail`, { correlationId, error }).catch((e) => console.warn('[vids-worker] fail post error:', e.message || e));
    console.warn(`[vids-worker] failed ${taskId}: ${error}`);
  }

  /** @description Best-effort tell the control plane we're going offline. @returns {Promise<void>} */
  async deregister() {
    await this.api('POST', `/api/remote-clients/${this.c.clientId}/heartbeat`, { clientId: this.c.clientId, status: 'offline', lastSeenAt: new Date().toISOString() }).catch(() => {});
  }

  async loop() {
    this.running = true;
    const hb = setInterval(() => { if (this.registered) this.heartbeat(); }, this.c.heartbeatMs);
    const stop = async () => { if (!this.running) return; this.running = false; clearInterval(hb); await this.deregister(); };
    process.on('SIGINT', () => stop().finally(() => process.exit(0)));
    process.on('SIGTERM', () => stop().finally(() => process.exit(0)));

    while (this.running) {
      if (!this.registered) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await this.register();
        if (!ok) { this.backoffMs = Math.min(this.backoffMs * 2, this.c.backoffCapMs); await sleep(this.backoffMs); continue; }
        // eslint-disable-next-line no-await-in-loop
        await this.heartbeat();
      }
      // eslint-disable-next-line no-await-in-loop
      await this.pollOnce().catch((e) => console.warn('[vids-worker] poll error:', e.message || e));
      // eslint-disable-next-line no-await-in-loop
      await sleep(this.backoffMs);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startWorker() {
  const c = cfg();
  const operator = new Operator();
  try {
    const { createBot } = require('../bot/operator');
    operator.bot = createBot(operator);
  } catch {
    /* recipe-only worker if codex absent */
  }
  console.log(`[vids-worker] starting (bot ${operator.bot ? 'ready' : 'absent'}). Ensure Chrome is up: npx oshal-vids chrome`);
  const worker = new VidsWorker(c, operator);
  worker.loop().catch((err) => {
    console.error('[vids-worker] fatal:', err.message || err);
    process.exit(1);
  });
  return worker;
}

module.exports = { startWorker, VidsWorker };
