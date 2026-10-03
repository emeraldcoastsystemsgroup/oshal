/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Image-turn collection for the Antigravity storyboard rail (ADR-130 amendment 2026-10-02). agy's generate_image tool writes its image into the invocation's private HOME (`.gemini/antigravity-cli/brain/<conversation>/<name>_<epoch-ms>.jpg`, proven headless on 2026-10-02 with agy 1.2.8), and the wrapper deletes that HOME when the turn ends. Before the cleanup, an image turn copies that one image into the task workspace as output.png or output.jpg (named by its real format) with a receipt beside it, the way the codex-cli rail leaves output.png. Guard A: nothing is collected unless the turn's stream-json shows a generate_image tool step that reached DONE, the file sits inside the private brain directory, is a regular file written during the turn, and is a PNG or JPEG by its bytes. The workspace must not already hold an output or a receipt, so a file the model drew with code or wrote itself can never be passed off as the tool's.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Clearer refusals (operator decision 2026-10-03; diagnostic only, what Guard A accepts is unchanged). One reason used to cover a turn whose generate_image never ran and one whose generate_image ran and ended in ERROR; the 2026-10-03 storyboard replays showed the tool answering TOOL_ERROR "no image generated in response" and the model then replying NO_IMAGE_CAPABILITY, and the live refusals could not say which had happened. A no-DONE refusal now keeps its old words as its start and adds which way the tool went: never ran, ran and ended in ERROR, or ran but did not finish (its last state); a DONE step with no acceptable file keeps its own reasons. After Guard A's words, behind DIAGNOSTIC_MARKER, comes the untrusted diagnostic: the last ERROR step's own error text and the model's final reply (the wrapper passes it as `reply`), each with control characters (C0, DEL, C1, bidirectional controls) turned into spaces, bounded to 200 characters and JSON-quoted. It is tool and model output, diagnostic text only and never prompt material; the api keeps it out of the error message its callers classify (storyboard-antigravity-image-provider.ts). Every refusal is also logged on the bot (warn, "image turn refused") with the reason, the tool error and the model reply as fields.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger').child({ module: 'agy-image-turn' });

/** The agy tool whose output an image turn hands back. */
const IMAGE_TOOL = 'generate_image';
/** The line generate_image writes into its step output (brain/<id>/.system_generated/steps/<n>/output.txt). */
const SAVED_AT = /Generated image is saved at\s+(\S+)/;
/** generate_image's own file naming: the ImageName with underscores, then `_<epoch-ms>`. */
const GENERATED_NAME = /_\d{13}\.(?:png|jpe?g)$/i;
/** The deliverable name per real format; the extension never lies about the bytes. */
const OUTPUT_NAMES = Object.freeze({ 'image/png': 'output.png', 'image/jpeg': 'output.jpg' });
/** The receipt the controller-side provider verifies against the output it reads. */
const RECEIPT_NAME = 'output.image-turn.json';
/** File times are coarse on some filesystems; a file this close to the turn start still counts as the turn's. */
const MTIME_SLACK_MS = 2000;
/**
 * Where Guard A's own words end in a refusal and the untrusted diagnostic begins. The api splits on it
 * (IMAGE_TURN_DIAGNOSTIC_MARKER in storyboard-antigravity-image-provider.ts), so tool and model text never
 * reaches the error message its callers classify.
 */
const DIAGNOSTIC_MARKER = ' | untrusted diagnostic: ';
/** Guard A's first half, as every refusal of a turn with no DONE generate_image step has always begun. */
const NO_DONE_STEP = `the event stream shows no ${IMAGE_TOOL} tool step that reached DONE`;
/** The most of the model's final reply, and of a tool step's error message, a refusal quotes. */
const MAX_QUOTED_CHARS = 200;
/** The most of a tool step's error type a refusal quotes. */
const MAX_ERROR_TYPE_CHARS = 40;
/** Control characters: C0, DEL, C1 and the bidirectional controls, which can reorder a displayed line. */
const CONTROL_CHARS = /[\p{Cc}\p{Bidi_Control}]+/gu;
/** One half of a UTF-16 surrogate pair without its other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** A step state as agy names them (ACTIVE, DONE, ERROR); anything else is not repeated in a reason. */
const STATE_NAME = /^[A-Z_]{1,24}$/;

