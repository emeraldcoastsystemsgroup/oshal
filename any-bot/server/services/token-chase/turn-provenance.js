/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-turn tool-read classification for Token Chase (ADR-046 §8, BACKLOG "Workspace-bound checkpoint and tail replay"): every tool result the agentic loop appends to history since the previous frame becomes one pin {tool, callId, replayClass, pinned, inputSha256, resultSha256}. The class comes from the tool definition's declared `replayClass` (workspace-read | workspace-write | pure | live-read | side-effect); a tool that declares nothing is treated as live-read so an unclassified read FAILS CLOSED into a non-replayable frame. Pinned results are stored redacted and content-addressed under .tokenchase/objects so a hermetic replay can serve or verify them. Pins are per frame (drained into the next beginFrame), never per run.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const logger = require('../../utils/logger');
const { CAPTURE_DIRNAME, writeObject } = require('./workspace-checkpoint');
const fs = require('fs');

/** @description The closed set of replay classes a tool definition may declare. */
const REPLAY_CLASSES = Object.freeze(['workspace-read', 'workspace-write', 'pure', 'live-read', 'side-effect']);
/** @description Classes whose results are a deterministic function of the checkpointed workspace/store. */
const PINNED_CLASSES = new Set(['workspace-read', 'workspace-write', 'pure']);
/** @description The class an undeclared tool receives: live, so an unknown read can never look replayable. */
const DEFAULT_REPLAY_CLASS = 'live-read';
const MAX_PIN_OBJECT_BYTES = 256 * 1024;

/**
 * @description Validates a declared replay class.
 * @param {unknown} value - The `replayClass` field off a tool definition.
 * @returns {string|null} The class when it is one of REPLAY_CLASSES, else null.
 */
function normalizeReplayClass(value) {
  return typeof value === 'string' && REPLAY_CLASSES.includes(value) ? value : null;
}

/**
 * @description Classifies a tool for replay. Undeclared tools fail closed to live-read.
 * @param {{replayClass?: unknown}|null|undefined} toolDefinition - The registered tool (or null when unknown).
 * @returns {{replayClass: string, declared: boolean}} The effective class and whether the tool declared it.
 */
function classifyTool(toolDefinition) {
  const declared = normalizeReplayClass(toolDefinition && toolDefinition.replayClass);
  return declared ? { replayClass: declared, declared: true } : { replayClass: DEFAULT_REPLAY_CLASS, declared: false };
}

/**
 * @description Whether a replay class can be reproduced hermetically from the checkpoint.
 * @param {string} replayClass - A replay class.
 * @returns {boolean} True for workspace-read, workspace-write and pure.
 */
function isPinnedClass(replayClass) {
  return PINNED_CLASSES.has(replayClass);
}

/** @description Stable JSON for hashing tool inputs/results (undefined and cycles never throw). */
function stableJson(value) {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    return typeof text === 'string' ? text : 'null';
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * @description Content digest of a redacted tool payload — the identity a replay re-computes to
 * verify a pinned read reproduced.
 * @param {(text: string) => string} redact - The capture lane's scrubber.
 * @param {unknown} value - The tool input or result.
 * @returns {{sha256: string, bytes: Buffer}} The digest and the redacted bytes it covers.
 */
function digestPayload(redact, value) {
  const bytes = Buffer.from(redact(stableJson(value)), 'utf8');
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

/**
 * @description Collects the tool results appended to history since the previous frame and turns
 * them into per-frame pins. One instance per agentic run; `drain()` at every beginFrame.
 */
class TurnProvenance {
  /**
   * @description Binds the collector to a workspace so pinned results land in that run's object store.
   * @param {{workspaceDir: string, redact: (text: string) => string}} options - The run's workspace and the scrubber.
   */
  constructor(options) {
    this.objectDir = path.join(options.workspaceDir, CAPTURE_DIRNAME, 'objects');
    this.redact = options.redact;
    this.pending = [];
  }

  /**
   * @description Records one executed (or failed) tool call. Cheap on the hot path: two digests; the
   * object write is deferred to setImmediate and fails open.
   * @param {{tool: string, callId?: string|null, toolDefinition?: object|null, input?: unknown, result?: unknown, success: boolean, error?: string|null}} call - The call and its outcome.
   * @returns {object} The pin appended for the next frame.
   */
  record(call) {
    const { replayClass, declared } = classifyTool(call.toolDefinition);
    const input = digestPayload(this.redact, call.input ?? {});
    const result = digestPayload(this.redact, call.success ? call.result : { error: call.error ?? 'tool failed' });
    const pinned = call.success === true && isPinnedClass(replayClass);
    const stored = pinned && result.bytes.length <= MAX_PIN_OBJECT_BYTES;
    const pin = {
      tool: String(call.tool),
      callId: typeof call.callId === 'string' ? call.callId : null,
      replayClass,
      declared,
      pinned,
      success: call.success === true,
      inputSha256: input.sha256,
      resultSha256: result.sha256,
      resultBytes: result.bytes.length,
      stored,
      ...(pinned ? {} : { reason: call.success ? `${replayClass} tool result is not reproducible from the checkpoint` : 'tool call failed in the baseline' }),
    };
    if (stored) setImmediate(() => this.writePin(pin, result.bytes));
    this.pending.push(pin);
    return pin;
  }

  /** @description Background object write for a pinned result; fail-open with an ERROR log. */
  writePin(pin, bytes) {
    try {
      fs.mkdirSync(this.objectDir, { recursive: true });
      writeObject(this.objectDir, pin.resultSha256, bytes);
    } catch (err) {
      logger.error(`[TokenChase] pin object write failed (tool=${pin.tool}): ${err.message}`);
    }
  }

  /**
   * @description Hands the pins collected since the previous frame to the frame about to open.
   * @returns {object[]} The pins (possibly empty); the collector is reset.
   */
  drain() {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/**
 * @description Builds a collector only when capture is active, so the hot path stays byte-identical
 * with the flag off.
 * @param {{isEnabled: () => boolean, redact: (text: string) => string}} tokenChase - The capture lane.
 * @param {string|null|undefined} workspaceDir - The run's workspace.
 * @returns {TurnProvenance|null} The collector, or null when capture is off or there is no workspace.
 */
function createTurnProvenance(tokenChase, workspaceDir) {
  if (!tokenChase || !tokenChase.isEnabled() || !workspaceDir) return null;
  return new TurnProvenance({ workspaceDir, redact: tokenChase.redact });
}

module.exports = {
  DEFAULT_REPLAY_CLASS,
  MAX_PIN_OBJECT_BYTES,
  REPLAY_CLASSES,
  TurnProvenance,
  classifyTool,
  createTurnProvenance,
  digestPayload,
  isPinnedClass,
  normalizeReplayClass,
};
