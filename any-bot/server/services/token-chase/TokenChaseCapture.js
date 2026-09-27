/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 1: zero-impact per-LLM-call frame capture lane (dark by default)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Step 2 tail-replay inputs (ADR-046 §1/§8, BACKLOG "workspace-tree tail-replay" + "honest pinned-read tracking"): each open frame additionally records `pins` and a bounded, content-addressed `workspaceTree` in the background writer, so the tail replay can restage the tree a frame saw. Frames captured before this change simply lack them and keep replaying exactly as before.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind full declared tool schemas plus optional workspace-commit and encrypted owner-store-version references; preserve an explicit caller-supplied non-replayable decision and hash-verify every redacted workspace object.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Workspace-bound checkpoint (BACKLOG "Workspace-bound checkpoint and tail replay"): the background writer now PRODUCES the provenance seq 3 only accepted. Each open frame commits its redacted snapshot into the private .tokenchase/git repository (workspace-checkpoint.js) and records the commit under context.workspaceCommit — null, never fabricated, when git fails — plus a `checkpoint` block (tree digest, completeness, redacted paths, git error). A configured owner-store snapshotter (configureOwnerStore, wired by the bot-node runtime) copies the owner's CIPHERTEXT into .tokenchase/store-objects and records context.ownerStoreVersion; with no store the version is null and `ownerStore.bound` is false. Pins arrive per frame from turn-provenance.js. finishRun writes .tokenchase/final.json (post-tool tree digest, final commit, store version, trailing pins) as the baseline a no-edit replay compares against, and flush() lets a caller await the background writes. The tree walk moved to workspace-checkpoint.js.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The owner-store half of each background write is async (regression fix for seq 4: a synchronous whole-store copy held a jarvis bot's event loop 88.8 s before the model call and 33.6 s after it). The workspace checkpoint still runs synchronously at the frame's setImmediate, so the tree and commit keep their moment; the store snapshot and the frame / final.json write then run on a per-workspace promise chain (enqueueWrite), which keeps open -> close merge -> final.json in order without holding the event loop. The snapshotter now owns where objects go (one content-addressed directory per node), so the lane no longer creates .tokenchase/store-objects; a store above the snapshot ceiling is recorded as ownerStore.snapshotSkipped 'too_large' with measuredBytes and a null version, and each summary carries the snapshot's hashed/copied counts. The manifest file holds version, files, complete and warnings only. flush() now also awaits the queued async writes.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logger = require('../../utils/logger');
const {
  CAPTURE_DIRNAME, FINAL_FILE, commitCheckpoint, frameFileName, snapshotWorkspaceTree,
} = require('./workspace-checkpoint');

/**
 * Token Chase capture lane (ADR-046, step 1).
 *
 * Design contract — ZERO impact on the LLM call's critical path:
 *  - When the TOKEN_CHASE_CAPTURE flag is off (the default), every entry point is a
 *    single boolean check returning null/undefined — the caller's behavior is byte-identical.
 *  - When on, the hot path does only cheap, synchronous work (a shallow array copy and an
 *    object literal — microseconds). All heavy work (serialize, mkdir, fs write, the private
 *    git commit) is deferred to setImmediate, which fires *during* the in-flight LLM await, so
 *    it overlaps the seconds-long network/subprocess latency and adds no wall-clock to the call.
 *    The opt-in owner-store ciphertext copy is async (fs/promises) on a per-workspace write
 *    queue, so even a large store never holds the event loop.
 *  - Capture is FAIL-OPEN: any error is logged at ERROR (no silent catch) and swallowed so it
 *    can never propagate into the agentic loop.
 *
 * Frames are written as JSON under <workspaceDir>/.tokenchase/ (see
 * docs/architecture/token-chase-capture-and-debugger-spec.md).
 */

// Read the flag once at module load — toggling requires a process restart by design, so there is
// no per-call env read and no way for the flag to add cost when off.
const ENABLED = process.env.TOKEN_CHASE_CAPTURE === 'true';
const DIRNAME = CAPTURE_DIRNAME;
// The owner-store snapshotter (src/features/token-chase/services/owner-store-snapshot.ts) is
// injected by the bot-node runtime so this CommonJS lane never re-implements the exact-subject
// store safety checks. Null means "no owner store on this node": versions stay null, honestly.
let ownerStore = null;
// Background writes for one task workspace land in order (open frame -> its close merge -> final.json).
// The owner-store half is async, so a later write for the same workspace waits on this chain instead of
// racing the frame file it merges into. pendingWrites lets flush() await everything queued so far.
const workspaceQueues = new Map();
const pendingWrites = new Set();

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
 * @description Installs (or clears) the owner-store snapshotter the background writer versions the
 * accountable owner's encrypted store with. Duck-typed: anything with `snapshot(ownerSub)` returning a
 * manifest (or a promise of one); the snapshotter decides where the ciphertext objects go.
 * @param {{bound?: boolean, snapshot: Function}|null} snapshotter - The snapshotter, or null for none.
 * @returns {void}
 */