/**
 * @description The real image format of a buffer, by its leading bytes.
 * @param {Buffer} head - The first bytes of the file.
 * @returns {'image/png'|'image/jpeg'|null} The format, or null when it is neither.
 */
function sniffImageMime(head) {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * @description Untrusted text (a tool step's error, the model's reply) as one bounded diagnostic line:
 * control characters become spaces, whitespace runs collapse, a broken surrogate becomes U+FFFD, and a
 * line longer than `max` is cut to `max - 1` characters plus "…", never between a surrogate pair.
 * @param {unknown} value - The untrusted text.
 * @param {number} max - The most characters the line may have.
 * @returns {string} The line, possibly empty.
 */
function diagnosticLine(value, max) {
  const line = String(value == null ? '' : value)
    .replace(LONE_SURROGATE, '\ufffd').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '')}…`;
}

/**
 * @description The error an ERROR step carried (agy 1.2.8: tool_info.error = {type, message}), bounded.
 * @param {object} step - The step_update payload.
 * @returns {string} "TYPE: message", either part alone, or '' when the step carried none.
 */
function stepErrorText(step) {
  const error = step.tool_info && step.tool_info.error;
  if (typeof error === 'string') return diagnosticLine(error, MAX_QUOTED_CHARS);
  if (!error || typeof error !== 'object') return '';
  return [diagnosticLine(error.type, MAX_ERROR_TYPE_CHARS), diagnosticLine(error.message, MAX_QUOTED_CHARS)].filter(Boolean).join(': ');
}

/**
 * @description What this turn's stream-json says about generate_image: whether one of its tool steps
 * reached DONE (Guard A's first half, the only part that decides anything), whether it ran at all, how
 * many of its steps ended in ERROR and the last one's error, and the state its last step update named.
 * @param {string} stdout - The turn's stream-json output.
 * @returns {{done: boolean, ran: boolean, errors: number, lastError: string, lastState: string}} The outcome.
 */
function imageToolOutcome(stdout) {
  const outcome = { done: false, ran: false, errors: 0, lastError: '', lastState: '' };
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; } // progress noise can never prove a tool step
    const step = event && event.event === 'step_update' ? event.step_update : null;
    if (!step || step.step_type !== 'tool' || step.tool_name !== IMAGE_TOOL) continue;
    outcome.ran = true;
    outcome.lastState = STATE_NAME.test(String(step.state)) ? step.state : 'unnamed';
    if (step.state === 'DONE') outcome.done = true;
    if (step.state === 'ERROR') { outcome.errors += 1; outcome.lastError = stepErrorText(step); }
  }
  return outcome;
}

/**
 * @description Guard A's first half: did this turn's stream-json show a generate_image tool step reach DONE?
 * A stream with only run_command (or any other tool), or a generate_image that ended in ERROR, answers false.
 * @param {string} stdout - The turn's stream-json output.
 * @returns {boolean} True only for a DONE generate_image tool step.
 */
function imageToolReachedDone(stdout) {
  return imageToolOutcome(stdout).done;
}

/**
 * @description Why a turn with no DONE generate_image step is refused: Guard A's first half, then which
 * way the tool went. Guard A's own words only; the tool's error text belongs to the diagnostic.
 * @param {{ran: boolean, errors: number, lastState: string}} outcome - The turn's generate_image outcome.
 * @returns {string} The reason.
 */
function notDoneReason(outcome) {
  if (!outcome.ran) return `${NO_DONE_STEP}: ${IMAGE_TOOL} never ran in this turn`;
  if (outcome.errors) return `${NO_DONE_STEP}: ${IMAGE_TOOL} ran and ended in ERROR${outcome.errors > 1 ? `, ${outcome.errors} times` : ''}`;
  return `${NO_DONE_STEP}: ${IMAGE_TOOL} ran but did not finish (its last state was ${outcome.lastState})`;
}

/**
 * @description The untrusted diagnostic after DIAGNOSTIC_MARKER: the last ERROR step's own error text when
 * the tool ended in ERROR, and the model's final reply, each bounded and JSON-quoted.
 * @param {{errors: number, lastError: string}} outcome - The turn's generate_image outcome.
 * @param {string} reply - The model's final reply.
 * @returns {string} The diagnostic.
 */
function diagnosticFor(outcome, reply) {
  const said = diagnosticLine(reply, MAX_QUOTED_CHARS);
  const parts = outcome.errors ? [`${IMAGE_TOOL} error ${outcome.lastError ? JSON.stringify(outcome.lastError) : '(none reported)'}`] : [];
  parts.push(`model reply ${said ? JSON.stringify(said) : '(empty)'}`);
  return parts.join('; ');
}

/** The real path of a directory, or null when it cannot be resolved. */
function realDir(dir) {
  // An absent path is an expected answer here (no brain folder, a reported path that is gone).
  try { return fs.realpathSync(dir); } catch { return null; }
}

/** Directories directly under `dir`, symlinks excluded. */
function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch { return []; } // an absent folder simply has no children
}

/**
 * @description Accept one candidate only when it is a regular file inside the private brain
 * directory, written during this turn, whose bytes are a PNG or a JPEG.
 * @param {string} file - The candidate path.
 * @param {string} brainReal - The real path of the brain directory.
 * @param {number} startedAtMs - When the turn started.
 * @returns {{file: string, mimeType: string, mtimeMs: number}|null} The accepted image, or null.
 */
function acceptCandidate(file, brainReal, startedAtMs) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; } // a reported path that does not exist is no image
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAtMs - MTIME_SLACK_MS) return null;
  const real = realDir(file);
  if (!real || !real.startsWith(brainReal + path.sep)) return null;
  const head = Buffer.alloc(16);
  const fd = fs.openSync(real, 'r');
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const mimeType = sniffImageMime(head);
  return mimeType ? { file: real, mimeType, mtimeMs: stat.mtimeMs } : null;
}

/**
 * @description Primary locator: the path generate_image reported in its own step output.
 * @param {string} brain - The brain directory.
 * @param {string} brainReal - Its real path.
 * @param {number} startedAtMs - When the turn started.
 * @returns {{file: string, mimeType: string, locator: string}|null} The image, or null.
 */
function locateFromStepOutput(brain, brainReal, startedAtMs) {
  for (const conversation of childDirs(brain)) {
    for (const stepDir of childDirs(path.join(conversation, '.system_generated', 'steps'))) {
      let text = '';
      try { text = fs.readFileSync(path.join(stepDir, 'output.txt'), 'utf8'); } catch { continue; } // most steps write none
      const match = SAVED_AT.exec(text);
      if (!match) continue;
      const reported = match[1].replace(/[.,;:)\]"'`]+$/, '');
      const found = acceptCandidate(reported, brainReal, startedAtMs);
      if (found) return { ...found, locator: 'step-output' };
    }
  }
  return null;
}

