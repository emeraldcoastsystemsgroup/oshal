/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The unprompted half of the assistant: a self-rescheduling loop that captures the foreground screen and asks for a next-step recommendation without the user asking. Three properties are deliberate. (1) It self-schedules from the END of each pass rather than on a fixed interval, so a slow model call can never let assessments pile up or overlap — the `running` flag is the second belt on that, and a test pins it. (2) It declines to assess while Coder Bot's own window is foreground: reading its own transcript would be a feedback loop, and every skip path backs off to a slower retry so an idle machine is not hammered. (3) The screen signature and window title are computed and reported to the model as CONTEXT ("the window changed; visual distance is N") rather than used as a gate to skip work — a static screen the user is stuck on is exactly when advice is worth most, so it keeps assessing. That is a real cost/privacy posture, not an accident, and it is documented in the README because the operator has to be able to see it and choose otherwise.
 */

'use strict';

const { Desktop } = require('./desktop');

/**
 * @description Mean per-cell luminance difference between two 16x9 screen signatures.
 *
 * A cheap "how much did the screen change" number that needs no image library — it is read off the
 * base64 greyscale thumbnail the capture already produced. Returns Infinity, not 0, for missing,
 * malformed, or mismatched-length input: an unknown amount of change must never be mistaken for "no
 * change", so the failure mode is "treat it as maximally different".
 *
 * @param {string} left Base64 signature, typically the previous frame's.
 * @param {string} right Base64 signature of the current frame.
 * @returns {number} Mean absolute difference per cell (0 = identical), or Infinity when
 * incomparable.
 */
function signatureDistance(left, right) {
  if (!left || !right) return Infinity;
  let a;
  let b;
  try {
    a = Buffer.from(left, 'base64');
    b = Buffer.from(right, 'base64');
  } catch {
    return Infinity;
  }
  if (!a.length || a.length !== b.length) return Infinity;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference += Math.abs(a[index] - b[index]);
  return difference / a.length;
}

/**
 * @description Whether the foreground window is Coder Bot's own browser tab.
 *
 * Matched on the title because the process is the user's browser, not this one — there is no PID to
 * compare against. Assessing its own window would feed the bot its previous recommendation as fresh
 * screen evidence, so this is the guard against that self-reference loop (and against burning model
 * calls on the user simply reading the answer).
 *
 * @param {{title?: string}} info Foreground info from the desktop layer.
 * @returns {boolean} True when the title identifies Coder Bot.
 */
function isCoderBotWindow(info) {
  return /\bcoder bot\b/i.test(String(info?.title || ''));
}

/**
 * @description Background screen-assessment loop that produces recommendations without being asked.
 *
 * Every collaborator is injected — assistant, desktop, event sink, and the two predicates — so the
 * loop's timing and non-overlap guarantees can be tested against fakes with no real screen, no model
 * spend, and no wall-clock waiting.
 */
class ProactiveMonitor {
  /**
   * @description Wire up the monitor. It does not begin until `start()` is called.
   * @param {object} options Collaborators and tuning.
   * @param {{analyzeScreenshot: Function}} options.assistant Owns the model call AND the frame
   * cleanup for the shot it is handed.
   * @param {object} [options.desktop=Desktop] Desktop surface; injectable for tests.
   * @param {Function} [options.onEvent] Sink for lifecycle events, forwarded to the browser over SSE.
   * @param {Function} [options.shouldRun] Veto predicate — the server uses it so an interactive
   * request or an active control run always outranks background work.
   * @param {Function} [options.getContext] Supplies recent speech so a recommendation can combine
   * what is on screen with what the user said about it.
   * @param {number} [options.intervalMs] Gap after a completed pass before the next one; from
   * `CODER_BOT_PROACTIVE_INTERVAL_MS`, default 100.
   * @param {boolean} [options.enabled] Default ON — disabled only by `CODER_BOT_PROACTIVE=0`, since
   * an assistant that has to be switched on before it notices anything is not proactive. The cost of
   * that default is documented in the README.
   */
  constructor({
    assistant,
    desktop = Desktop,
    onEvent = () => {},
    shouldRun = () => true,
    getContext = () => ({ recentText: '', insight: '' }),
    intervalMs = Number(process.env.CODER_BOT_PROACTIVE_INTERVAL_MS || 100),
    enabled = process.env.CODER_BOT_PROACTIVE !== '0',
  } = {}) {
    this.assistant = assistant;
    this.desktop = desktop;
    this.onEvent = onEvent;
    this.shouldRun = shouldRun;
    this.getContext = getContext;
    this.intervalMs = Math.max(0, intervalMs);
    this.enabled = enabled;
    this.running = false;
    this.timer = null;
    this.stopped = true;
    this.lastOutcome = null;
    this.lastSignature = null;
    this.lastTitle = '';
    this.lastAt = null;
  }

  /**
   * @description Serializable monitor state for `/api/state` and the SSE stream.
   * @returns {{enabled: boolean, running: boolean, lastAt: (string|null), intervalMs: number}} The
   * interval is included so the UI can show the real cadence instead of implying a fixed one.
   */
  snapshot() {
    return {
      enabled: this.enabled,
      running: this.running,
      lastAt: this.lastAt,
      intervalMs: this.intervalMs,
    };
  }

