#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "ADR-139 - LoRA has no image-ingest route at all" (Done-when: one image sent from the gallery lands in a named dataset and is visible in the LoRA surface). As the operator automation identity it creates a synthetic `testlab-import-<hex>` character, mints a Send-to handle carrying one generated PNG through core's artifact-exchange upload route, imports it through the installed package's POST /api/lora/dataset/import, waits for the receipt the studio shows as "ready on worker", reads the character's curated folder on the GPU worker through the same remote-client shell.exec rail LoRA dispatches on (read-only probe), then removes the box files, the import ticket and the character (its receipt, staging and grants cascade). Core rather than a package test-lab.yaml case: it orchestrates core artifact exchange, the core remote-client rail and the store package on a real worker, and the package catalog leaves live external-write cases pending.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The box probe emits plain values. The 2026-09-28 run on LoRA 1.7.1 wrote the pair to the GPU box in 3 s and the probe found it, yet the verdict was "the worker probe returned nothing readable": Windows PowerShell 5.1's `Get-Content -Raw` returns the caption as a string decorated with provider NoteProperties (PSPath, PSParentPath, PSChildName, PSDrive, PSProvider), and `ConvertTo-Json -Depth 4` serialized that as a 25 KB nested object (caption = {value, PSPath, PSDrive: {...}}) instead of a string. The caption is now read with [IO.File]::ReadAllText (UTF-8, the encoding the package writes with) and png/txt/bytes are cast to plain bool/long, so the line is exactly {"expanded":{png,bytes,txt,caption},"literal":{...}}. The verdict also names an unreadable or wrong-shaped probe (which field, the task exit, the first 300 redacted chars of the worker stdout) instead of "nothing readable", the removal path quotes its stdout the same way, and the redaction covers JSON-escaped and drive-less user-profile paths. The remove command already emitted plain Test-Path booleans; it is unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The redaction is case-insensitive again. Entry 2 folded the Windows-form pattern (which carried the `i` flag on main) into one regex with the JSON-escaped, drive-less and POSIX forms and dropped that flag, so a lowercased `c:\users\x` or an upper-cased `C:\USERS\x` passed through unredacted. Windows paths are case-insensitive and PowerShell keeps the casing it is given (on 5.1, Convert-Path/FullName/PSPath keep a lowercased input lowercased), so a non-canonical LORA_BOX_ROOT would have put the operator's username into the verdict text that lands in PR bodies and COLLABORATE. `/gi` restores the guard; the spec now pins both spellings.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Gallery mode (`--gallery`), beside the unchanged inline mode. Entry #18's third clause names the portrait GALLERY and the rendered SURFACE, and the inline mode proved neither: its handle came from the upload mint (inline bytes, sourcePath null) and the import was a bearer POST, not the studio page. Gallery mode runs on the host (the browser lives there): it creates one synthetic portrait through POST /api/portrait-studio/portraits, waits for the engine to mark it done, mints the locator handle exactly as the gallery's Send to… does (scripts/lib/lora-gallery-source.js), opens /api/lora/ui?artifact=<ref> in a headless Chromium as the caller, clicks the fixture character and "Import selected image", and reads #datasetRows until the studio itself shows the file "ready on worker" - a run whose receipt route says ready while the surface does not is red, and so is a page error. The DB-bound cleanup (character, residue, ticket) goes through the live-acceptance container helper as named statements, so both modes now run the same closed set (scripts/lib/live-acceptance-sql.js `lora.*`) instead of SQL text. Offline workers are named in the UNAVAILABLE verdict, the portrait is deleted after it revalidates by its title tag, and the inline mode's staged run now carries the two lib modules it requires.
 */

'use strict';

// Usage (from a core checkout on the box, after the package is staged):
//   node scripts/operations/lora-import-live-proof.js             inline mode: a generated PNG through the upload mint, in the api container
//   node scripts/operations/lora-import-live-proof.js --gallery   gallery mode: a real portrait, the gallery's locator mint and the studio page in headless Chromium, on the host
// Knobs: OSHAL_VERIFY_OPERATOR_PAT (else read by name from OSHAL_VERIFY_ENV_FILE or ./.env),
// OSHAL_VERIFY_API_CONTAINER, OSHAL_VERIFY_BASE_URL (gallery mode; default http://127.0.0.1:35457),
// OSHAL_LORA_READY_BUDGET_MS, OSHAL_LORA_BOX_BUDGET_MS, OSHAL_LORA_POLL_MS, OSHAL_LORA_PORTRAIT_BUDGET_MS (gallery mode).
// Exit 0 pass, 1 fail, 2 not runnable (no PAT / package not installed / no worker / no image engine). One real GPU-worker write;
// gallery mode also spends one real portrait generation.

const crypto = require('node:crypto');
const path = require('node:path');
const runner = require('./live-proof-runner');
const gallery = require('../lib/lora-gallery-source');
const { statementText } = require('../lib/live-acceptance-sql');

const CASE_ID = 'lora-gallery-dataset-import';
const SUBJECT_RE = /^testlab-import-[0-9a-f]{8}$/;
const STORAGE_KEY_RE = /^lora-[0-9a-f]{32}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(?:png|jpe?g|webp)$/;
/** Mirrors the package's own default (lora-train-dispatch.ts BOX_ROOT); the api's env wins, as there. */
const DEFAULT_BOX_ROOT = '$env:USERPROFILE/lora-characters';
const DEFAULT_BASE_URL = 'http://127.0.0.1:35457';
const DEFAULT_BUDGETS = Object.freeze({ readyBudgetMs: 180_000, boxBudgetMs: 90_000, pollMs: 3_000, portraitBudgetMs: 300_000 });
const BUDGET_ENV = Object.freeze({ readyBudgetMs: 'OSHAL_LORA_READY_BUDGET_MS', boxBudgetMs: 'OSHAL_LORA_BOX_BUDGET_MS',
  pollMs: 'OSHAL_LORA_POLL_MS', portraitBudgetMs: 'OSHAL_LORA_PORTRAIT_BUDGET_MS' });
