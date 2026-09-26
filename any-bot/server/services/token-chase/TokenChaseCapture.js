/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: zero-impact per-LLM-call frame capture lane (dark by default)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Step 2 tail-replay inputs (ADR-046 §1/§8, BACKLOG "workspace-tree tail-replay" + "honest pinned-read tracking"): each open frame additionally records `pins` and a bounded, content-addressed `workspaceTree` in the background writer, so the tail replay can restage the tree a frame saw. Frames captured before this change simply lack them and keep replaying exactly as before.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind full declared tool schemas plus optional workspace-commit and encrypted owner-store-version references; preserve an explicit caller-supplied non-replayable decision and hash-verify every redacted workspace object.
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
const MAX_TREE_FILES = 200;
const MAX_TREE_FILE_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 5 * 1024 * 1024;
const SKIP_TREE_SEGMENTS = new Set(['.git', 'node_modules', DIRNAME]);

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
 * @param {Object} ctx - Pre-call context (taskId, seq, agentId, workspaceDir, providerName, systemPrompt, tools, history, source, userSub, pins, replayable, workspaceCommit, ownerStoreVersion).
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
    pins: Array.isArray(ctx.pins) ? ctx.pins.slice() : undefined,
    replayable: ctx.replayable !== false,
  };
  const frame = {
    taskId: ctx.taskId,
    seq: ctx.seq,
    agentId: ctx.agentId || null,
    source: ctx.source || null,
    userSub: ctx.userSub || null,
    decision: { providerRequested: ctx.providerName || null, harnessFired: null, model: null },
    context: {
      systemPrompt: ctx.systemPrompt || null,
      tools: toolNames(ctx.tools),
      toolSchema: toolSchemas(ctx.tools),
      inputMessages: handle.historySent.length,
      workspaceCommit: boundedRef(ctx.workspaceCommit),
      ownerStoreVersion: boundedRef(ctx.ownerStoreVersion),
    },
    ...(handle.pins ? { pins: handle.pins } : {}),
    replayable: handle.replayable,
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

/** @description Retains the complete declared tool contract without executable callbacks. */
function toolSchemas(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return { name: 'unknown' };
    const source = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    return {
      name: typeof source.name === 'string' ? source.name : 'unknown',
      ...(typeof source.description === 'string' ? { description: source.description.slice(0, 2000) } : {}),
      ...(source.parameters && typeof source.parameters === 'object' ? { parameters: source.parameters } : {}),
      ...(source.input_schema && typeof source.input_schema === 'object' ? { input_schema: source.input_schema } : {}),
    };
  });
}

/** @description Keep refs useful for provenance while refusing to persist unbounded or object-shaped data. */
function boundedRef(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 256) : null;
}

/** @description A caller-declared unpinned read makes deterministic forward replay unsafe. */
function hasUnpinnedRead(pins) {
  return Array.isArray(pins) && pins.some((pin) => pin && (pin.pinned === false || pin.unpinned === true || pin.status === 'unpinned'));
}

/** @description Enumerate bounded regular text files without traversing symlinks or private capture data. */
function treeFiles(root, relative = '', out = []) {
  if (out.length >= MAX_TREE_FILES) return out;
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= MAX_TREE_FILES) break;
    if (SKIP_TREE_SEGMENTS.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) treeFiles(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** @description Snapshot text workspace files into redacted content-addressed objects. */
function snapshotWorkspaceTree(workspaceDir, objectDir) {
  const files = treeFiles(workspaceDir);
  const manifest = [];
  let totalBytes = 0;
  const warnings = [];
  fs.mkdirSync(objectDir, { recursive: true });
  for (const relative of files) {
    if (totalBytes >= MAX_TREE_BYTES) { warnings.push('workspace tree byte cap reached'); break; }
    const absolute = path.join(workspaceDir, relative);
    let bytes;
    try { bytes = fs.readFileSync(absolute); } catch { warnings.push(`unreadable workspace file: ${relative}`); continue; }
    if (bytes.length > MAX_TREE_FILE_BYTES || bytes.includes(0)) { warnings.push(`skipped non-text or oversized workspace file: ${relative}`); continue; }
    const safe = Buffer.from(redact(bytes.toString('utf8')), 'utf8');
    if (totalBytes + safe.length > MAX_TREE_BYTES) { warnings.push('workspace tree byte cap reached'); break; }
    const sha256 = crypto.createHash('sha256').update(safe).digest('hex');
    const objectPath = path.join(objectDir, sha256);
    if (!fs.existsSync(objectPath)) {
      try {
        fs.writeFileSync(objectPath, safe, { flag: 'wx' });
      } catch (err) {
        // Another capture may have won the same content-addressed write race.
        if (err.code !== 'EEXIST') throw err;
      }
    }
    manifest.push({ path: relative.replaceAll(path.sep, '/'), sha256 });
    totalBytes += safe.length;
  }
  return { files: manifest, bytes: totalBytes, warnings, complete: warnings.length === 0 && files.length <= MAX_TREE_FILES };
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
      const snapshot = snapshotWorkspaceTree(handle.workspaceDir, path.join(dir, 'objects'));
      const open = {
        ...frame,
        ...(handle.pins ? { pins: handle.pins } : {}),
        replayable: handle.replayable && !hasUnpinnedRead(handle.pins),
        workspaceTree: snapshot,
      };
      writeRedacted(`${base}.json`, open);
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
