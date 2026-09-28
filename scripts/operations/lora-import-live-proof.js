#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "ADR-139 - LoRA has no image-ingest route at all" (Done-when: one image sent from the gallery lands in a named dataset and is visible in the LoRA surface). As the operator automation identity it creates a synthetic `testlab-import-<hex>` character, mints a Send-to handle carrying one generated PNG through core's artifact-exchange upload route, imports it through the installed package's POST /api/lora/dataset/import, waits for the receipt the studio shows as "ready on worker", reads the character's curated folder on the GPU worker through the same remote-client shell.exec rail LoRA dispatches on (read-only probe), then removes the box files, the import ticket and the character (its receipt, staging and grants cascade). Core rather than a package test-lab.yaml case: it orchestrates core artifact exchange, the core remote-client rail and the store package on a real worker, and the package catalog leaves live external-write cases pending.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The box probe emits plain values. The 2026-09-28 run on LoRA 1.7.1 wrote the pair to the GPU box in 3 s and the probe found it, yet the verdict was "the worker probe returned nothing readable": Windows PowerShell 5.1's `Get-Content -Raw` returns the caption as a string decorated with provider NoteProperties (PSPath, PSParentPath, PSChildName, PSDrive, PSProvider), and `ConvertTo-Json -Depth 4` serialized that as a 25 KB nested object (caption = {value, PSPath, PSDrive: {...}}) instead of a string. The caption is now read with [IO.File]::ReadAllText (UTF-8, the encoding the package writes with) and png/txt/bytes are cast to plain bool/long, so the line is exactly {"expanded":{png,bytes,txt,caption},"literal":{...}}. The verdict also names an unreadable or wrong-shaped probe (which field, the task exit, the first 300 redacted chars of the worker stdout) instead of "nothing readable", the removal path quotes its stdout the same way, and the redaction covers JSON-escaped and drive-less user-profile paths. The remove command already emitted plain Test-Path booleans; it is unchanged.
 */

'use strict';

// Usage (from a core checkout on the box, after the package is staged):
//   node scripts/operations/lora-import-live-proof.js
// Knobs: OSHAL_VERIFY_OPERATOR_PAT (else read by name from OSHAL_VERIFY_ENV_FILE or ./.env),
// OSHAL_VERIFY_API_CONTAINER, OSHAL_LORA_READY_BUDGET_MS, OSHAL_LORA_BOX_BUDGET_MS, OSHAL_LORA_POLL_MS.
// Exit 0 pass, 1 fail, 2 not runnable (no PAT / package not installed / no worker). One real GPU-worker write.

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const runner = require('./live-proof-runner');

const CASE_ID = 'lora-gallery-dataset-import';
const SUBJECT_RE = /^testlab-import-[0-9a-f]{8}$/;
const STORAGE_KEY_RE = /^lora-[0-9a-f]{32}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(?:png|jpe?g|webp)$/;
/** Mirrors the package's own default (lora-train-dispatch.ts BOX_ROOT); the api's env wins, as there. */
const DEFAULT_BOX_ROOT = '$env:USERPROFILE/lora-characters';
const DEFAULT_BUDGETS = Object.freeze({ readyBudgetMs: 180_000, boxBudgetMs: 90_000, pollMs: 3_000 });
/** The one agent id this proof's own read-only shell tasks name as their sender. */
const PROOF_AGENT_ID = 'test-lab-lora-import-proof';

const CHARACTER_SQL = 'SELECT id FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2';
const DELETE_CHARACTER_SQL = 'DELETE FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2';
/** Receipt and staged bytes cascade from the character (package migrations 103/104/105). */
const RESIDUE_SQL = `SELECT
    (SELECT count(*) FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2)::int AS characters,
    (SELECT count(*) FROM oshal_lora_dataset_images WHERE character_id = $3::uuid)::int AS receipts`;