const EXIT_CODES = Object.freeze({ pass: 0, fail: 1, unavailable: 2, degraded: 3 });
/** The one agent id this proof's own read-only shell tasks name as their sender. */
const PROOF_AGENT_ID = 'test-lab-lora-import-proof';

/**
 * @description Build one small, unique, valid RGB PNG (random pixels) so every run's bytes differ.
 * @param {number} size - Width and height in pixels.
 * @param {(n: number) => Buffer} [bytes] - Random byte source.
 * @returns {Buffer} The PNG file bytes.
 */
function generatePng(size = 16, bytes = crypto.randomBytes) {
  return gallery.encodePng(size, size, () => bytes(size * 3));
}

/**
 * @description Mint one run's synthetic character and image: a generated PNG for the inline mode,
 * a synthetic photo for the gallery mode (the dataset image is then the portrait the engine paints).
 * @param {(n: number) => Buffer} [bytes] - Random byte source.
 * @param {'inline'|'gallery'} [source] - Which image source the run uses.
 * @returns {{tag: string, subject: string, character: object, caption: string, name: string, png: Buffer|null, photo: Buffer|null}} The fixture.
 */
function createImportFixture(bytes = crypto.randomBytes, source = 'inline') {
  const tag = bytes(4).toString('hex');
  const subject = `testlab-import-${tag}`;
  return {
    tag, subject,
    character: { subject, displayName: `Test Lab import ${tag}`, triggerWord: subject,
      heroImage: `testlab-import-${tag}-hero.png`, identPrompt: `Test Lab synthetic import fixture ${tag}, plain color noise.` },
    caption: `${subject}, synthetic Test Lab import fixture`,
    name: `${subject}.png`,
    png: source === 'gallery' ? null : generatePng(16, bytes),
    photo: source === 'gallery' ? gallery.generatePortraitPhoto(gallery.DEFAULT_PHOTO_SIZE, bytes) : null,
  };
}

/**
 * @description Quote a value as a PowerShell single-quoted literal, exactly as the package does.
 * @param {string} value - The text.
 * @returns {string} The literal.
 */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @description The read-only probe of one dataset entry on the worker. It checks the path the
 * package's TRAINING command reads (the box root inside double quotes, so PowerShell expands it) and,
 * as a diagnostic, the same path as a single-quoted literal (how the package's import command writes
 * it). Prints presence, size and caption per location; never a full path. Every value is a plain
 * bool, long or .NET string: a provider-decorated string (what `Get-Content` returns on Windows
 * PowerShell 5.1) serializes as a nested object, which is what broke the 2026-09-28 run.
 * @param {string} boxRoot - The package box root (may hold $env:USERPROFILE).
 * @param {string} storageKey - lora-<32 hex>.
 * @param {string} filename - The dataset filename the import chose.
 * @returns {string} The PowerShell command.
 */
function buildBoxProbeCommand(boxRoot, storageKey, filename) {
  if (!STORAGE_KEY_RE.test(storageKey) || !FILENAME_RE.test(filename)) throw new Error('refusing to probe a non-fixture path');
  const rel = `${storageKey}/curated/${filename}`;
  return `& { $paths = [ordered]@{ expanded = "${boxRoot}/${rel}"; literal = ${psLiteral(`${boxRoot}/${rel}`)} }; $out = [ordered]@{}; `
    + 'foreach ($k in @($paths.Keys)) { $png = $paths[$k]; $txt = [IO.Path]::ChangeExtension($png, \'.txt\'); '
    + '$has = [bool](Test-Path -LiteralPath $png); $cap = [bool](Test-Path -LiteralPath $txt); '
    + '$out[$k] = [ordered]@{ png = $has; bytes = [long]$(if ($has) { (Get-Item -LiteralPath $png).Length } else { 0 }); '
    + 'txt = $cap; caption = [string]$(if ($cap) { [IO.File]::ReadAllText((Convert-Path -LiteralPath $txt), [Text.UTF8Encoding]::new($false)) } else { \'\' }) } }; '
    + '$out | ConvertTo-Json -Compress -Depth 4 }';
}

/**
 * @description Remove exactly this character's box directory at both spellings, then any literal
 * parent the import left empty, and report what still exists.
 * @param {string} boxRoot - The package box root.
 * @param {string} storageKey - lora-<32 hex>.
 * @returns {string} The PowerShell command.
 */
function buildBoxRemoveCommand(boxRoot, storageKey) {
  if (!STORAGE_KEY_RE.test(storageKey)) throw new Error('refusing to remove a non-fixture path');
  const expanded = `"${boxRoot}/${storageKey}"`;
  const literal = psLiteral(`${boxRoot}/${storageKey}`);
  // Only an unexpanded-variable root ('$env:...' written literally, relative to the worker's cwd)
  // can leave parents this run created; walk those up while empty and never past a rooted path.
  const prune = boxRoot.includes('$')
    ? `$r = ${psLiteral(boxRoot)}; while ($r -and -not [IO.Path]::IsPathRooted($r) -and (Test-Path -LiteralPath $r) -and -not (Get-ChildItem -LiteralPath $r -Force)) { Remove-Item -LiteralPath $r -Force; $r = Split-Path -Parent $r }; `
    : '';
  return `& { foreach ($d in @(${expanded}, ${literal})) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }; `
    + prune
    + `[ordered]@{ expanded = (Test-Path -LiteralPath ${expanded}); literal = (Test-Path -LiteralPath ${literal}) } | ConvertTo-Json -Compress }`;
}