/**
 * @description Fallback locator: the newest file generate_image's naming produced during the turn,
 * directly inside a conversation folder of the private brain directory.
 * @param {string} brain - The brain directory.
 * @param {string} brainReal - Its real path.
 * @param {number} startedAtMs - When the turn started.
 * @returns {{file: string, mimeType: string, locator: string}|null} The image, or null.
 */
function locateByScan(brain, brainReal, startedAtMs) {
  let newest = null;
  for (const conversation of childDirs(brain)) {
    let names = [];
    try { names = fs.readdirSync(conversation); } catch { continue; } // vanished between listing and reading
    for (const name of names.filter((n) => GENERATED_NAME.test(n))) {
      const found = acceptCandidate(path.join(conversation, name), brainReal, startedAtMs);
      if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
    }
  }
  return newest ? { ...newest, locator: 'brain-scan' } : null;
}

/**
 * @description A refusal: the turn fails with Guard A's reason followed by the untrusted diagnostic, and
 * nothing is written to the workspace. The bot log gets the same, the tool error and the reply as fields.
 * @param {string} reason - Guard A's own words.
 * @param {{outcome: object, reply: string, workspaceDir: string}} turn - What the diagnostic is made from.
 * @returns {{ok: false, reason: string}} The refusal.
 */
function refused(reason, { outcome, reply, workspaceDir }) {
  logger.warn({ workspaceDir, reason, toolError: outcome.errors ? outcome.lastError : undefined,
    modelReply: diagnosticLine(reply, MAX_QUOTED_CHARS) }, 'image turn refused');
  return { ok: false, reason: `image turn refused: ${reason}${DIAGNOSTIC_MARKER}${diagnosticFor(outcome, reply)}` };
}

