'use strict';
/**
 * @description The Veo-specialist bot — packed Codex, grounded in knowledge/.
 *
 * Three jobs, one persona:
 *   chat(message, history)  — advise on the tool / shape a prompt (grounded chat)
 *   optimizeJob(job)        — turn a raw idea into an optimized Veo prompt + opts
 *   visionFallback(ctx)     — when a recipe step can't find its target, decide
 *                             the {action, target} from the page's clickable
 *                             labels (+ screenshot when Codex supports images)
 *
 * createBot returns null-safe stubs if the codex CLI isn't present, so the panel
 * still runs in recipe-only mode (P1 behavior) without the bot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codexAsk, codexJson, codexAvailable, getLastCodexError } = require('./codex');
const { getStore } = require('../learn/store');
const { SPOKES, detectSpoke } = require('../stories/spokes');

const KNOWLEDGE_DIR = path.resolve(__dirname, '..', '..', 'knowledge');

const PERSONA = `You are the Veo Specialist — the operator of Google Vids' "AI video clip"
(Veo) generator. You know Veo prompt craft cold: subject + action + setting +
camera move + lighting + palette + mood, plus "no text, no logos" hygiene,
Landscape/Portrait framing, and Insert-vs-Extend on the timeline. You are honest:
you never claim a clip exists until the editor confirms the render, and you
surface real errors instead of inventing results. Keep replies short and concrete.`;

function readKnowledge() {
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => `# ${f}\n${fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8')}`)
      .join('\n\n')
      .slice(0, 16_000); // keep prompts bounded; --add-dir carries the full set
  } catch {
    return '';
  }
}

function createBot(operator) {
  if (!codexAvailable()) return null;
  const addDirs = fs.existsSync(KNOWLEDGE_DIR) ? [KNOWLEDGE_DIR] : [];
  const knowledge = readKnowledge();
  const store = getStore();

  return {
    /**
     * One conversation that ACTS. The bot decides whether the operator wants a
     * clip generated NOW or just advice. If generate, it returns the optimized
     * prompt + settings and the server queues the real job (drives Chrome) — the
     * bot itself never claims to have rendered anything and never invents tool
     * limitations (the host app does the clicking).
     */
    async chat(message, history = []) {
      const convo = history
        .slice(-6)
        .map((m) => `${m.role === 'me' ? 'Operator' : 'You'}: ${m.text}`)
        .join('\n');
      const wins = store.bestPrompts(3);
      const exemplars = wins.map((w) => `- ${w.prompt}`).join('\n');
      const decision = await codexJson(
        [
          PERSONA,
          knowledge ? `Reference knowledge:\n${knowledge}` : '',
          exemplars ? `Exemplar prompts that worked (match this caliber):\n${exemplars}` : '',
          convo ? `Conversation so far:\n${convo}` : '',
          `Operator just said: ${message}`,
          `Decide intent:`,
          `- "generate": they want a clip made now (e.g. "create/make a video…", "generate…").`,
          `- "advise": they want help, a prompt, or conversation.`,
          `RULES: You do NOT render anything yourself and you have NO environment/harness/`,
          `desktop limits to report — when mode is "generate" the host app does the clicking,`,
          `so just hand over a great prompt + settings and a short confirmation. Never refuse,`,
          `never invent tool constraints, never claim a clip exists.`,
          `Return JSON: {"mode":"generate|advise","prompt":"<optimized Veo prompt, only if generate>",`,
          `"orientation":"Landscape|Portrait|Square","insertMode":"Insert|Extend|none","reply":"<your message to the operator>"}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        { addDirs },
      );

      if (decision && decision.reply) {
        if (decision.mode === 'generate' && decision.prompt) {
          // Storyboard a full production so the agent does advanced control, not one clip.
          const plan = await this.planProduction(message).catch(() => null);
          if (plan) {
            const shotLines = plan.shots.map((s) => `  ${s.n}. [${s.role || 'shot'}] ${String(s.prompt).slice(0, 90)}…  → ${s.place || 'Insert'}`).join('\n');
            const layerLines = (plan.layers || []).map((l) => `  + ${l.type}: ${l.detail}`).join('\n');
            const reply = `Plan${plan.title ? ` — ${plan.title}` : ''} (${plan.shots.length} shot${plan.shots.length > 1 ? 's' : ''}):\n${shotLines}` +
              (layerLines ? `\nLayers:\n${layerLines}` : '') +
              (plan.why ? `\n\nWhy: ${plan.why}` : '') +
              `\n\nBuilding it now — watch your screen.`;
            return { reply, generate: { plan, prompt: plan.shots[0].prompt, orientation: plan.shots[0].orientation } };
          }
          // Fallback: single clip.
          return { reply: decision.reply, generate: { prompt: decision.prompt, orientation: decision.orientation, insertMode: decision.insertMode } };
        }
        return { reply: decision.reply };
      }

      // Fallback to a plain answer if the structured call didn't parse.
      const reply = await codexAsk(
        [PERSONA, knowledge ? `Reference knowledge:\n${knowledge}` : '', convo ? `Conversation so far:\n${convo}` : '', `Operator: ${message}\nYou:`].filter(Boolean).join('\n\n'),
        { addDirs },
      );
      if (reply) return { reply };
      const why = getLastCodexError();
      return {
        reply: `Couldn't get a reply from the Codex CLI${why ? ` — ${why}` : ''}. ` +
          `If "timed out", the model is slow (raise VIDS_CODEX_TIMEOUT_MS); if "ENOENT"/exit code, restart the panel.`,
      };
    },

    /**
     * Plan a real production: storyboard the idea into shots + layers + assembly,
     * grounded in the playbook. This is the "advanced control" — multi-shot,
     * stitch (Insert/Extend), layer (text/music), with a rationale.
     */
    async planProduction(idea, opts = {}) {
      const spokeKey = opts.spoke && SPOKES[opts.spoke] ? opts.spoke : detectSpoke(idea);
      const spoke = spokeKey ? SPOKES[spokeKey] : null;
      const spokeBlock = spoke
        ? `This is a "${spoke.name}" video — build to this ARCHETYPE:\nStructure: ${spoke.structure}\nStyle: ${spoke.style}`
        : '';
      const plan = await codexJson(
        [
          PERSONA,
          knowledge ? `Reference knowledge (production playbook + prompt craft + UI runbook):\n${knowledge}` : '',
          spokeBlock,
          `Plan a SHORT video production for this request, storyboarded per the playbook${spoke ? ' AND the archetype above' : ''}.`,
          `Request: ${idea}`,
          `Return JSON: {"title":"","palette":"","shots":[{"n":1,"role":"hook|build|payoff|intro|step|punchline|closing","prompt":"<full Veo prompt; reuse the same palette; end with No text, no logos.>","orientation":"Landscape|Portrait|Square","place":"Insert|Extend"}],"layers":[{"type":"text|music|image","detail":"<what + where>"}],"assembly":["ordered step",...],"why":"<one-paragraph rationale>"}`,
          `Keep it to 1-4 shots. Decide Insert (new cut) vs Extend (continue a beat) per shot. Match the archetype's structure + style.`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        { addDirs },
      );
      if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) return null;
      plan.spoke = spokeKey || null;
      return plan;
    },

    /** Optimize a raw idea into a Veo prompt + recipe vars, grounded in wins + examples. */
    async optimizeJob(job) {
      const wins = store.bestPrompts(4);
      const examples = (await store.examples().catch(() => [])).slice(0, 4);
      const exemplarBlock = [...wins.map((w) => `- (${w.rating != null ? `rated ${w.rating}` : 'recent win'}) ${w.prompt}`), ...examples.map((e) => `- ${e.prompt}`)]
        .slice(0, 6)
        .join('\n');
      const out = await codexJson(
        [
          PERSONA,
          knowledge ? `Reference knowledge:\n${knowledge}` : '',
          exemplarBlock ? `Exemplar prompts that worked well (match this caliber + house style):\n${exemplarBlock}` : '',
          `Rewrite this idea into ONE strong Veo prompt. Keep the operator's intent.`,
          `Idea: ${job.prompt}`,
          `Return: {"prompt": "<optimized>", "orientation": "Landscape|Portrait|Square", "notes": "<one line why>"}`,
          `Default orientation to ${job.orientation || 'Landscape'} unless the idea implies otherwise.`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        { addDirs },
      );
      if (!out || !out.prompt) return null;
      return { prompt: out.prompt, orientation: out.orientation || job.orientation, notes: out.notes };
    },

    /**
     * Recover a missed recipe step. Reads the page's clickable labels (cheap,
     * always available) and asks Codex which one matches the step's intent;
     * attaches the screenshot too when an image path is usable.
     */
    async visionFallback(ctx) {
      const driver = operator.driver;
      // Memory first: a selector we healed for this step before is free + instant.
      const remembered = ctx.stepId && store.healedTarget(ctx.stepId);
      if (remembered && (await driver.exists(remembered, 2500))) {
        return { action: ctx.action, target: remembered };
      }
      const candidates = await driver.listClickables().catch(() => []);
      if (!candidates.length && !ctx.screenshotBuffer) return null;

      let imagePath = null;
      if (ctx.screenshotBuffer) {
        try {
          imagePath = path.join(os.tmpdir(), `vids-vision-${Date.now()}.png`);
          fs.writeFileSync(imagePath, ctx.screenshotBuffer);
        } catch {
          imagePath = null;
        }
      }

      const list = candidates.map((c, i) => `${i}. [${c.kind}] ${c.label}`).join('\n');
      const guess = await codexJson(
        [
          PERSONA,
          `A recipe step could not find its target on the Google Vids page.`,
          `Step intent: ${ctx.intent}`,
          `Step action: ${ctx.action}`,
          `Visible clickable/typeable elements (index, kind, label):\n${list || '(none read)'}`,
          `Pick the element that best achieves the intent.`,
          `Return: {"index": <n>, "label": "<exact label>", "kind": "button|input"} or {"index": -1} if none fits.`,
        ].join('\n\n'),
        { addDirs, image: imagePath },
      ).finally(() => {
        if (imagePath) fs.promises.unlink(imagePath).catch(() => {});
      });

      if (!guess || guess.index == null || guess.index < 0) return null;
      const chosen = candidates[guess.index] || candidates.find((c) => c.label === guess.label);
      if (!chosen) return null;
      // Hand the engine a text target it can re-resolve + record back into the recipe.
      return { action: ctx.action, target: { text: chosen.label } };
    },

    /** Record a finished run so wins + healed selectors feed future jobs. */
    async recordRun(job, result) {
      try {
        store.recordRun(job, result);
      } catch {
        /* learning is best-effort; never block a job on it */
      }
    },

    /** Operator rates a finished clip (drives prompt ranking). */
    rate(jobId, rating) {
      return store.rate(jobId, rating);
    },

    stats() {
      return store.stats();
    },
  };
}

module.exports = { createBot, PERSONA, KNOWLEDGE_DIR };