/**
 * @description Replace user-profile folder names in worker output with a neutral one: `C:\Users\x`,
 * its JSON-escaped form `C:\\Users\\x`, a drive-less `Users\x` (PSDrive's CurrentLocation), and
 * `/Users/x` or `/home/x` - in any letter case, because Windows paths are case-insensitive and
 * PowerShell keeps the casing it is given (a lowercased LORA_BOX_ROOT stays lowercased in PSPath).
 * @param {unknown} text - Worker stdout/stderr.
 * @returns {string} The redacted text.
 */
function redactWorkerText(text) {
  return String(text ?? '').replace(/(Users\\{1,2}|\/Users\/|\/home\/)[^\\/\s"']+/gi, '$1user');
}

/**
 * @description Run one PowerShell command on the worker through the remote-client rail as the caller
 * and wait (bounded) for its durable result.
 * @param {object} ports - api, sleep, now.
 * @param {{clientId: string, agentId: string}} worker - The worker LoRA dispatched to.
 * @param {string} command - The command.
 * @param {object} budgets - boxBudgetMs, pollMs.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, taskId: string, error?: string}>} Outcome.
 */
async function runOnWorker(ports, worker, command, budgets) {
  const taskId = `testlab-import-shell-${crypto.randomUUID()}`;
  const queued = await ports.api('POST', `/api/remote-clients/${encodeURIComponent(worker.clientId)}/tasks`, {
    taskId, correlationId: taskId, fromAgentId: PROOF_AGENT_ID, toAgentId: worker.agentId, intent: 'mcp.call-tool',
    input: { name: 'shell.exec', arguments: { command } }, createdAt: new Date(ports.now()).toISOString(),
  });
  if (queued.status !== 201) return { ok: false, stdout: '', stderr: '', exitCode: null, taskId, error: `enqueue HTTP ${queued.status}` };
  return awaitWorkerResult(ports, worker.clientId, taskId, budgets);
}

/**
 * @description Poll one remote task's durable result.
 * @param {object} ports - api, sleep, now.
 * @param {string} clientId - The worker.
 * @param {string} taskId - The remote task.
 * @param {object} budgets - boxBudgetMs, pollMs.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, taskId: string, error?: string}>} Outcome.
 */
async function awaitWorkerResult(ports, clientId, taskId, budgets) {
  const started = ports.now();
  while (ports.now() - started < budgets.boxBudgetMs) {
    await ports.sleep(budgets.pollMs);
    const read = await ports.api('GET', `/api/remote-clients/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}/result`);
    if (read.status === 404) continue;
    const output = (read.json && read.json.output) || {};
    return { ok: read.status === 200 && read.json.status === 'completed' && output.exitCode === 0,
      stdout: String(output.stdout || ''), stderr: redactWorkerText(output.stderr || read.json.error || ''),
      exitCode: typeof output.exitCode === 'number' ? output.exitCode : null, taskId };
  }
  return { ok: false, stdout: '', stderr: '', exitCode: null, taskId, error: 'no result within the budget' };
}

/**
 * @description Parse the probe's JSON line.
 * @param {string} stdout - Worker stdout.
 * @returns {object|null} The parsed probe, or null.
 */
function parseProbe(stdout) {
  const line = String(stdout).split(/\r?\n/).map((row) => row.trim()).reverse().find((row) => row.startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

/** How much of an unreadable worker stdout a verdict quotes. The probe prints only presence, sizes and a caption. */
const PROBE_EXCERPT_CHARS = 300;

/**
 * @description Say what is wrong with a parsed probe, or nothing when it is exactly the shape the
 * probe command emits: `expanded` and `literal`, each with plain png/txt booleans, a plain bytes
 * number and a plain caption string. A decorated caption (an object) is named as such.
 * @param {unknown} probe - parseProbe's outcome.
 * @returns {string|null} The problem, or null when the probe is readable.
 */
function probeShapeProblem(probe) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return 'no JSON object line in the worker stdout';
  for (const key of ['expanded', 'literal']) {
    const at = probe[key];
    if (!at || typeof at !== 'object' || Array.isArray(at)) return `"${key}" is not an object`;
    if (typeof at.png !== 'boolean' || typeof at.txt !== 'boolean') return `"${key}".png/txt are not plain booleans`;
    if (typeof at.bytes !== 'number' || !Number.isFinite(at.bytes)) return `"${key}".bytes is not a plain number`;
    if (typeof at.caption !== 'string') return `"${key}".caption is not a plain string (${Array.isArray(at.caption) ? 'array' : typeof at.caption})`;
  }
  return null;
}

/**
 * @description The first PROBE_EXCERPT_CHARS of a worker stdout, whitespace-collapsed and redacted,
 * quoted for a verdict so the next unreadable payload names itself.
 * @param {unknown} stdout - Worker stdout.
 * @returns {string} The quoted excerpt, or "(empty)".
 */
function probeExcerpt(stdout) {
  const text = redactWorkerText(stdout).replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  return `"${text.slice(0, PROBE_EXCERPT_CHARS)}${text.length > PROBE_EXCERPT_CHARS ? '...' : ''}"`;
}

/**
 * @description The failing detail for a probe that ran but could not be read.
 * @param {number} seconds - Seconds the receipt took to reach ready.
 * @param {string} problem - probeShapeProblem's finding.
 * @param {{stdout?: unknown, stderr?: unknown, exitCode?: number|null, error?: string}|null} run - The probe task's outcome.
 * @returns {string} The detail.
 */
function unreadableProbeDetail(seconds, problem, run) {
  const outcome = run ? ` (probe task ${run.error || `exit ${run.exitCode}`})` : '';
  const stderr = run && run.stderr ? `; stderr: "${redactWorkerText(run.stderr).slice(0, PROBE_EXCERPT_CHARS)}"` : '';
  return `The receipt is ready (${seconds}s) but the worker probe returned nothing readable: ${problem}${outcome}. `
    + `Worker stdout, first ${PROBE_EXCERPT_CHARS} chars: ${probeExcerpt(run ? run.stdout : '')}${stderr}.`;
}

/**
 * @description Poll the studio's dataset receipts until this run's file leaves "queued for worker".
 * @param {object} ports - api, sleep, now.
 * @param {string} subject - The fixture character.
 * @param {string} filename - The imported filename.
 * @param {object} budgets - readyBudgetMs, pollMs.
 * @returns {Promise<{status: string, storageKey: string|null, byteSize: number|null, elapsedMs: number}>} The receipt.
 */
async function awaitReceipt(ports, subject, filename, budgets) {
  const started = ports.now();
  let last = { status: 'missing', storageKey: null, byteSize: null };
  while (ports.now() - started < budgets.readyBudgetMs) {
    await ports.sleep(budgets.pollMs);
    const read = await ports.api('GET', `/api/lora/dataset?subject=${encodeURIComponent(subject)}`);
    const row = read.status === 200 && Array.isArray(read.json.images) ? read.json.images.find((image) => image.filename === filename) : null;
    last = { status: row ? String(row.status) : `HTTP ${read.status}`, storageKey: read.json.storageKey || last.storageKey,
      byteSize: row ? Number(row.byte_size) : null };
    if (row && row.status !== 'queued') break;
  }
  return { ...last, elapsedMs: ports.now() - started };
}

/**
 * @description Create the run's character.
 * @param {object} ports - api.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @returns {Promise<void>} Resolves when created; throws with the route's answer otherwise.
 */
async function createCharacter(ports, fixture) {
  const created = await ports.api('POST', '/api/lora/characters', fixture.character);
  if (created.status !== 201) throw new Error(`POST /api/lora/characters returned HTTP ${created.status} ${created.json.error || ''}`.trim());
}

/**
 * @description Inline mode: carry the generated PNG through the upload mint and import it by POST.
 * @param {object} ports - api, upload.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @returns {Promise<{ok: boolean, detail?: string, handleExpiresAt?: string, imported?: object}>} What happened.
 */
async function importInline(ports, fixture) {
  const handle = await ports.upload(fixture.name, 'image/png', fixture.png);
  if (handle.status !== 201 || typeof handle.json.ref !== 'string') return { ok: false, detail: `POST /api/artifacts/handles/upload returned HTTP ${handle.status}` };
  const imported = await ports.api('POST', '/api/lora/dataset/import', { ref: handle.json.ref, subject: fixture.subject, caption: fixture.caption });
  if (imported.status !== 202) {
    return { ok: false, handleExpiresAt: handle.json.expiresAt, imported: imported.json,
      detail: `POST /api/lora/dataset/import returned HTTP ${imported.status} ${imported.json.status || imported.json.error || ''}`.trim() };
  }
  return { ok: true, handleExpiresAt: handle.json.expiresAt, imported: imported.json };
}

/**
 * @description Gallery mode: a real portrait, the gallery's own locator mint, and the import done
 * in the LoRA studio page by the surface port (headless Chromium as the caller).
 * @param {object} io - api, multipart, surface, sleep, now.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {{portraitId: string|null}} made - Records the portrait as soon as it exists, so cleanup deletes it.
 * @param {object} evidence - Receives the portrait and surface evidence.
 * @param {object} budgets - portraitBudgetMs, readyBudgetMs, pollMs.
 * @returns {Promise<{ok: boolean, detail?: string, handleExpiresAt?: string|null, imported?: object, surface?: object}>} What happened.
 */
async function importThroughGallery(io, fixture, made, evidence, budgets) {
  const portrait = await gallery.createPortrait(io, fixture);
  made.portraitId = portrait.id;
  if (!portrait.ok) return { ok: false, detail: portrait.detail };
  const done = await gallery.awaitPortraitDone(io, portrait.id, budgets);
  evidence.portrait = { id: portrait.id, style: portrait.style, status: done.status, model: done.model, costUsd: done.costUsd, seconds: Math.round(done.elapsedMs / 1000) };
  if (done.status !== 'done') return { ok: false, detail: `The portrait did not reach "done" (status ${done.status} after ${evidence.portrait.seconds}s${done.error ? `: ${done.error}` : ''}).` };
  const handle = await gallery.mintGalleryHandle(io, portrait.id);
  if (!handle.ok) return { ok: false, detail: handle.detail };
  const surface = await io.surface.importImage({ ref: handle.ref, displayName: fixture.character.displayName, caption: fixture.caption }, budgets, io);
  const imported = surface.response.json;
  surface.filename = typeof imported.filename === 'string' ? imported.filename : null;
  evidence.surface = { shown: surface.shown ? surface.shown.status : null, text: surface.shown ? surface.shown.text : null,
    seconds: surface.shown ? Math.round(surface.shown.elapsedMs / 1000) : null, pageErrors: surface.pageErrors };
  if (surface.response.status !== 202) {
    return { ok: false, handleExpiresAt: handle.expiresAt, imported,
      detail: `The studio's import answered HTTP ${surface.response.status} ${imported.status || imported.error || ''}`.trim() };
  }
  return { ok: true, handleExpiresAt: handle.expiresAt, imported, surface };
}

/**
 * @description What is wrong with what the LoRA surface showed, or null when it showed the file
 * "ready on worker" without a page error. Gallery mode only; the inline mode has no surface.
 * @param {{filename: string|null, shown: object|null, pageErrors: string[]}|null} surface - The surface port's observation.
 * @returns {string|null} The problem.
 */
function surfaceProblem(surface) {
  if (!surface) return null;
  const shown = surface.shown || { status: 'missing', text: '', elapsedMs: 0 };
  const seconds = Math.round(shown.elapsedMs / 1000);
  if (shown.status !== 'ready') {
    return `The LoRA surface did not show "ready on worker" for ${surface.filename || 'the imported file'}: #datasetRows showed `
      + `${shown.text ? `"${shown.text}"` : 'no row for it'} after ${seconds}s`;
  }
  if (surface.pageErrors.length) return `The LoRA surface showed "ready on worker" but raised ${surface.pageErrors.length} page error(s): ${surface.pageErrors.join(' | ')}`;
  return null;
}

/**
 * @description Decide the verdict from the receipt, the surface (gallery mode) and the worker probe.
 * @param {object} receipt - awaitReceipt's outcome.
 * @param {object|null} probe - The parsed box probe.
 * @param {{png?: Buffer|null, bytes?: number, caption: string}} expected - The exact bytes and caption the pair must hold.
 * @param {object} importTask - The LoRA import task's worker result (diagnostic).
 * @param {object|null} [probeRun] - The probe task's own outcome (stdout, stderr, exitCode, error), quoted when the probe is unreadable.
 * @param {object|null} [surface] - The surface port's observation (gallery mode), or null.
 * @returns {{state: 'pass'|'fail', detail: string}} The verdict before cleanup.
 */
function decideVerdict(receipt, probe, expected, importTask, probeRun = null, surface = null) {
  const seconds = Math.round(receipt.elapsedMs / 1000);
  if (receipt.status !== 'ready') {
    const worker = importTask ? ` Worker import task: exit ${importTask.exitCode}${importTask.stderr ? `, stderr "${importTask.stderr.slice(-300)}"` : ''}.` : '';
    const shown = surface && surface.shown ? ` The LoRA surface showed ${surface.shown.text ? `"${surface.shown.text}"` : 'no row for it'}.` : '';
    return { state: 'fail', detail: `The receipt did not reach "ready on worker" (status ${receipt.status} after ${seconds}s).${worker}${shown}` };
  }
  const surfaceIssue = surfaceProblem(surface);
  if (surfaceIssue) return { state: 'fail', detail: `${surfaceIssue} (the receipt route says ready after ${seconds}s).` };
  const problem = probeShapeProblem(probe);
  if (problem) return { state: 'fail', detail: unreadableProbeDetail(seconds, problem, probeRun) };
  const at = probe.expanded;
  const literal = probe.literal;
  const where = `curated folder training reads: png=${at.png} (${at.bytes} bytes), txt=${at.txt}; `
    + `single-quoted literal path: png=${literal.png}, txt=${literal.txt}`;
  const captionOk = at.caption.trim() === expected.caption;
  const expectedBytes = expected.png ? expected.png.length : Number(expected.bytes);
  if (at.png && at.txt && at.bytes === expectedBytes && captionOk) {
    const shown = surface ? ' the studio page showed it "ready on worker" and' : '';
    return { state: 'pass', detail: `The imported image reached "ready on worker" in ${seconds}s,${shown} the .png/.txt pair is in the character's curated folder with the exact bytes and caption (${where}).` };
  }
  return { state: 'fail', detail: `The receipt says "ready on worker" (${seconds}s) but the pair is not in the curated folder training reads (${where}; caption match=${captionOk}).` };
}

/**
 * @description Remove everything the run created and prove it: the box directory, the import ticket,
 * the portrait (gallery mode), and the character with its cascaded receipt/staging/grants.
 * @param {object} ports - The run's ports.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {{worker: object|null, storageKey: string|null, ticketId: string|null, portraitId: string|null}} made - What exists.
 * @param {object} budgets - Budgets.
 * @returns {Promise<string[]>} Cleanup errors; empty means everything is gone.
 */
async function cleanUpImport(ports, fixture, made, budgets) {
  const errors = [];
  if (!SUBJECT_RE.test(fixture.subject)) return ['refusing to clean up a non-fixture subject'];
  let characterId = null;
  try {
    const found = await ports.withOwner(() => ports.sql('lora.character-id', [ports.ownerSub, fixture.subject]));
    characterId = found.rows[0] ? String(found.rows[0].id) : null;
  } catch (error) {
    errors.push(`character lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The box directory is named from the character id, so it is derivable even when no receipt was read.
  const storageKey = made.storageKey || (characterId ? `lora-${characterId.replace(/-/g, '')}` : null);
  if (made.worker && storageKey) errors.push(...await removeBoxDirectory(ports, made.worker, storageKey, budgets));
  if (made.ticketId) errors.push(...await removeImportTicket(ports, fixture, made.ticketId));
  if (made.portraitId) errors.push(...await gallery.removePortrait(ports, made.portraitId, fixture.subject, budgets));
  try {
    await ports.withOwner(() => ports.sql('lora.character-delete', [ports.ownerSub, fixture.subject]));
    const residue = (await ports.withOwner(() => ports.sql('lora.residue',
      [ports.ownerSub, fixture.subject, characterId || '00000000-0000-0000-0000-000000000000']))).rows[0] || {};
    if (Number(residue.characters) || Number(residue.receipts)) errors.push(`database residue: characters=${residue.characters}, receipts=${residue.receipts}`);
  } catch (error) {
    errors.push(`character cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * @description Delete the import's `lora-train` ticket through the ticket service as its owner, after
 * re-reading it: only this run's dataset-import ticket for this fixture character is ever deleted.
 * Not DELETE /api/tickets: that route answers 404 for a package ticket whose application result the
 * caller's token may not read (measured live 2026-09-27), and a 404 there cannot tell "gone" from
 * "refused" - which is how the first run reported this ticket removed while it sat in dead_letter.
 * @param {object} ports - tickets (getTicket/deleteTicket), withOwner, ownerSub.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {string} ticketId - The ticket the import answered with.
 * @returns {Promise<string[]>} Errors; empty when the ticket is gone.
 */
async function removeImportTicket(ports, fixture, ticketId) {
  try {
    return await ports.withOwner(async () => {
      const ticket = await ports.tickets.getTicket(ticketId);
      if (!ticket) return [];
      const metadata = ticket.metadata || {};
      if (ticket.ownerSub !== ports.ownerSub || ticket.ticketType !== 'lora-train'
        || metadata.character !== fixture.subject || metadata.action !== 'dataset-import') {
        return [`ticket ${ticketId} did not revalidate as this run's import ticket; not deleted`];
      }
      await ports.tickets.deleteTicket(ticketId);
      return (await ports.tickets.getTicket(ticketId)) ? [`ticket ${ticketId} still exists after deletion`] : [];
    });
  } catch (error) {
    return [`ticket ${ticketId} cleanup failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * @description Remove this character's box directory through the rail and require both spellings gone.
 * @param {object} ports - api, boxRoot, sleep, now.
 * @param {{clientId: string, agentId: string}} worker - The worker.
 * @param {string} storageKey - lora-<32 hex>.
 * @param {object} budgets - Budgets.
 * @returns {Promise<string[]>} Errors; empty when removed.
 */
async function removeBoxDirectory(ports, worker, storageKey, budgets) {
  const removed = await runOnWorker(ports, worker, buildBoxRemoveCommand(ports.boxRoot, storageKey), budgets);
  const left = parseProbe(removed.stdout);
  if (removed.ok && left && left.expanded === false && left.literal === false) return [];
  return [`box directory ${storageKey} was not removed (${removed.error || `exit ${removed.exitCode}`}; worker stdout: ${probeExcerpt(removed.stdout)})`];
}

/**
 * @description Create the character, import the image through the run's source, and observe the
 * receipt and the worker: everything the verdict is decided from.
 * @param {object} io - The run's ports with clock.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {object} made - What exists (filled as things are created).
 * @param {object} evidence - The run's evidence (filled as things are observed).
 * @param {object} budgets - Budgets.
 * @returns {Promise<{state: 'pass'|'fail', detail: string}>} The verdict before cleanup.
 */
async function observeImport(io, fixture, made, evidence, budgets) {
  await createCharacter(io, fixture);
  const imported = io.source === 'gallery' ? await importThroughGallery(io, fixture, made, evidence, budgets) : await importInline(io, fixture);
  Object.assign(evidence, { handleExpiresAt: imported.handleExpiresAt || null });
  if (imported.imported) made.ticketId = imported.imported.ticketId || null;
  if (!imported.ok) throw new Error(imported.detail);
  const job = imported.imported;
  made.worker = { clientId: job.clientId, agentId: io.workerAgentIds?.[job.clientId] || job.clientId };
  const receipt = await awaitReceipt(io, fixture.subject, job.filename, budgets);
  made.storageKey = STORAGE_KEY_RE.test(receipt.storageKey || '') ? receipt.storageKey : null;
  const importTask = receipt.status === 'ready' ? null : await awaitWorkerResult(io, job.clientId, job.taskId, { ...budgets, boxBudgetMs: budgets.pollMs * 2 });
  const probeRun = receipt.status === 'ready' && made.storageKey
    ? await runOnWorker(io, made.worker, buildBoxProbeCommand(io.boxRoot, made.storageKey, job.filename), budgets) : null;
  const probe = probeRun ? parseProbe(probeRun.stdout) : null;
  Object.assign(evidence, { filename: job.filename, ticketId: job.ticketId, importTaskId: job.taskId, receipt: receipt.status, readySeconds: Math.round(receipt.elapsedMs / 1000),
    bytes: fixture.png ? fixture.png.length : Number(job.byteSize) || receipt.byteSize, worker: job.clientId,
    probeTaskId: probeRun ? probeRun.taskId : null, curated: probe ? probe.expanded : null, literalPath: probe ? probe.literal : null });
  const expected = { png: fixture.png, bytes: evidence.bytes, caption: fixture.caption };
  return decideVerdict(receipt, probe, expected, importTask, probeRun, imported.surface || null);
}

/**
 * @description Run the whole case once; cleanup always runs once anything was written.
 * @param {object} ports - api, upload (inline) / multipart + surface (gallery), tickets, sql, withOwner, ownerSub, boxRoot, source?, sleep?, now?.
 * @param {object} [options] - Budget overrides and an optional fixture.
 * @returns {Promise<{caseId: string, state: string, detail: string, evidence: object}>} The result.
 */
async function runLoraImportAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), source: 'inline', ...ports };
  const budgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(DEFAULT_BUDGETS)) if (Number(options[key]) > 0) budgets[key] = Number(options[key]);
  const fixture = options.fixture || createImportFixture(crypto.randomBytes, io.source);
  const made = { worker: null, storageKey: null, ticketId: null, portraitId: null };
  const evidence = { source: io.source, subject: fixture.subject, loraVersion: io.loraVersion || null,
    ...(io.source === 'gallery' ? { portraitStudioVersion: io.portraitVersion || null } : {}) };
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  let wrote = false;
  try {
    const before = await io.api('GET', `/api/lora/dataset?subject=${encodeURIComponent(fixture.subject)}`);
    if (before.status !== 404) throw new Error(`The generated character ${fixture.subject} already answers HTTP ${before.status}.`);
    wrote = true;
    verdict = await observeImport(io, fixture, made, evidence, budgets);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = wrote ? await cleanUpImport(io, fixture, made, budgets) : [];
  const removedWhat = `The box directory, the import ticket${made.portraitId ? ', the portrait' : ''} and the character (receipt, staging, grants) were removed.`;
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.` : `${verdict.detail}${wrote ? ` ${removedWhat}` : ''}`;
  return { caseId: CASE_ID, state: cleanupErrors.length ? 'fail' : verdict.state, detail, evidence: { ...evidence, cleanupErrors } };
}

/**
 * @description The budget overrides the environment carries, by name.
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @returns {object} Budget options for runLoraImportAcceptance.
 */
function budgetOptions(env) {
  return Object.fromEntries(Object.entries(BUDGET_ENV).map(([key, name]) => [key, env[name]]));
}

/**
 * @description The workers LoRA can dispatch to, or why there are none - an offline worker is named.
 * @param {Function} api - Bearer JSON port.
 * @returns {Promise<{online: object[], detail: string|null}>} The online workers, or the UNAVAILABLE detail.
 */
async function onlineWorkers(api) {
  const clients = await api('GET', '/api/remote-clients');
  const list = (Array.isArray(clients.json.clients) ? clients.json.clients : []).filter((c) => c && typeof c.clientId === 'string');
  const online = list.filter((c) => c.status === 'online');
  if (online.length) return { online, detail: null };
  const named = list.map((c) => `${c.clientId} (${c.status || 'unknown'})`).join(', ');
  return { online, detail: list.length ? `No GPU worker is online: ${named}; nothing was written.` : 'No remote worker is registered on this box; nothing was written.' };
}

/**
 * @description Resolve the caller, the installed LoRA package and the online workers, or why the
 * case cannot run here (nothing written).
 * @param {Function} api - Bearer JSON port.
 * @returns {Promise<{detail: string, evidence?: object}|{ownerSub: string, loraVersion: string, workerAgentIds: object}>} The run's identity, or the UNAVAILABLE detail.
 */
async function resolveRun(api) {
  const who = await api('GET', '/api/cli-tokens/whoami');
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return { detail: `The operator PAT did not resolve to a caller (HTTP ${who.status}); nothing was written.` };
  const apps = await api('GET', '/api/swarm/apps?status=active');
  const lora = (Array.isArray(apps.json.apps) ? apps.json.apps : []).find((app) => app && app.name === 'lora');
  if (!lora) return { detail: 'The lora package is not installed and active on this box; nothing was written.' };
  const workers = await onlineWorkers(api);
  if (workers.detail) return { detail: workers.detail, evidence: { loraVersion: lora.version } };
  return { ownerSub, loraVersion: lora.version, workerAgentIds: Object.fromEntries(workers.online.map((c) => [c.clientId, c.agentId || c.clientId])) };
}

/**
 * @description Loopback JSON and multipart calls as the PAT's owner.
 * @param {string} base - Base URL.
 * @param {string} token - The operator PAT.
 * @returns {{api: Function, multipart: Function, upload: Function}} The HTTP ports.
 */
function bearerPorts(base, token) {
  const send = async (method, route, init) => {
    const response = await fetch(`${base}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json: json && typeof json === 'object' ? json : {} };
  };
  const multipart = (route, fields, file) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields || {})) form.append(name, String(value));
    form.append(file.field || 'file', new Blob([file.bytes], { type: file.type }), file.name);
    return send('POST', route, { body: form });
  };
  return {
    api: (method, route, body) => send(method, route, body === undefined ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    multipart,
    upload: (name, type, bytes) => multipart('/api/artifacts/handles/upload', { type, name }, { field: 'file', name, type, bytes }),
  };
}

/**
 * @description Host, inline mode: stage the proof into the api container and run it there.
 * @returns {never} Exits with the proof's status.
 */
function runInlineOnHost() {
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  if (!pat) {
    process.stdout.write(`${CASE_ID} UNAVAILABLE: ${runner.PAT_ENV} is neither exported nor in the .env; nothing was written.\n`);
    process.exit(2);
  }
  const env = { LOG_LEVEL: 'silent', OSHAL_SCHEMA_BOOTSTRAP: 'validate-only' };
  for (const name of Object.values(BUDGET_ENV)) if (process.env[name]) env[name] = process.env[name];
  const lib = path.join(__dirname, '..', 'lib');
  runner.reportAndExit(runner.stageAndRun({
    container: process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER,
    files: [
      { src: __filename, rel: 'operations/lora-import-live-proof.js' },
      { src: path.join(__dirname, 'live-proof-runner.js'), rel: 'operations/live-proof-runner.js' },
      { src: path.join(lib, 'lora-gallery-source.js'), rel: 'lib/lora-gallery-source.js' },
      { src: path.join(lib, 'live-acceptance-sql.js'), rel: 'lib/live-acceptance-sql.js' },
    ],
    entry: 'operations/lora-import-live-proof.js', env, pat, timeoutMs: 15 * 60_000,
  }));
}

/**
 * @description Container, inline mode: resolve the caller, the installed package and the online
 * workers, run the case once and print the RESULT line.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runInContainer() {
  const unavailable = (detail, evidence = {}) => runner.emitResult({ caseId: CASE_ID, state: 'unavailable', detail, evidence });
  const token = String(process.env[runner.PAT_ENV] || '').trim();
  if (!token) return unavailable(`${runner.PAT_ENV} was not forwarded into the container; nothing was written.`);
  const ports = bearerPorts(`http://127.0.0.1:${process.env.PORT || '5000'}`, token);
  const run = await resolveRun(ports.api);
  if (run.detail) return unavailable(run.detail, run.evidence || {});
  const dist = process.env.OSHAL_ACCEPTANCE_DIST_DIR || path.join(process.cwd(), 'dist');
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createOptionalPostgresPool } = require(path.join(dist, 'shared/services/database/optional-postgres-pool.js'));
  const { runWithRequestIdentity } = require(path.join(dist, 'shared/services/database/request-identity.js'));
  const { TicketService } = require(path.join(dist, 'features/ticketing/services/ticket-service.js'));
  const { PostgresTicketStore } = require(path.join(dist, 'features/ticketing/services/ticket-store-postgres.js'));
  /* eslint-enable @typescript-eslint/no-require-imports */
  const pool = createOptionalPostgresPool('lora-import-live-proof');
  if (!pool) return unavailable('This container has no PostgreSQL configuration; nothing was written.');
  const result = await runLoraImportAcceptance({
    ...ports, ...run, source: 'inline', tickets: new TicketService(new PostgresTicketStore(pool)),
    boxRoot: process.env.LORA_BOX_ROOT || DEFAULT_BOX_ROOT,
    sql: (name, params) => pool.query(statementText(name), params),
    withOwner: (fn) => runWithRequestIdentity({ sub: run.ownerSub, isOperator: false }, fn),
  }, budgetOptions(process.env));
  return runner.emitResult(result);
}

/**
 * @description Print one result the way the container runs are printed, and exit with its code.
 * @param {{caseId: string, state: string, detail: string, evidence?: object}} result - The verdict.
 * @returns {never} Exits the process.
 */
function reportHostResult(result) {
  const status = EXIT_CODES[result.state] === undefined ? 1 : EXIT_CODES[result.state];
  runner.reportAndExit({ status, stdout: `${runner.RESULT_PREFIX}${JSON.stringify(result)}\n`, stderr: '' });
}

/**
 * @description Host, gallery mode: bearer HTTP against the box, the DB-bound cleanup through the
 * live-acceptance container helper (named statements and the ticket service, as the owner), the box
 * root from the api container's environment, and the studio page in headless Chromium as the caller.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runGalleryOnHost() {
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  const unavailable = (detail, evidence = {}) => reportHostResult({ caseId: CASE_ID, state: 'unavailable', detail, evidence });
  if (!pat) return unavailable(`${runner.PAT_ENV} is neither exported nor in the .env; nothing was written.`);
  const base = String(process.env.OSHAL_VERIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const container = process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER;
  const ports = bearerPorts(base, pat);
  const run = await resolveRun(ports.api);
  if (run.detail) return unavailable(run.detail, run.evidence || {});
  const portrait = await gallery.portraitPreflight(ports.api);
  if (!portrait.ok) return unavailable(`${portrait.detail}; nothing was written.`, { loraVersion: run.loraVersion });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const acceptance = require('./live-acceptance');
  const helper = acceptance.containerHelper(container);
  const owner = acceptance.containerPorts(helper, run.ownerSub);
  let result;
  try {
    result = await runLoraImportAcceptance({
      ...ports, ...run, source: 'gallery', portraitVersion: portrait.version, sql: owner.sql,
      tickets: { getTicket: owner.tickets.get, deleteTicket: owner.tickets.delete }, withOwner: (fn) => fn(),
      boxRoot: gallery.readContainerEnv(container, 'LORA_BOX_ROOT') || DEFAULT_BOX_ROOT,
      surface: gallery.createSurfacePort({ origin: base, token: pat }),
    }, budgetOptions(process.env));
  } catch (error) {
    result = { caseId: CASE_ID, state: 'fail', detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} };
  } finally {
    helper.dispose();
  }
  return reportHostResult(result);
}

if (require.main === module) {
  if (process.argv.includes('--in-container')) {
    runInContainer().catch((error) => runner.emitResult({ caseId: CASE_ID, state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else if (process.argv.includes('--gallery')) {
    runGalleryOnHost().catch((error) => reportHostResult({ caseId: CASE_ID, state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else {
    runInlineOnHost();
  }
}

module.exports = {
  CASE_ID, SUBJECT_RE, DEFAULT_BOX_ROOT, DEFAULT_BUDGETS, PROBE_EXCERPT_CHARS, generatePng, createImportFixture, psLiteral, buildBoxProbeCommand,
  buildBoxRemoveCommand, redactWorkerText, parseProbe, probeShapeProblem, probeExcerpt, surfaceProblem, decideVerdict, onlineWorkers, resolveRun,
  bearerPorts, runLoraImportAcceptance,
};