function configureOwnerStore(snapshotter) {
  ownerStore = snapshotter && typeof snapshotter.snapshot === 'function' && snapshotter.bound !== false ? snapshotter : null;
}

/**
 * @description Opens a frame immediately before an LLM call. Synchronous and cheap: it freezes
 * the membership of the (about-to-be-mutated) history array with a shallow copy and stamps the
 * decision context, then schedules the durable write off the hot path. Returns a handle to close.
 * @param {Object} ctx - Pre-call context (taskId, seq, agentId, workspaceDir, providerName, systemPrompt, tools, history, source, userSub, pins, replayable).
 * @returns {Object|null} An opaque frame handle to pass to endFrame, or null when disabled.
 */
function beginFrame(ctx) {
  if (!ENABLED || !ctx || !ctx.workspaceDir) return null;
  const handle = {
    workspaceDir: ctx.workspaceDir,
    taskId: ctx.taskId,
    seq: ctx.seq,
    userSub: typeof ctx.userSub === 'string' && ctx.userSub.length > 0 ? ctx.userSub : null,
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
    userSub: handle.userSub,
    decision: { providerRequested: ctx.providerName || null, harnessFired: null, model: null },
    context: {
      systemPrompt: ctx.systemPrompt || null,
      tools: toolNames(ctx.tools),
      toolSchema: toolSchemas(ctx.tools),
      inputMessages: handle.historySent.length,
      workspaceCommit: null,
      ownerStoreVersion: null,
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
  setImmediate(() => enqueueWrite(handle.workspaceDir, () => writeClose(handle, frame)));
}

/**
 * @description Records the end-of-run checkpoint: the workspace tree and owner-store version AFTER the
 * last tool ran, the final commit, and any pins not yet consumed by a frame. This is the baseline a
 * no-edit tail replay compares its artifacts and store version against. Cheap on the hot path; the
 * snapshot/commit run in the background. No-op when capture is off or there is no workspace.
 * @param {{taskId: string, workspaceDir: string, userSub?: string|null, turns: number, outcome: string, pins?: object[]}} ctx - The run's closing context.
 * @returns {void}
 */
function finishRun(ctx) {
  if (!ENABLED || !ctx || !ctx.workspaceDir) return;
  const record = {
    taskId: ctx.taskId,
    userSub: typeof ctx.userSub === 'string' && ctx.userSub.length > 0 ? ctx.userSub : null,
    turns: Number.isInteger(ctx.turns) ? ctx.turns : null,
    outcome: typeof ctx.outcome === 'string' ? ctx.outcome : 'unknown',
    pins: Array.isArray(ctx.pins) ? ctx.pins.slice() : [],
    at: new Date().toISOString(),
    phase: 'final',
  };
  setImmediate(() => writeFinal(ctx.workspaceDir, record));
}

/**
 * @description Resolves after every background write scheduled so far has run: the FIFO setImmediate
 * callbacks first, then the queued async owner-store writes they started. For callers that must read a
 * frame or final.json they just caused.
 * @returns {Promise<void>} Settles once the pending writers have executed.
 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
}

/**
 * @description Runs a background write after every earlier write for the same workspace has landed.
 * Fail-open: a rejected job is logged at ERROR, never propagated, and never blocks the next job.
 * @param {string} workspaceDir - The task workspace the job writes under.
 * @param {() => (void|Promise<void>)} job - The write to run.
 * @returns {Promise<void>} Settles when the job has run.
 */
function enqueueWrite(workspaceDir, job) {
  const previous = workspaceQueues.get(workspaceDir) || Promise.resolve();
  const run = previous.then(job).catch((err) => {
    logger.error(`[TokenChase] background write failed (workspace=${workspaceDir}): ${err && err.message}`);
  });
  workspaceQueues.set(workspaceDir, run);
  pendingWrites.add(run);
  run.then(() => {
    pendingWrites.delete(run);
    if (workspaceQueues.get(workspaceDir) === run) workspaceQueues.delete(workspaceDir);
  });
  return run;
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
      ...(source.inputSchema && typeof source.inputSchema === 'object' ? { inputSchema: source.inputSchema } : {}),
    };
  });
}

