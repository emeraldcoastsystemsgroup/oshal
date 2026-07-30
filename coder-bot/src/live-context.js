/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Rolling microphone-transcript buffer for the always-listening mode. Browser speech recognition re-emits the same phrase as it firms up an interim result, so a naive buffer would spend a model call per repetition; de-duplicating against the previous entry and gating work behind a monotonic `version` vs `assessedVersion` means one assessment per genuinely new utterance, and a slow assessment coalesces everything said while it was running instead of queueing a backlog. The buffer is capped (entries, per-entry length, insight length) because it is fed by an unbounded live stream.
 */

'use strict';

/**
 * @description Bounded, de-duplicated view of what the user has recently said, used as extra
 * context for screen assessment. Holds no audio — only recognized text — and never leaves the
 * local process.
 */
class LiveContext {
  /**
   * @description Create an empty transcript buffer.
   * @param {object} [options] Buffer options.
   * @param {number} [options.maxEntries=12] How many recent utterances to retain. Small on
   * purpose: older speech is stale context for "what is happening on screen right now".
   */
  constructor({ maxEntries = 12 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.version = 0;
    this.assessedVersion = 0;
    this.insight = '';
    this.lastAt = null;
  }

  /**
   * @description Append an utterance, ignoring it when it repeats the previous one. Only a genuinely
   * new utterance bumps `version`, which is what makes an assessment owed — this is the guard that
   * stops interim speech-recognition repeats from each costing a model call.
   * @param {string} text Recognized speech. Whitespace-collapsed and truncated; empty input is a
   * no-op.
   * @param {string} [capturedAt] Caller-supplied ISO timestamp of when the browser heard it.
   * @returns {{version: number, assessedVersion: number, lastAt: (string|null), recentText: string, insight: string}}
   * The buffer snapshot after the add.
   */
  add(text, capturedAt = new Date().toISOString()) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4_000);
    if (!value) return this.snapshot();
    const previous = this.entries.at(-1);
    if (!previous || previous.text !== value) {
      this.entries.push({ text: value, capturedAt });
      this.entries = this.entries.slice(-this.maxEntries);
      this.version++;
      this.lastAt = new Date().toISOString();
    }
    return this.snapshot();
  }

  /**
   * @description Flatten the most recent utterances into one prompt-ready string.
   * @param {number} [limit=6] How many trailing utterances to include. Fewer than `maxEntries` so a
   * prompt reflects the current thought rather than the whole session.
   * @returns {string} Space-joined recent speech, empty when nothing has been heard.
   */
  recentText(limit = 6) {
    return this.entries.slice(-limit).map((entry) => entry.text).join(' ');
  }

  /**
   * @description Record that a version has been assessed, together with the resulting insight.
   * @param {number} version The buffer version the assessment was computed from — captured BEFORE
   * the model call, so speech that arrived mid-call still leaves work pending.
   * @param {string} insight The model's reading of that transcript. Truncated: it is echoed into
   * later prompts and must not grow without bound.
   * @returns {void}
   */
  markAssessed(version, insight) {
    this.assessedVersion = Math.max(this.assessedVersion, Number(version) || 0);
    this.insight = String(insight || '').trim().slice(0, 8_000);
  }

  /**
   * @description Whether speech has arrived that no assessment has covered yet.
   * @returns {boolean} True when an assessment is owed. The server loops on this instead of
   * assessing per request, so a burst of speech during a slow model call collapses into one
   * follow-up pass.
   */
  hasPending() {
    return this.version > this.assessedVersion;
  }

  /**
   * @description Serializable buffer state for `/api/state` and the SSE stream.
   * @returns {{version: number, assessedVersion: number, lastAt: (string|null), recentText: string, insight: string}}
   * Versions let the browser tell "assessment in flight" from "up to date" without a second request.
   */
  snapshot() {
    return {
      version: this.version,
      assessedVersion: this.assessedVersion,
      lastAt: this.lastAt,
      recentText: this.recentText(),
      insight: this.insight,
    };
  }
}

module.exports = { LiveContext };
