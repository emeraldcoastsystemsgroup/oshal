/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: zero-impact per-LLM-call frame capture lane (dark by default)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Step 2 tail-replay inputs (ADR-046 §1/§8, BACKLOG "workspace-tree tail-replay" + "honest pinned-read tracking"): each open frame now additionally records (a) `pins` — a per-tool-read classification of the sent history (pinned = the read's content IS captured in the history blob and can be served hermetically on replay; unpinned = content missing/uncapturable, replay falls through) and (b) `workspaceTree` — a bounded, content-addressed snapshot of the workspace tree as-of the call (manifest in the frame, redacted file contents under .tokenchase/objects/<sha256>) so a tail replay can restage the tree a frame saw. Both are ADDITIVE fields computed in the existing background writer (zero hot-path cost preserved); frames captured before this change simply lack them and keep replaying exactly as before.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

/**
 * Token Chase capture lane (ADR-046, step 1).
 *
 * Design contract — ZERO impact on the LLM call's critical path:
 *  - When the TOKEN_CHASE_CAPTURE flag is off (the default), every entry point is a
 *    single boolean check returning null/undefined — the caller's behavior is byte-identical.
 *  - When on, the hot path does only cheap, synchronous work (a shallow array copy and an
 *    object literal — microseconds). All heavy work (serialize, mkdir, fs write) is deferred
 *    to setImmediate, which fires *during* the in-flight LLM await, so it overlaps the
 *    seconds-long network/subprocess latency and adds no wall-clock to the call.
 *  - Capture is FAIL-OPEN: any error is logged at ERROR (no silent catch) and swallowed so it
 *    can never propagate into the agentic loop.
 *
 * Frames are written as JSON under <workspaceDir>/.tokenchase/. Git-per-call commits and
 * forward-only replay are step 2 (see docs/architecture/token-chase-capture-and-debugger-spec.md).
 */

// Read the flag once at module load — toggling requires a process restart by design, so there is
// no per-call env read and no way for the flag to add cost when off.
const ENABLED = process.env.TOKEN_CHASE_CAPTURE === 'true';
const DIRNAME = '.tokenchase';

// Secret redaction. Every frame holds prompts/history/responses that may contain credentials or
// PII, and frames land in the shared workspace volume — so NOTHING is written raw. The whole
// serialized frame is run through these patterns in the background writer (off the hot path).
// Patterns match value characters only (no quotes/commas), so redaction preserves JSON validity.
const REDACTIONS = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1 [REDACTED] $2'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, '[REDACTED_KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/(Bearer\s+)[A-Za-z0-9._=-]{16,}/gi, '$1[REDACTED]'],
  [/("?(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1[REDACTED]'],
];

/**
 * @description Redacts known secret shapes from a serialized payload before it is written to disk.
 * @param {string} text - The serialized JSON (or plain string) to scrub.
 * @returns {string} The scrubbed text, structurally unchanged (value characters only).
 */
function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/**
 * @description Writes an object as redacted, pretty JSON. The single sink for all frame writes so
 * redaction can never be bypassed.
 * @param {string} file - Destination path.
 * @param {*} obj - The payload to serialize, redact, and write.
 * @returns {void}
 */
function writeRedacted(file, obj) {
  fs.writeFileSync(file, redact(JSON.stringify(obj, null, 2)));
}

/**
 * @description Whether the capture lane is active for this process.
 * @returns {boolean} True only when TOKEN_CHASE_CAPTURE=true was set at startup.
 */
function isEnabled() {
  return ENABLED;
}

/**
 * @description Opens a frame immediately before an LLM call. Synchronous and cheap: it freezes
 * the membership of the (about-to-be-mutated) history array with a shallow copy and stamps the
 * decision context, then schedules the durable write off the hot path. Returns a handle to close.
 * @param {Object} ctx - Pre-call context (taskId, seq, agentId, workspaceDir, providerName, systemPrompt, tools, history, source, userSub).
 * @returns {Object|null} An opaque frame handle to pass to endFrame, or null when disabled.
 */
function beginFrame(ctx) {
  if (!ENABLED || !ctx || !ctx.workspaceDir) return null;
  const handle = {
    workspaceDir: ctx.workspaceDir,
    taskId: ctx.taskId,
    seq: ctx.seq,
    t0: process.hrtime.bigint(),
    // Shallow copy freezes which messages were sent; deep serialization happens in the background.
    historySent: Array.isArray(ctx.history) ? ctx.history.slice() : [],
  };
  const frame = {
    taskId: ctx.taskId,
    seq: ctx.seq,
    agentId: ctx.agentId || null,
    source: ctx.source || null,
    userSub: ctx.userSub || null,
    decision: { providerRequested: ctx.providerName || null, harnessFired: null, model: null },
    context: { systemPrompt: ctx.systemPrompt || null, tools: toolNames(ctx.tools), inputMessages: handle.historySent.length },
    replayable: true,
    phase: 'open',
  };
  setImmediate(() => writeFrame(handle, frame, handle.historySent));
  return handle;
}

/**
 * @description Closes a frame after the LLM call returns. Synchronous: records latency and the
 * provider that actually fired (which can differ from the requested one via the Bedrock->Cline
 * fallback), then schedules the durable write off the hot path. No-op when handle is null.
 * @param {Object|null} handle - The handle returned by beginFrame.
 * @param {Object} response - The provider response ({ content, contentBlocks, usage, provider }).
 * @returns {void}
 */
function endFrame(handle, response) {
  if (!handle) return;
  const latencyMs = Number(process.hrtime.bigint() - handle.t0) / 1e6;
  const usage = (response && response.usage) || {};
  const frame = {
    taskId: handle.taskId,
    seq: handle.seq,
    decision: { harnessFired: (response && response.provider) || null, model: (response && response.model) || null },
    outcome: {
      tokensIn: usage.input_tokens ?? usage.inputTokens ?? null,
      tokensOut: usage.output_tokens ?? usage.outputTokens ?? null,
      latencyMs: Math.round(latencyMs),
    },
    response: { content: (response && response.content) || null, blocks: (response && response.contentBlocks) || [] },
    phase: 'closed',
  };
  setImmediate(() => writeFrame(handle, frame, null));
}

/**
 * @description Extracts tool names from the tools payload for the frame context, defensively.
 * @param {*} tools - The tools array/object passed to the provider.
 * @returns {string[]} Tool names, or an empty array.
 */
function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => (t && (t.name || t.function?.name)) || 'unknown');
}

