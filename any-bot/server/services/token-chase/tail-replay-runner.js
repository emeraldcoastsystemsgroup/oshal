/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Hermetic no-edit tail executor for Token Chase (ADR-046 §3 forward-only replay, BACKLOG "Workspace-bound checkpoint and tail replay"). Runs ON THE BOT NODE over an isolated worktree restored from frame N's private checkpoint commit (object restage for pre-commit frames). Every captured model response is served verbatim — no provider is ever called — and the tool call it carries is re-executed against the isolated worktree through the REAL file-tool handlers, registered under a private ToolRegistry that holds only workspace-read/-write tools. A frame flagged non-replayable, or a response that calls a live-read, side-effect or undeclared tool, STOPS the tail with the reason before anything runs. Each re-executed result is verified against the next frame's recorded pin digest (a pinned read whose worktree copy disagrees is served from the captured object). The resulting tree is digested with the capture walk and compared path by path with final.json, so the verdict is reproduced / diverged with the differing paths named — never inferred from response text.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const ToolRegistry = require('../ToolRegistry');
const ToolUseParser = require('../llm/ToolUseParser');
const { fileToolDefinitions } = require('../tools/fileTools');
const { classifyTool, digestPayload, isPinnedClass } = require('./turn-provenance');
const { digestWorkspaceTree, restageFromObjects, restoreCheckpoint } = require('./workspace-checkpoint');

/** @description The protocol control that ends a run; it is never a tool the registry executes. */
const COMPLETION_TOOL = 'attempt_completion';
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

/**
 * @description Builds the private registry a hermetic tail executes through: only tools whose declared
 * replay class is reproducible from the checkpoint are registered, so a live-read or side-effect tool
 * has no handler to reach even if a captured response names it. The class map keeps every declared
 * class for the stop reason.
 * @param {object[]|undefined} definitions - Tool definitions; defaults to the real file tools.
 * @returns {{registry: ToolRegistry, classes: Map<string, string>}} The registry and the declared classes.
 */
function buildHermeticRegistry(definitions) {
  const registry = new ToolRegistry();
  const classes = new Map();
  for (const definition of definitions || fileToolDefinitions()) {
    const { replayClass } = classifyTool(definition);
    classes.set(definition.name, replayClass);
    if (isPinnedClass(replayClass)) registry.register(definition);
  }
  return { registry, classes };
}

/**
 * @description The tool call a captured response carries, parsed the way the agentic loop parses it:
 * a tool_use block first, else the XML form. Null when the response is a plain reply.
 * @param {{responseContent?: string|null, responseBlocks?: unknown[]}} frame - The captured frame.
 * @returns {{name: string, input: object}|null} The call, or null.
 */
function capturedToolUse(frame) {
  const blocks = Array.isArray(frame.responseBlocks) ? frame.responseBlocks : [];
  const block = blocks.find((entry) => entry && entry.type === 'tool_use' && typeof entry.name === 'string');
  if (block) return { name: block.name, input: block.input && typeof block.input === 'object' ? block.input : {} };
  const text = typeof frame.responseContent === 'string' ? frame.responseContent : '';
  if (!ToolUseParser.hasToolUse(text)) return null;
  const parsed = ToolUseParser.parseToolUse(text);
  return parsed && typeof parsed.name === 'string' ? { name: parsed.name, input: parsed.input || {} } : null;
}

/**
 * @description Restores frame N's workspace into the isolated worktree: from its checkpoint commit when
 * one was recorded, else from the content-addressed objects. The restored tree is digested with the
 * capture walk and checked against the frame's recorded tree digest, so the caller knows whether the
 * tail starts from exactly what the baseline saw.
 * @param {{captureDir: string, frame: object, targetDir: string, redact: (text: string) => string}} input - The capture dir, the start frame, the isolated target and the capture scrubber.
 * @returns {{source: 'commit'|'objects'|'none', workspaceCommit: string|null, filesRestored: number, integrity: 'ok'|'mismatch'|'unverified'|'partial'|'none', treeSha: string, warnings: string[]}} The restore outcome.
 */
