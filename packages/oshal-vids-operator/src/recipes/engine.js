'use strict';
/**
 * @description Recipe engine — runs a list of steps against the VidsDriver.
 *
 * Each step has an `action` (ensure | click | type | upload | waitFor | sleep),
 * a `target` (text/role/selector — see driver.locator), an `intent` (a plain
 * sentence describing what the step achieves), and optional flags. When a step's
 * target can't be resolved, the engine asks the injected `visionFallback`
 * (P2: screenshot -> Codex -> {action, target}) to recover, and on success
 * records the resolved target back so the recipe self-heals.
 *
 * The engine is UI-agnostic: it knows nothing about Google Vids specifically.
 * All Vids knowledge lives in recipes/google-vids.yaml.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

function loadRecipe(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const recipe = YAML.load(raw);
  recipe.__file = file;
  return recipe;
}

/** Interpolate {{name}} tokens in strings (deep) using `vars`. */
function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars);
    return out;
  }
  return value;
}

/** Whether a conditional step should run, given the job vars. */
function stepEnabled(step, vars) {
  switch (step.when) {
    case 'hasIngredient':
      return Boolean(vars.ingredientPath);
    case 'shouldPlace':
      return vars.insertMode && String(vars.insertMode).toLowerCase() !== 'none';
    case undefined:
    case null:
      return true;
    default:
      return true;
  }
}

class RecipeEngine {
  /**
   * @param {object} deps
   * @param {import('../driver/chrome-cdp').VidsDriver} deps.driver
   * @param {(ctx:object)=>Promise<{action:string,target:object}|null>} [deps.visionFallback]
   * @param {(event:object)=>void} [deps.onEvent]  progress sink (panel/log)
   */
  constructor({ driver, visionFallback = null, onEvent = () => {} }) {
    this.driver = driver;
    this.visionFallback = visionFallback;
    this.onEvent = onEvent;
    this.paused = false;
    this.aborted = false;
  }

  pause() { this.paused = true; this.emit('paused', {}); }
  resume() { this.paused = false; this.emit('resumed', {}); }
  abort() { this.aborted = true; }

  emit(type, data) {
    try { this.onEvent({ type, ts: new Date().toISOString(), ...data }); } catch { /* ignore */ }
  }

  async waitWhilePaused() {
    while (this.paused && !this.aborted) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.aborted) throw new Error('aborted');
  }

  /**
   * Run the whole recipe with the given job variables.
   * Returns { ok, steps:[{id,status,resolved?}], healedSteps:[...] }.
   */
  async run(recipe, jobVars = {}) {
    const vars = { ...(recipe.defaults || {}), ...jobVars };
    const results = [];
    const healed = [];
    this.emit('recipe-start', { recipe: recipe.name, vars: redact(vars) });

    for (const rawStep of recipe.steps || []) {
      await this.waitWhilePaused();
      const step = interpolate(rawStep, vars);
      if (!stepEnabled(rawStep, vars)) {
        results.push({ id: step.id, status: 'skipped' });
        this.emit('step', { id: step.id, status: 'skipped', intent: step.intent });
        continue;
      }

      this.emit('step', { id: step.id, status: 'start', intent: step.intent, action: step.action });
      try {
        const resolved = await this.runStep(step, vars);
        results.push({ id: step.id, status: 'ok', resolved: resolved || undefined });
        if (resolved && resolved.healed) healed.push({ id: step.id, target: resolved.target });
        this.emit('step', { id: step.id, status: 'ok', intent: step.intent, healed: Boolean(resolved && resolved.healed) });
      } catch (err) {
        results.push({ id: step.id, status: 'fail', error: String(err && err.message || err) });
        this.emit('step', { id: step.id, status: 'fail', intent: step.intent, error: String(err && err.message || err) });
        if (step.optional) continue; // optional steps never abort the run
        this.emit('recipe-end', { ok: false, failedAt: step.id });
        return { ok: false, steps: results, healedSteps: healed, failedAt: step.id };
      }
      // Push a fresh screenshot after each meaningful step.
      this.emit('frame', { image: await this.driver.screenshot() });
    }

    this.emit('recipe-end', { ok: true });
    return { ok: true, steps: results, healedSteps: healed };
  }

  /** Execute one step; returns a {healed,target} hint when vision recovered it. */
  async runStep(step, vars) {
    const d = this.driver;
    switch (step.action) {
      case 'sleep':
        await new Promise((r) => setTimeout(r, Number(step.ms) || 1000));
        return null;

      case 'ensure': {
        // Idempotent: if presentWhen is already satisfied, do nothing.
        if (step.presentWhen && (await d.exists(step.presentWhen, 1200))) return null;
        return this.clickWithFallback(step);
      }

      case 'click':
        return this.clickWithFallback(step);

      case 'type': {
        const target = await this.resolveTarget(step, 'type');
        await d.type(target.target, step.value);
        return target.healed ? target : null;
      }

      case 'upload': {
        const target = await this.resolveTarget(step, 'upload');
        await d.uploadFile(target.target, step.file);
        return target.healed ? target : null;
      }

      case 'waitFor': {
        const timeoutMs = step.timeoutKey ? Number(vars[step.timeoutKey]) || 120_000 : Number(step.timeoutMs) || 120_000;
        if (step.domPredicate) {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (${step.domPredicate})`)();
          await d.waitFor(fn, { timeoutMs });
        } else {
          await d.waitFor(step.target, { timeoutMs });
        }
        return null;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  async clickWithFallback(step) {
    const target = await this.resolveTarget(step, 'click');
    await this.driver.click(target.target);
    return target.healed ? target : null;
  }

  /**
   * Resolve a clickable/typeable target: try `target`, then `altTargets`, then
   * the vision fallback. Returns { target, healed }.
   */
  async resolveTarget(step, action) {
    const candidates = [step.target, ...(step.altTargets || [])].filter(Boolean);
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.driver.exists(c, 2000)) return { target: c, healed: false };
    }
    // Nothing matched — try vision (P2). Null in P1: surface a real error.
    if (this.visionFallback) {
      this.emit('vision', { id: step.id, intent: step.intent });
      const guess = await this.visionFallback({
        stepId: step.id,
        intent: step.intent,
        action,
        screenshotBuffer: await this.driver.screenshotBuffer(),
      });
      if (guess && guess.target && (await this.driver.exists(guess.target, 3000))) {
        return { target: guess.target, healed: true };
      }
    }
    throw new Error(`Could not find target for step "${step.id}" (${step.intent})`);
  }
}

/** Trim long prompt text in events. */
function redact(vars) {
  const v = { ...vars };
  if (typeof v.prompt === 'string' && v.prompt.length > 120) v.prompt = `${v.prompt.slice(0, 117)}...`;
  return v;
}

const DEFAULT_RECIPE = path.resolve(__dirname, '..', '..', 'recipes', 'google-vids.yaml');

module.exports = { RecipeEngine, loadRecipe, interpolate, DEFAULT_RECIPE };