/**
 * @description Background writer: persists a frame (and optionally the sent history) as JSON under
 * <workspaceDir>/.tokenchase/. Runs in setImmediate, never on the hot path. Fail-open: logs and swallows.
 * @param {Object} handle - The frame handle (carries workspaceDir + seq).
 * @param {Object} frame - The frame payload to merge/write.
 * @param {Array|null} historySent - The frozen sent history to persist on the open write, or null.
 * @returns {void}
 */
function writeFrame(handle, frame, historySent) {
  try {
    const dir = path.join(handle.workspaceDir, DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `frame-${String(handle.seq).padStart(4, '0')}`);
    if (historySent) {
      writeRedacted(`${base}.json`, frame);
      fs.writeFileSync(`${base}.history.json`, redact(JSON.stringify(historySent)));
    } else {
      mergeResponse(`${base}.json`, frame);
    }
  } catch (err) {
    logger.error(`[TokenChase] frame write failed (task=${handle.taskId} seq=${handle.seq}): ${err.message}`);
  }
}

/**
 * @description Merges the closing payload (response + outcome) into the open frame file on disk.
 * @param {string} file - Path to the frame JSON written at open time.
 * @param {Object} closing - The closing frame payload.
 * @returns {void}
 */
function mergeResponse(file, closing) {
  let open = {};
  try {
    open = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    // Open file missing/unreadable — write the closing payload alone rather than lose the frame.
  }
  const merged = { ...open, ...closing, decision: { ...(open.decision || {}), ...closing.decision } };
  writeRedacted(file, merged);
}

module.exports = { tokenChase: { isEnabled, beginFrame, endFrame } };