function restoreWorktree(input) {
  const { captureDir, frame, targetDir, redact } = input;
  const tree = frame.workspaceTree && typeof frame.workspaceTree === 'object' ? frame.workspaceTree : {};
  const manifest = Array.isArray(tree.files) ? tree.files : [];
  const expectedTree = typeof tree.treeSha === 'string' ? tree.treeSha : null;
  const commit = typeof frame.workspaceCommit === 'string' && SHA1_PATTERN.test(frame.workspaceCommit) ? frame.workspaceCommit : null;
  const warnings = [];
  let source = 'none';
  let filesRestored = 0;
  if (commit) {
    try {
      filesRestored = restoreCheckpoint({ captureDir, sha: commit, targetDir }).restored;
      source = 'commit';
    } catch (err) {
      logger.error(`[TokenChase] checkpoint commit restore failed (commit=${commit}): ${err.message}`);
      warnings.push(`checkpoint commit restore failed: ${err.message}`);
    }
  }
  if (source === 'none' && manifest.length > 0) {
    const restage = restageFromObjects({ files: manifest, objectDir: path.join(captureDir, 'objects'), targetDir });
    filesRestored = restage.restored;
    source = 'objects';
    warnings.push(...restage.warnings);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const digest = digestWorkspaceTree(targetDir, redact);
  let integrity = 'unverified';
  if (source === 'none') integrity = manifest.length === 0 ? 'none' : 'partial';
  else if (expectedTree) integrity = digest.treeSha === expectedTree ? 'ok' : 'mismatch';
  if (integrity === 'mismatch') warnings.push('restored tree digest differs from the tree the frame recorded');
  return { source, workspaceCommit: commit, filesRestored, integrity, treeSha: digest.treeSha, warnings };
}

/** @description Takes the first unconsumed pin recorded for a tool name off the next frame's queue. */
function takePin(queue, toolName) {
  const index = queue.findIndex((pin) => pin && pin.tool === toolName);
  return index === -1 ? null : queue.splice(index, 1)[0];
}

/**
 * @description Compares a re-executed tool payload with the digest the baseline pinned for it.
 * @param {object|null} pin - The recorded pin, or null when the baseline recorded none (pre-provenance frame).
 * @param {unknown} payload - The replayed result (or `{error}` for a failed call).
 * @param {(text: string) => string} redact - The capture scrubber, so both digests cover the same bytes.
 * @param {string} objectDir - The capture object store, to say whether the captured result is on hand.
 * @returns {{pinVerified: boolean|null, servedFromCapture: boolean, warnings: string[]}} The verification.
 */
function comparePin(pin, payload, redact, objectDir) {
  if (!pin || typeof pin.resultSha256 !== 'string') return { pinVerified: null, servedFromCapture: false, warnings: [] };
  const actual = digestPayload(redact, payload).sha256;
  if (actual === pin.resultSha256) return { pinVerified: true, servedFromCapture: false, warnings: [] };
  const servedFromCapture = pin.pinned === true && fs.existsSync(path.join(objectDir, pin.resultSha256));
  const warnings = [`${pin.tool} result differs from the captured pin (captured ${pin.resultSha256.slice(0, 12)}, replay ${actual.slice(0, 12)})`];
  if (servedFromCapture) warnings.push(`${pin.tool}: captured result served from .tokenchase/objects in place of the worktree copy`);
  return { pinVerified: false, servedFromCapture, warnings };
}

/**
 * @description Classifies a captured tool call for hermetic execution and returns the stop outcome when
 * it may not run: a live-read/side-effect class, or a tool with no hermetic handler on this node. A tool
 * the hermetic registry does not know takes the class the baseline pinned for it (the producing node
 * declared it), else the fail-closed default.
 * @returns {{replayClass: string, refusal: string|null}} The class and the refusal reason (null = executable).
 */
function admitTool(registry, classes, toolName, nextPins) {
  const declared = classes.has(toolName);
  const pin = nextPins.find((entry) => entry && entry.tool === toolName && typeof entry.replayClass === 'string');
  const replayClass = declared ? classes.get(toolName) : pin ? pin.replayClass : classifyTool(null).replayClass;
  if (registry.has(toolName) && isPinnedClass(replayClass)) return { replayClass, refusal: null };
  if (!isPinnedClass(replayClass)) {
    const label = declared || pin ? replayClass : `undeclared, treated as ${replayClass}`;
    return { replayClass, refusal: `calls ${toolName} (${label}); a hermetic replay refuses to re-run it` };
  }
  return { replayClass, refusal: `calls ${toolName} (${replayClass}), which has no hermetic handler on this node` };
}

/**
 * @description Replays one frame hermetically: serves the captured response, refuses anything that is
 * not reproducible, re-executes the workspace tool it carries against the isolated worktree and verifies
 * the result against the baseline's pin. Never calls a provider.
 * @param {{frame: object, nextPins: object[], registry: ToolRegistry, classes: Map<string,string>, worktreeDir: string, objectDir: string, redact: Function}} input - One frame and its execution context.
 * @returns {Promise<object>} The frame outcome (status drives whether the tail continues).
 */
async function executeFrame(input) {
  const { frame, nextPins, registry, classes, worktreeDir, objectDir, redact } = input;
  const base = { seq: frame.seq, status: 'reproduced', tool: null, replayClass: null, pinVerified: null, servedFromCapture: false, reason: null, warnings: [] };
  if (frame.replayable === false) return { ...base, status: 'non-replayable', reason: `Frame ${frame.seq} depends on a live read — the tail cannot continue hermetically.` };
  if (frame.phase === 'open' || frame.responseContent == null) return { ...base, status: 'open-frame', reason: `Frame ${frame.seq} is still in flight — no baseline to replay.` };
  const call = capturedToolUse(frame);
  if (!call || call.name === COMPLETION_TOOL) return { ...base, status: 'completed', tool: call ? call.name : null };
  const admitted = admitTool(registry, classes, call.name, nextPins);
  const named = { ...base, tool: call.name, replayClass: admitted.replayClass };
  if (admitted.refusal) return { ...named, status: 'live-tool', reason: `Frame ${frame.seq} ${admitted.refusal}.` };
  try {
    const result = await registry.execute(call.name, { ...call.input, taskWorkspace: worktreeDir }, { approved: true, taskWorkspace: worktreeDir });
    return { ...named, ...comparePin(takePin(nextPins, call.name), result, redact, objectDir) };
  } catch (err) {
    const pin = takePin(nextPins, call.name);
    if (pin && pin.success === false) {
      // The baseline failed here too: the failure is the reproduced result, verified by digest.
      return { ...named, ...comparePin(pin, { error: err.message }, redact, objectDir) };
    }
    logger.error(`[TokenChase] hermetic tool execution failed (seq=${frame.seq} tool=${call.name}): ${err.message}`);
    return { ...named, status: 'tool-error', reason: `${call.name} failed during the hermetic replay of frame ${frame.seq}: ${err.message}` };
  }
}

/** @description Paths whose digest differs between two manifests, plus paths present on one side only. */
function diffManifests(baseline, replay) {
  const left = new Map(baseline.map((file) => [file.path, file.sha256]));
  const right = new Map(replay.map((file) => [file.path, file.sha256]));
  const differing = new Set();
  for (const [file, sha] of left) if (right.get(file) !== sha) differing.add(file);
  for (const file of right.keys()) if (!left.has(file)) differing.add(file);
  return [...differing].sort();
}

/**
 * @description Compares the replayed worktree with the run's end-of-run checkpoint: same capture walk,
 * same scrubber, so the digests are comparable byte for byte.
 * @param {string} worktreeDir - The isolated worktree after the tail ran.
 * @param {object|null} final - The final.json record (null when the run never wrote one).
 * @param {(text: string) => string} redact - The capture scrubber.
 * @returns {{baselineTreeSha: string|null, replayTreeSha: string, reproduced: boolean|null, differingPaths: string[], redactedPaths: string[], complete: boolean, warnings: string[]}} The comparison.
 */
function compareArtifacts(worktreeDir, final, redact) {
  const replay = digestWorkspaceTree(worktreeDir, redact);
  const checkpoint = final && final.checkpoint && typeof final.checkpoint === 'object' ? final.checkpoint : {};
  const tree = final && final.workspaceTree && typeof final.workspaceTree === 'object' ? final.workspaceTree : {};
  const baselineTreeSha = (typeof checkpoint.treeSha === 'string' && checkpoint.treeSha) || (typeof tree.treeSha === 'string' && tree.treeSha) || null;
  const baselineFiles = Array.isArray(tree.files) ? tree.files : null;
  return {
    baselineTreeSha,
    replayTreeSha: replay.treeSha,
    reproduced: baselineTreeSha ? baselineTreeSha === replay.treeSha : null,
    differingPaths: baselineFiles ? diffManifests(baselineFiles, replay.files) : [],
    redactedPaths: Array.isArray(checkpoint.redactedPaths) ? checkpoint.redactedPaths : [],
    complete: checkpoint.complete === true && replay.complete,
    warnings: final ? replay.warnings : ['no end-of-run checkpoint (final.json) recorded for this run'],
  };
}

/** @description The pins the NEXT frame recorded for this frame's tool call (final.json holds the trailing ones). */
function pinsFollowing(ordered, index, final) {
  const next = ordered[index + 1];
  if (next && Array.isArray(next.pins)) return next.pins.slice();
  if (!next && final && Array.isArray(final.pins)) return final.pins.slice();
  return [];
}

/**
 * @description Runs the hermetic no-edit tail over frames N..end in an already-restored worktree and
 * compares the outcome with the run's final checkpoint.
 * @param {{captureDir: string, worktreeDir: string, frames: object[], final: object|null, redact: (text: string) => string, toolDefinitions?: object[]}} input - The capture dir, the isolated worktree, the tail frames, final.json and the scrubber.
 * @returns {Promise<{status: 'reproduced'|'diverged'|'stopped'|'empty', frames: object[], stoppedAtFrame: number|null, stopReason: string|null, toolCalls: number, artifacts: object}>} The tail verdict.
 */
async function runHermeticTail(input) {
  const { captureDir, worktreeDir, final, redact } = input;
  const { registry, classes } = buildHermeticRegistry(input.toolDefinitions);
  const objectDir = path.join(captureDir, 'objects');
  const ordered = [...input.frames].sort((a, b) => a.seq - b.seq);
  const outcomes = [];
  let stoppedAtFrame = null;
  let stopReason = null;
  let toolCalls = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const frame = ordered[index];
    const outcome = await executeFrame({ frame, nextPins: pinsFollowing(ordered, index, final), registry, classes, worktreeDir, objectDir, redact });
    outcomes.push(outcome);
    if (outcome.status === 'reproduced' && outcome.tool) toolCalls += 1;
    if (outcome.status === 'completed') break;
    if (outcome.status !== 'reproduced') { stoppedAtFrame = frame.seq; stopReason = outcome.reason; break; }
  }
  const artifacts = compareArtifacts(worktreeDir, final, redact);
  const verified = outcomes.every((outcome) => outcome.pinVerified !== false);
  let status = 'diverged';
  if (ordered.length === 0) status = 'empty';
  else if (stoppedAtFrame !== null) status = 'stopped';
  else if (artifacts.reproduced === true && verified) status = 'reproduced';
  logger.info(`[TokenChase] hermetic tail ${status}: frames=${outcomes.length} tools=${toolCalls} stoppedAt=${stoppedAtFrame} differing=${artifacts.differingPaths.length}`);
  return { status, frames: outcomes, stoppedAtFrame, stopReason, toolCalls, artifacts };
}

module.exports = {
  COMPLETION_TOOL,
  buildHermeticRegistry,
  capturedToolUse,
  compareArtifacts,
  restoreWorktree,
  runHermeticTail,
};