  /**
   * @description Begin the loop, idempotently.
   * @returns {void} The first pass is delayed a couple of seconds so the user can reach the browser
   * tab before the first capture — an immediate one would only photograph the terminal it launched
   * from.
   */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(2_500);
  }

  /**
   * @description Stop the loop and cancel any pending pass. Called when the HTTP server closes so the
   * process can exit rather than being held open by a screen-capture timer.
   * @returns {void}
   */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * @description Queue the next pass, one timer at a time.
   *
   * This is the loop. It re-arms only after `tick()` has fully settled, which is what makes overlap
   * structurally impossible rather than merely unlikely. A pass that did no work (disabled, busy, or
   * Coder Bot in the foreground) backs off to a two-second retry instead of spinning at the configured
   * interval. The timer is `unref`'d so a pending capture never keeps Node alive on shutdown.
   *
   * @param {number} [delayMs] Delay before the next pass; defaults to the configured interval.
   * @returns {void} No-op when stopped or a pass is already queued.
   */
  schedule(delayMs = this.intervalMs) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      const idleDelay = ['coder_bot_foreground', 'busy', 'disabled'].includes(this.lastOutcome) ? 2_000 : this.intervalMs;
      this.schedule(idleDelay);
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /**
   * @description Turn background assessment on or off at runtime — the in-app Proactive control, and
   * the switch a user reaches for when they do not want their screen read.
   *
   * Re-enabling clears the remembered signature and title so the next pass is treated as a fresh
   * start rather than compared against whatever was on screen before the pause, and schedules
   * promptly instead of waiting out a backoff.
   *
   * @param {boolean} enabled Desired state; coerced, so a JSON body cannot leave it undefined.
   * @returns {{enabled: boolean, running: boolean, lastAt: (string|null), intervalMs: number}} The new
   * state, returned to the caller and broadcast so every connected view agrees.
   */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.onEvent({ type: 'proactive-state', state: this.snapshot() });
    if (this.enabled) {
      this.lastSignature = null;
      this.lastTitle = '';
      this.schedule(100);
    }
    return this.snapshot();
  }

  /**
   * @description Run one assessment pass: check the foreground, capture, assess, publish.
   *
   * Records why each pass ended in `lastOutcome`, which `schedule()` reads to pick the next delay.
   * Frame ownership is the subtle part: `analyzeScreenshot` deletes the frame it is given, so the local
   * handle is cleared before that call and the catch only cleans up frames that never reached it —
   * that avoids both a double delete and a leaked image of the user's screen on any failure path.
   * Errors are reported and swallowed on purpose: a transient capture failure must not kill the loop.
   *
   * @returns {Promise<void>} Always resolves; failures surface as a `proactive-error` event.
   */
  async tick() {
    if (!this.enabled) { this.lastOutcome = 'disabled'; return; }
    if (this.running || !this.shouldRun()) { this.lastOutcome = 'busy'; return; }
    this.running = true;
    let shot = null;
    try {
      const foreground = await this.desktop.foregroundInfo();
      if (isCoderBotWindow(foreground)) {
        this.lastOutcome = 'coder_bot_foreground';
        this.onEvent({ type: 'proactive-skipped', reason: 'coder_bot_foreground' });
        return;
      }

      shot = await this.desktop.screenshot();
      const title = String(foreground?.title || '');
      const changedWindow = title && title !== this.lastTitle;
      const distance = signatureDistance(this.lastSignature, shot.signature);
      this.lastSignature = shot.signature;
      this.lastTitle = title;
      const context = this.getContext() || {};
      const spoken = String(context.recentText || '').trim();
      const textInsight = String(context.insight || '').trim();

      this.onEvent({ type: 'proactive-reading', title });
      const result = await this.assistant.analyzeScreenshot(
        shot,
        `Continuously assess this screen${title ? ` (${title})` : ''}.
The foreground window ${changedWindow ? 'changed' : 'did not change'} since the prior assessment; visual distance is ${Number.isFinite(distance) ? distance.toFixed(1) : 'initial'}.
Recent always-listening microphone transcript (may contain recognition mistakes): ${spoken || '(none)'}
Preliminary text-stream assessment: ${textInsight || '(none)'}
Combine the visible screen and spoken context. Identify issues or mistakes, recommend the single most logical next action, and provide a guarded automation goal when useful.`,
      );
      shot = null; // analyzeScreenshot owns cleanup.
      this.lastAt = new Date().toISOString();
      this.lastOutcome = 'assessed';
      this.onEvent({
        type: 'proactive-suggestion',
        title,
        result,
        state: this.snapshot(),
      });
    } catch (error) {
      if (shot) this.desktop.removeScreenshot(shot.path);
      this.lastOutcome = 'error';
      this.onEvent({ type: 'proactive-error', error: String(error.message || error) });
    } finally {
      this.running = false;
      this.onEvent({ type: 'proactive-state', state: this.snapshot() });
    }
  }
}

module.exports = { ProactiveMonitor, isCoderBotWindow, signatureDistance };