/** @description A caller-declared unpinned read makes deterministic forward replay unsafe. */
function hasUnpinnedRead(pins) {
  return Array.isArray(pins) && pins.some((pin) => pin && (pin.pinned === false || pin.unpinned === true || pin.status === 'unpinned'));
}

/**
 * @description Snapshots and commits the workspace for one frame/final record. Never throws: the
 * snapshot warnings and the git failure ride in the returned `checkpoint` block, and the commit is
 * null when git could not produce one.
 * @param {string} workspaceDir - The task workspace.
 * @param {string} dir - The capture directory.
 * @param {string} taskId - The run id (names the ref namespace).
 * @param {number|string} seq - The frame sequence or 'final'.
 * @param {number|string|null} parentSeq - The parent checkpoint, or null for the natural seq-1 rule.
 * @returns {{snapshot: object, commit: object, checkpoint: object}} The tree, the commit result and the summary block.
 */
function checkpointWorkspace(workspaceDir, dir, taskId, seq, parentSeq) {
  const objectDir = path.join(dir, 'objects');
  const snapshot = snapshotWorkspaceTree(workspaceDir, objectDir, redact);
  const commit = commitCheckpoint({ captureDir: dir, taskId, seq, files: snapshot.files, objectDir, parentSeq });
  const checkpoint = {
    treeSha: snapshot.treeSha,
    gitTreeSha: commit.gitTreeSha,
    ref: commit.ref,
    complete: snapshot.complete && commit.workspaceCommit !== null,
    redactedPaths: snapshot.redactedPaths,
    warnings: snapshot.warnings,
    error: commit.error,
  };
  return { snapshot, commit, checkpoint };
}

/**
 * @description Versions the accountable owner's encrypted store through the configured snapshotter,
 * which copies CIPHERTEXT ONLY into the node's content-addressed object directory; the manifest is
 * written beside the frame as store-<version>.json. With no snapshotter or no owner the version is null
 * and `bound` is false. A store above the snapshot ceiling is refused (snapshotSkipped 'too_large', the
 * measured size, null version). A failed snapshot is logged and reported as incomplete — the frame still lands.
 * @param {string} dir - The capture directory.
 * @param {string|null} userSub - The accountable owner, or null for a system call.
 * @returns {Promise<object>} The store binding summary ({version, bound, complete, reason, manifest, ...}).
 */
async function snapshotOwnerStore(dir, userSub) {
  if (!ownerStore) return { version: null, bound: false, complete: false, reason: 'no owner store configured on this node', manifest: null };
  if (!userSub) return { version: null, bound: false, complete: false, reason: 'no accountable owner on this call', manifest: null };
  try {
    const result = await ownerStore.snapshot(userSub);
    if (result && result.skipped === 'too_large') return skippedStoreSummary(result);
    const manifestFile = `store-${result.version}.json`;
    await writeManifestOnce(path.join(dir, manifestFile), result);
    return {
      version: result.version, bound: true, complete: result.complete !== false, reason: null, manifest: manifestFile,
      hashed: typeof result.hashed === 'number' ? result.hashed : null,
      copied: typeof result.copied === 'number' ? result.copied : null,
    };
  } catch (err) {
    logger.error(`[TokenChase] owner store snapshot failed: ${err.message}`);
    return { version: null, bound: true, complete: false, reason: err.message, manifest: null };
  }
}

/**
 * @description The summary for a store the snapshotter refused as too large: nothing was copied, the
 * version is null, and the measured size says why.
 * @param {{measuredBytes?: number, maxTotalBytes?: number}} result - The refused manifest.
 * @returns {object} The store binding summary.
 */
function skippedStoreSummary(result) {
  const measuredBytes = typeof result.measuredBytes === 'number' ? result.measuredBytes : null;
  const maxTotalBytes = typeof result.maxTotalBytes === 'number' ? result.maxTotalBytes : null;
  return {
    version: null, bound: true, complete: false, manifest: null,
    snapshotSkipped: 'too_large', measuredBytes, maxTotalBytes,
    reason: `owner store is ${measuredBytes} bytes, above the ${maxTotalBytes}-byte snapshot ceiling`,
  };
}

/**
 * @description Writes a store manifest once per version (a version names its content, so an existing
 * file is already right). Only the version identity is persisted, not the per-call counters.
 * @param {string} file - store-<version>.json under the capture directory.
 * @param {{version: string, files: object[], complete: boolean, warnings: string[]}} result - The manifest.
 * @returns {Promise<void>} Settles once the file exists.
 */