/** @description CRC-32 table for PNG chunks. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/**
 * @description CRC-32 of a buffer (PNG chunk checksum).
 * @param {Buffer} bytes - Chunk type + data.
 * @returns {number} The unsigned checksum.
 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @description Build one small, unique, valid RGB PNG (random pixels) so every run's bytes differ.
 * @param {number} size - Width and height in pixels.
 * @param {(n: number) => Buffer} [bytes] - Random byte source.
 * @returns {Buffer} The PNG file bytes.
 */
function generatePng(size = 16, bytes = crypto.randomBytes) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const rows = [];
  for (let y = 0; y < size; y += 1) rows.push(Buffer.concat([Buffer.from([0]), bytes(size * 3)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * @description Mint one run's synthetic character and image.
 * @param {(n: number) => Buffer} [bytes] - Random byte source.
 * @returns {{tag: string, subject: string, character: object, caption: string, name: string, png: Buffer}} The fixture.
 */
function createImportFixture(bytes = crypto.randomBytes) {
  const tag = bytes(4).toString('hex');
  const subject = `testlab-import-${tag}`;
  return {
    tag, subject,
    character: { subject, displayName: `Test Lab import ${tag}`, triggerWord: subject,
      heroImage: `testlab-import-${tag}-hero.png`, identPrompt: `Test Lab synthetic import fixture ${tag}, plain color noise.` },
    caption: `${subject}, synthetic Test Lab import fixture`,
    name: `${subject}.png`,
    png: generatePng(16, bytes),
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
 * `/Users/x` or `/home/x`.
 * @param {unknown} text - Worker stdout/stderr.
 * @returns {string} The redacted text.
 */
function redactWorkerText(text) {
  return String(text ?? '').replace(/(Users\\{1,2}|\/Users\/|\/home\/)[^\\/\s"']+/g, '$1user');
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
 * @description Create the character, carry the PNG through a Send-to handle and import it.
 * @param {object} ports - api, upload.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @returns {Promise<{ok: boolean, detail?: string, handleExpiresAt?: string, imported?: object}>} What happened.
 */
async function importFixture(ports, fixture) {
  const created = await ports.api('POST', '/api/lora/characters', fixture.character);
  if (created.status !== 201) return { ok: false, detail: `POST /api/lora/characters returned HTTP ${created.status} ${created.json.error || ''}`.trim() };
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
 * @description Decide the verdict from the receipt and the worker probe.
 * @param {object} receipt - awaitReceipt's outcome.
 * @param {object|null} probe - The parsed box probe.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {object} importTask - The LoRA import task's worker result (diagnostic).
 * @param {object|null} [probeRun] - The probe task's own outcome (stdout, stderr, exitCode, error), quoted when the probe is unreadable.
 * @returns {{state: 'pass'|'fail', detail: string}} The verdict before cleanup.
 */
function decideVerdict(receipt, probe, fixture, importTask, probeRun = null) {
  const seconds = Math.round(receipt.elapsedMs / 1000);
  if (receipt.status !== 'ready') {
    const worker = importTask ? ` Worker import task: exit ${importTask.exitCode}${importTask.stderr ? `, stderr "${importTask.stderr.slice(-300)}"` : ''}.` : '';
    return { state: 'fail', detail: `The receipt did not reach "ready on worker" (status ${receipt.status} after ${seconds}s).${worker}` };
  }
  const problem = probeShapeProblem(probe);
  if (problem) return { state: 'fail', detail: unreadableProbeDetail(seconds, problem, probeRun) };
  const at = probe.expanded;
  const literal = probe.literal;
  const where = `curated folder training reads: png=${at.png} (${at.bytes} bytes), txt=${at.txt}; `
    + `single-quoted literal path: png=${literal.png}, txt=${literal.txt}`;
  const captionOk = at.caption.trim() === fixture.caption;
  if (at.png && at.txt && at.bytes === fixture.png.length && captionOk) {
    return { state: 'pass', detail: `The imported image reached "ready on worker" in ${seconds}s and the .png/.txt pair is in the character's curated folder with the exact bytes and caption (${where}).` };
  }
  return { state: 'fail', detail: `The receipt says "ready on worker" (${seconds}s) but the pair is not in the curated folder training reads (${where}; caption match=${captionOk}).` };
}

/**
 * @description Remove everything the run created and prove it: the box directory, the import ticket,
 * and the character with its cascaded receipt/staging/grants.
 * @param {object} ports - The run's ports.
 * @param {ReturnType<typeof createImportFixture>} fixture - The run's fixture.
 * @param {{worker: object|null, storageKey: string|null, ticketId: string|null}} made - What exists.
 * @param {object} budgets - Budgets.
 * @returns {Promise<string[]>} Cleanup errors; empty means everything is gone.
 */
async function cleanUpImport(ports, fixture, made, budgets) {
  const errors = [];
  if (!SUBJECT_RE.test(fixture.subject)) return ['refusing to clean up a non-fixture subject'];
  let characterId = null;
  try {
    const found = await ports.withOwner(() => ports.query(CHARACTER_SQL, [ports.ownerSub, fixture.subject]));
    characterId = found.rows[0] ? String(found.rows[0].id) : null;
  } catch (error) {
    errors.push(`character lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The box directory is named from the character id, so it is derivable even when no receipt was read.
  const storageKey = made.storageKey || (characterId ? `lora-${characterId.replace(/-/g, '')}` : null);
  if (made.worker && storageKey) errors.push(...await removeBoxDirectory(ports, made.worker, storageKey, budgets));
  if (made.ticketId) errors.push(...await removeImportTicket(ports, fixture, made.ticketId));
  try {
    await ports.withOwner(() => ports.query(DELETE_CHARACTER_SQL, [ports.ownerSub, fixture.subject]));
    const residue = (await ports.withOwner(() => ports.query(RESIDUE_SQL,
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
 * @description Run the whole case once; cleanup always runs once anything was written.
 * @param {object} ports - api, upload, tickets, query, withOwner, ownerSub, boxRoot, sleep?, now?.
 * @param {object} [options] - Budget overrides and an optional fixture.
 * @returns {Promise<{caseId: string, state: string, detail: string, evidence: object}>} The result.
 */
async function runLoraImportAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), ...ports };
  const budgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(DEFAULT_BUDGETS)) if (Number(options[key]) > 0) budgets[key] = Number(options[key]);
  const fixture = options.fixture || createImportFixture();
  const made = { worker: null, storageKey: null, ticketId: null };
  const evidence = { subject: fixture.subject, loraVersion: io.loraVersion || null, bytes: fixture.png.length };
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  let wrote = false;
  try {
    const before = await io.api('GET', `/api/lora/dataset?subject=${encodeURIComponent(fixture.subject)}`);
    if (before.status !== 404) throw new Error(`The generated character ${fixture.subject} already answers HTTP ${before.status}.`);
    wrote = true;
    const imported = await importFixture(io, fixture);
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
    Object.assign(evidence, { filename: job.filename, ticketId: job.ticketId, importTaskId: job.taskId, receipt: receipt.status, readySeconds: Math.round(receipt.elapsedMs / 1000), worker: job.clientId,
      probeTaskId: probeRun ? probeRun.taskId : null, curated: probe ? probe.expanded : null, literalPath: probe ? probe.literal : null });
    verdict = decideVerdict(receipt, probe, fixture, importTask, probeRun);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = wrote ? await cleanUpImport(io, fixture, made, budgets) : [];
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.`
    : `${verdict.detail}${wrote ? ' The box directory, the import ticket and the character (receipt, staging, grants) were removed.' : ''}`;
  return { caseId: CASE_ID, state: cleanupErrors.length ? 'fail' : verdict.state, detail, evidence: { ...evidence, cleanupErrors } };
}

/**
 * @description Host mode: stage the proof into the api container and run it there.
 * @returns {never} Exits with the proof's status.
 */
function runOnHost() {
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  if (!pat) {
    process.stdout.write(`${CASE_ID} UNAVAILABLE: ${runner.PAT_ENV} is neither exported nor in the .env; nothing was written.\n`);
    process.exit(2);
  }
  const env = { LOG_LEVEL: 'silent', OSHAL_SCHEMA_BOOTSTRAP: 'validate-only' };
  for (const name of ['OSHAL_LORA_READY_BUDGET_MS', 'OSHAL_LORA_BOX_BUDGET_MS', 'OSHAL_LORA_POLL_MS']) if (process.env[name]) env[name] = process.env[name];
  runner.reportAndExit(runner.stageAndRun({
    container: process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER,
    files: [
      { src: __filename, rel: 'operations/lora-import-live-proof.js' },
      { src: path.join(__dirname, 'live-proof-runner.js'), rel: 'operations/live-proof-runner.js' },
    ],
    entry: 'operations/lora-import-live-proof.js', env, pat, timeoutMs: 15 * 60_000,
  }));
}

/**
 * @description Loopback JSON and multipart calls as the PAT's owner.
 * @param {string} base - Loopback base URL.
 * @param {string} token - The operator PAT.
 * @returns {{api: Function, upload: Function}} The two HTTP ports.
 */
function bearerPorts(base, token) {
  const send = async (method, route, init) => {
    const response = await fetch(`${base}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json: json && typeof json === 'object' ? json : {} };
  };
  return {
    api: (method, route, body) => send(method, route, body === undefined ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    upload: (name, type, bytes) => {
      const form = new FormData();
      form.append('type', type);
      form.append('name', name);
      form.append('file', new Blob([bytes], { type }), name);
      return send('POST', '/api/artifacts/handles/upload', { body: form });
    },
  };
}

/**
 * @description Container mode: resolve the caller, the installed package and the online workers,
 * run the case once and print the RESULT line.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runInContainer() {
  const unavailable = (detail, evidence = {}) => runner.emitResult({ caseId: CASE_ID, state: 'unavailable', detail, evidence });
  const token = String(process.env[runner.PAT_ENV] || '').trim();
  if (!token) return unavailable(`${runner.PAT_ENV} was not forwarded into the container; nothing was written.`);
  const { api, upload } = bearerPorts(`http://127.0.0.1:${process.env.PORT || '5000'}`, token);
  const who = await api('GET', '/api/cli-tokens/whoami');
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return unavailable(`The operator PAT did not resolve to a caller (HTTP ${who.status}); nothing was written.`);
  const apps = await api('GET', '/api/swarm/apps?status=active');
  const lora = (Array.isArray(apps.json.apps) ? apps.json.apps : []).find((app) => app && app.name === 'lora');
  if (!lora) return unavailable('The lora package is not installed and active on this box; nothing was written.');
  const clients = await api('GET', '/api/remote-clients');
  const online = (Array.isArray(clients.json.clients) ? clients.json.clients : []).filter((c) => c && c.status === 'online');
  if (!online.length) return unavailable('No remote worker is online; nothing was written.', { loraVersion: lora.version });
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
    api, upload, ownerSub, loraVersion: lora.version, tickets: new TicketService(new PostgresTicketStore(pool)),
    workerAgentIds: Object.fromEntries(online.map((c) => [c.clientId, c.agentId || c.clientId])),
    boxRoot: process.env.LORA_BOX_ROOT || DEFAULT_BOX_ROOT,
    query: (sql, params) => pool.query(sql, params),
    withOwner: (fn) => runWithRequestIdentity({ sub: ownerSub, isOperator: false }, fn),
  }, { readyBudgetMs: process.env.OSHAL_LORA_READY_BUDGET_MS, boxBudgetMs: process.env.OSHAL_LORA_BOX_BUDGET_MS, pollMs: process.env.OSHAL_LORA_POLL_MS });
  return runner.emitResult(result);
}

if (require.main === module) {
  if (process.argv.includes('--in-container')) {
    runInContainer().catch((error) => runner.emitResult({ caseId: CASE_ID, state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else {
    runOnHost();
  }
}

module.exports = {
  CASE_ID, SUBJECT_RE, DEFAULT_BOX_ROOT, PROBE_EXCERPT_CHARS, generatePng, createImportFixture, psLiteral, buildBoxProbeCommand,
  buildBoxRemoveCommand, redactWorkerText, parseProbe, probeShapeProblem, probeExcerpt, decideVerdict, runLoraImportAcceptance,
};