/**
 * @description Copy the image into the task workspace and write its receipt. Both are created
 * exclusively: a workspace that already holds either output name or the receipt is refused, so a
 * file the model wrote itself is never mistaken for the one the tool produced.
 * @param {{file: string, mimeType: string, locator: string}} found - The located image.
 * @param {string} workspaceDir - The task workspace.
 * @returns {{ok: true, file: string, mimeType: string, bytes: number, sha256: string, locator: string}|{ok: false, why: string}} The handed-back image, or why not.
 */
function handBack(found, workspaceDir) {
  const present = [...Object.values(OUTPUT_NAMES), RECEIPT_NAME].filter((name) => fs.existsSync(path.join(workspaceDir, name)));
  if (present.length) return { ok: false, why: `the task workspace already holds ${present.join(', ')}, which this turn did not collect` };
  const bytes = fs.readFileSync(found.file);
  const name = OUTPUT_NAMES[found.mimeType];
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(workspaceDir, name), bytes, { flag: 'wx' });
  const receipt = { tool: IMAGE_TOOL, toolState: 'DONE', file: name, mimeType: found.mimeType, bytes: bytes.length, sha256, locator: found.locator };
  fs.writeFileSync(path.join(workspaceDir, RECEIPT_NAME), JSON.stringify(receipt), { flag: 'wx' });
  return { ok: true, file: name, mimeType: found.mimeType, bytes: bytes.length, sha256, locator: found.locator };
}

/**
 * @description Collect the image a generate_image call wrote during one agy turn and hand it back
 * through the task workspace. Must run BEFORE the private HOME is removed. A refusal says which way
 * the turn failed, then carries the untrusted diagnostic (the tool's error, the model's reply).
 * @param {{home: string, workspaceDir: string, stdout: string, startedAtMs: number, reply?: string}} turn - The finished turn; `reply` is the model's final reply.
 * @returns {{ok: true, file: string, mimeType: string, bytes: number, sha256: string, locator: string}|{ok: false, reason: string}} The result.
 */
function collectImageTurnOutput({ home, workspaceDir, stdout, startedAtMs, reply = '' }) {
  const outcome = imageToolOutcome(stdout);
  const refuse = (reason) => refused(reason, { outcome, reply, workspaceDir });
  if (!outcome.done) return refuse(notDoneReason(outcome));
  const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain');
  const brainReal = realDir(brain);
  if (!brainReal) return refuse(`${IMAGE_TOOL} reached DONE but the private HOME holds no brain directory`);
  const found = locateFromStepOutput(brain, brainReal, startedAtMs) || locateByScan(brain, brainReal, startedAtMs);
  if (!found) return refuse(`${IMAGE_TOOL} reached DONE but no PNG or JPEG it wrote during this turn was found in the private brain directory`);
  try {
    const handed = handBack(found, workspaceDir);
    return handed.ok ? handed : refuse(handed.why);
  } catch (error) {
    logger.error({ err: error, workspaceDir }, 'image turn: the generate_image output could not be handed back to the task workspace');
    return refuse(`the image could not be handed back to the task workspace (${error && error.code || error && error.message || error})`);
  }
}

module.exports = {
  DIAGNOSTIC_MARKER,
  IMAGE_TOOL,
  OUTPUT_NAMES,
  RECEIPT_NAME,
  collectImageTurnOutput,
  imageToolReachedDone,
  sniffImageMime,
};