async function writeManifestOnce(file, result) {
  const body = JSON.stringify({ version: result.version, files: result.files, complete: result.complete, warnings: result.warnings }, null, 2);
  try {
    await fsp.writeFile(file, body, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/** @description The frame file path without its .json suffix, under the capture directory. */
function frameBase(handle) {
  return path.join(handle.workspaceDir, DIRNAME, frameFileName(handle.seq).replace(/\.json$/, ''));
}

/**
 * @description Background writer for an open frame. The workspace checkpoint (tree + private-git commit)
 * runs synchronously HERE, at the frame's setImmediate during the LLM await, so it records the tree the
 * call saw; the owner-store snapshot and the frame/history files then land on the workspace's write
 * queue without holding the event loop. Fail-open: logs and swallows.
 * @param {Object} handle - The frame handle (carries workspaceDir + seq).
 * @param {Object} frame - The open frame payload.
 * @param {Array} historySent - The frozen sent history to persist.
 * @returns {void}
 */
function writeFrame(handle, frame, historySent) {
  let checkpointed;
  try {
    const dir = path.join(handle.workspaceDir, DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    checkpointed = { dir, ...checkpointWorkspace(handle.workspaceDir, dir, handle.taskId, handle.seq, null) };
  } catch (err) {
    logger.error(`[TokenChase] frame write failed (task=${handle.taskId} seq=${handle.seq}): ${err.message}`);
    return;
  }
  enqueueWrite(handle.workspaceDir, async () => {
    const { dir, snapshot, commit, checkpoint } = checkpointed;
    const store = await snapshotOwnerStore(dir, handle.userSub);
    const open = {
      ...frame,
      context: { ...frame.context, workspaceCommit: commit.workspaceCommit, ownerStoreVersion: store.version },
      ...(handle.pins ? { pins: handle.pins } : {}),
      replayable: handle.replayable && !hasUnpinnedRead(handle.pins),
      workspaceTree: snapshot,
      checkpoint,
      ownerStore: store,
    };
    const base = frameBase(handle);
    writeRedacted(`${base}.json`, open);
    fs.writeFileSync(`${base}.history.json`, redact(JSON.stringify(historySent)));
  });
}

/**
 * @description Background writer for a closing frame: merges the response into the open frame file.
 * Runs on the workspace's write queue, after the open write it merges into. Fail-open.
 * @param {Object} handle - The frame handle.
 * @param {Object} frame - The closing frame payload.
 * @returns {void}
 */
function writeClose(handle, frame) {
  try {
    fs.mkdirSync(path.join(handle.workspaceDir, DIRNAME), { recursive: true });
    mergeResponse(`${frameBase(handle)}.json`, frame);
  } catch (err) {
    logger.error(`[TokenChase] frame write failed (task=${handle.taskId} seq=${handle.seq}): ${err.message}`);
  }
}

/**
 * @description Background writer for the end-of-run checkpoint (final.json). The workspace checkpoint
 * runs synchronously at finishRun's setImmediate; the store snapshot and the file land on the
 * workspace's write queue after every frame write before it. Fail-open like writeFrame.
 * @param {string} workspaceDir - The task workspace.
 * @param {Object} record - The closing record from finishRun.
 * @returns {void}
 */
function writeFinal(workspaceDir, record) {
  let checkpointed;
  try {
    const dir = path.join(workspaceDir, DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const lastSeq = record.turns !== null && record.turns > 0 ? record.turns : null;
    checkpointed = { dir, ...checkpointWorkspace(workspaceDir, dir, record.taskId, 'final', lastSeq) };
  } catch (err) {
    logger.error(`[TokenChase] final checkpoint write failed (task=${record.taskId}): ${err.message}`);
    return;
  }
  enqueueWrite(workspaceDir, async () => {
    const { dir, snapshot, commit, checkpoint } = checkpointed;
    const store = await snapshotOwnerStore(dir, record.userSub);
    writeRedacted(path.join(dir, FINAL_FILE), {
      ...record,
      workspaceTree: snapshot,
      workspaceCommit: commit.workspaceCommit,
      checkpoint,
      ownerStoreVersion: store.version,
      ownerStore: store,
      replayable: !hasUnpinnedRead(record.pins),
    });
  });
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

module.exports = {
  tokenChase: { isEnabled, beginFrame, endFrame, finishRun, flush, configureOwnerStore, redact },
};
