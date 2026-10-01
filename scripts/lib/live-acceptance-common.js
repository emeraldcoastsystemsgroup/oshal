/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the pieces every automated live-acceptance case shares (scripts/lib/live-acceptance-*.js, driven by scripts/operations/live-acceptance.js and the Test Lab cards in test-lab-live-acceptance-scenarios.ts): uniquely tagged fixture names, a cleanup ledger that turns anything created-and-not-removed (or any cleanup error) into a red result, the one result shape with its cleanup receipt, a bounded poll, same-origin action headers and the fixture-workspace removal the Jarvis cases need. Plain CommonJS with node built-ins only, so the image carries it (Dockerfile.oshal COPY scripts/lib/*.js) and the host runner can stage it into a container.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A closed set of named file probes (FILE_PROBES, fileProbeState), the file counterpart of the closed statement set: a case names a probe and an id, never a path, and the probe resolves the one path the product uses in the process that serves it. The first probe, `vids.export`, is the attached MP4 of a vids finished job, so the vids-publish case can prove its cleanup removed the media and not only the rows. A case probes the file present before it trusts an absent answer.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECOND_PAT_ENV, the one name of the environment value that carries a second caller's token. The host runner reads it by name and binds it as the `second` port, and a case that acts as someone other than the operator names it in its verdict; both take the name from here so they cannot drift.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The Bot Forge edit-in-place case's fixture pack as a closed set (forgePackWrite, forgePackState, forgePackRemove): a port names a `testlab-live-forge-edit-<8 hex>` tag and revision 1 or 2, never a path or content. The pack is written where the packer leaves one and the deploy route reads it (packs/<sha256(sub), 32 hex>/<tag>/), revision 2 is the operator's edit (new briefs, a drifted descriptor ticketType), and removal takes the pack, every deployed-apps entry and every persona file named for the tag, plus the parents the first write created when they are empty. Built-ins only, so the host runner can still stage this file into the api container.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | forgePackRemove removes a pack folder only when its pack.json carries this run's marker. It refused only a folder marked for ANOTHER run, so a folder with no marker or an unreadable pack.json (which reads as no marker) was deleted although nothing showed it was the run's own; now any of those refuses and nothing under the tag is touched.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | A closed set of directory probes beside the file probes: `build.root` lists a build root's folder in the shared workspace (its resolved path, whether it exists, and its files' relative names, bounded, links never followed) for the tickets-in-tickets case. A case names the probe and a ticket UUID, never a path.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Every fixture name this family mints starts with this, so cleanup can refuse anything else. */
const TAG_PREFIX = 'testlab-live';
/** A tag: `testlab-live-<case key>-<8 hex>`, optionally with a `-<n>` ordinal for multi-fixture cases. */
const TAG_RE = /^testlab-live-[a-z][a-z0-9-]{1,40}-[0-9a-f]{8}(?:-\d{1,2})?$/;
/**
 * Result states a case reports. `unavailable` = this deployment cannot exercise the claim (a package or
 * flag is missing, or the brain the claim is about is not the one answering); the detail names why.
 */
const STATES = Object.freeze(['pass', 'fail', 'degraded', 'unavailable']);
/** An ISO calendar day. */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The environment value that carries a SECOND caller's token, for a case that must act as someone
 * other than the operator (a Little Monsters student filing into a teacher's class). The host runner
 * reads it by name, as it reads the operator token, and binds that caller as the `second` port. A
 * runner without it binds no such port, and the case reports that leg unavailable by this name.
 */
const SECOND_PAT_ENV = 'OSHAL_VERIFY_SECOND_PAT';
/** The Token Chase capture directory a bot writes into an ask workspace, and its end-of-run record. */
const CAPTURE_DIR = '.tokenchase';
const FINAL_FILE = 'final.json';

/**
 * @description Mint one run's fixture tag for a case.
 * @param {string} caseKey - The case's short key (lower-case, hyphenated).
 * @param {(n: number) => Buffer} [bytes] - Random source (injectable for tests).
 * @returns {string} `testlab-live-<key>-<8 hex>`.
 */
function mintTag(caseKey, bytes = crypto.randomBytes) {
  const tag = `${TAG_PREFIX}-${caseKey}-${bytes(4).toString('hex')}`;
  if (!TAG_RE.test(tag)) throw new Error(`invalid case key for a fixture tag: ${caseKey}`);
  return tag;
}

/**
 * @description Whether a string is a fixture tag this family minted.
 * @param {unknown} value - Candidate.
 * @returns {boolean} True for a well-formed tag.
 */
function isFixtureTag(value) {
  return typeof value === 'string' && TAG_RE.test(value);
}

/**
 * @description Render any thrown value as one sentence.
 * @param {unknown} error - The thrown value.
 * @returns {string} Its message.
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records what one run created, removed or deliberately kept, and every cleanup error. A run is
 * clean only when nothing is left in the `created` state and no error was recorded.
 */
class CleanupLedger {
  constructor() {
    /** @type {Array<{kind: string, id: string, state: 'created'|'removed'|'kept', byRun: boolean, note?: string}>} */
    this.entries = [];
    /** @type {string[]} */
    this.errors = [];
  }

  /**
   * @description Record a fixture the run wrote.
   * @param {string} kind - What it is (e.g. `ticket`).
   * @param {unknown} id - Its identifier.
   * @param {string} [note] - Optional context.
   * @returns {void}
   */
  created(kind, id, note) {
    this.entries.push({ kind, id: String(id), state: 'created', byRun: true, ...(note ? { note } : {}) });
  }

  /**
   * @description Mark a created fixture as removed (after the removal was verified).
   * @param {string} kind - What it is.
   * @param {unknown} id - Its identifier.
   * @returns {void}
   */
  removed(kind, id) {
    const matches = this.entries.filter((e) => e.kind === kind && e.id === String(id));
    const entry = matches.find((e) => e.state === 'created') || matches[0];
    if (entry) entry.state = 'removed';
    else this.entries.push({ kind, id: String(id), state: 'removed', byRun: true });
  }

  /**
   * @description Record something the run touched or produced and deliberately leaves, with why.
   * @param {string} kind - What it is.
   * @param {unknown} id - Its identifier.
   * @param {string} why - Why it stays (memory-only TTL, pre-existing, evidence).
   * @returns {void}
   */
  kept(kind, id, why) {
    const entry = this.entries.find((e) => e.kind === kind && e.id === String(id));
    if (entry) Object.assign(entry, { state: 'kept', note: why });
    else this.entries.push({ kind, id: String(id), state: 'kept', byRun: false, note: why });
  }

  /**
   * @description Record a cleanup error.
   * @param {string} message - What went wrong.
   * @returns {void}
   */
  error(message) {
    if (message) this.errors.push(String(message));
  }

  /**
   * @description Run one cleanup action; a returned string or a throw becomes a cleanup error.
   * @param {string} label - What the action is.
   * @param {() => Promise<string|null|void>} action - The action.
   * @returns {Promise<void>} Resolves when recorded.
   */
  async attempt(label, action) {
    try {
      const problem = await action();
      if (problem) this.error(problem);
    } catch (error) {
      this.error(`${label} failed: ${errorText(error)}`);
    }
  }

  /** @returns {Array<{kind: string, id: string}>} Fixtures created and not removed or kept. */
  outstanding() {
    return this.entries.filter((e) => e.state === 'created').map(({ kind, id }) => ({ kind, id }));
  }

  /** @returns {boolean} True when nothing is outstanding and no error was recorded. */
  complete() {
    return this.errors.length === 0 && this.outstanding().length === 0;
  }

  /** @returns {{created: number, removed: string[], kept: string[], outstanding: string[], errors: string[]}} The receipt. */
  receipt() {
    const label = (e) => `${e.kind} ${e.id}`;
    return {
      created: this.entries.filter((e) => e.byRun).length,
      removed: this.entries.filter((e) => e.state === 'removed').map(label),
      kept: this.entries.filter((e) => e.state === 'kept').map((e) => `${label(e)} (${e.note})`),
      outstanding: this.outstanding().map(label),
      errors: [...this.errors],
    };
  }
}

/**
 * @description One line a human reads for a receipt.
 * @param {ReturnType<CleanupLedger['receipt']>} receipt - The receipt.
 * @returns {string} e.g. `removed 2 (ticket t, draft 4); kept 1 (...); outstanding 0; errors 0`.
 */
function receiptLine(receipt) {
  const list = (items) => (items.length ? ` (${items.join('; ')})` : '');
  return `removed ${receipt.removed.length}${list(receipt.removed)}; kept ${receipt.kept.length}${list(receipt.kept)}; `
    + `outstanding ${receipt.outstanding.length}${list(receipt.outstanding)}; errors ${receipt.errors.length}${list(receipt.errors)}`;
}

/**
 * @description Close a run: attach the receipt, and turn any cleanup miss into a red result.
 * @param {string} caseId - The case id.
 * @param {{state: string, detail: string}} verdict - The verdict before cleanup.
 * @param {CleanupLedger} ledger - The run's ledger.
 * @param {object} [evidence] - Evidence to report.
 * @returns {{caseId: string, state: string, detail: string, evidence: object, cleanup: object}} The result.
 */
function finish(caseId, verdict, ledger, evidence = {}) {
  const receipt = ledger.receipt();
  const state = STATES.includes(verdict.state) ? verdict.state : 'fail';
  if (ledger.complete()) return { caseId, state, detail: verdict.detail, evidence, cleanup: receipt };
  const misses = [...receipt.errors, ...receipt.outstanding.map((item) => `${item} was not removed`)];
  return { caseId, state: 'fail', detail: `${verdict.detail} CLEANUP INCOMPLETE: ${misses.join('; ')}.`, evidence, cleanup: receipt };
}

/**
 * @description The result for a case that could not run here; it wrote nothing.
 * @param {string} caseId - The case id.
 * @param {string} detail - Why (and the one step that would make it runnable).
 * @param {object} [evidence] - Evidence.
 * @returns {object} The result.
 */
function unavailable(caseId, detail, evidence = {}) {
  return finish(caseId, { state: 'unavailable', detail: `${detail} Nothing was written.` }, new CleanupLedger(), evidence);
}

/**
 * @description Which of the named ports are missing.
 * @param {object} ports - The ports a runner bound.
 * @param {string[]} names - Required port names.
 * @returns {string[]} The missing names.
 */
function missingPorts(ports, names) {
  return names.filter((name) => !ports || ports[name] === undefined || ports[name] === null);
}

/**
 * @description Default clock and sleep, overridable by the caller's ports (tests pass fakes).
 * @param {object} ports - The ports.
 * @returns {object} The ports with `sleep` and `now` guaranteed.
 */
function withClock(ports) {
  return { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), ...ports };
}

/**
 * @description Call `probe` every `pollMs` until it reports done or `budgetMs` runs out.
 * @param {{sleep: Function, now: Function}} io - Clock.
 * @param {{budgetMs: number, pollMs: number}} budget - Bounds.
 * @param {() => Promise<{done: boolean, value?: unknown}>} probe - One observation.
 * @returns {Promise<{done: boolean, value: unknown, elapsedMs: number}>} The last observation.
 */
async function pollUntil(io, budget, probe) {
  const started = io.now();
  let last = { done: false, value: undefined };
  for (;;) {
    last = await probe();
    if (last.done) return { done: true, value: last.value, elapsedMs: io.now() - started };
    if (io.now() - started >= budget.budgetMs) return { done: false, value: last.value, elapsedMs: io.now() - started };
    await io.sleep(budget.pollMs);
  }
}

/**
 * @description Headers for a same-origin action route (Test Lab runs, package tools, dev mode):
 * those routes refuse a request whose Origin is not the server's own and whose marker header is
 * missing. A bearer-token or signed-in loopback caller sends exactly what the page would.
 * @param {string} origin - The server's own origin (the runner's base URL).
 * @param {string} marker - The route's marker header name.
 * @returns {Record<string, string>} The headers.
 */
function sameOriginHeaders(origin, marker) {
  return { origin: String(origin).replace(/\/+$/, ''), [marker]: '1' };
}

/**
 * @description Numeric positive overrides for a case's budgets.
 * @param {Record<string, number>} defaults - The case's defaults.
 * @param {object} options - Caller options.
 * @returns {Record<string, number>} Defaults with accepted overrides.
 */
function budgetsFrom(defaults, options = {}) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

/**
 * @description Where a fixture's workspace lives, only when it is exactly `<root>/<tag>`.
 * @param {string} root - The shared workspace root.
 * @param {string} id - A fixture tag.
 * @returns {string|null} The directory, or null when the id is not a fixture tag.
 */
function fixtureWorkspaceDir(root, id) {
  if (!root || !isFixtureTag(id)) return null;
  const base = path.resolve(root);
  const dir = path.resolve(base, id);
  return path.dirname(dir) === base && path.basename(dir) === id ? dir : null;
}

/**
 * @description Whether a bot is still writing a fixture's ask workspace.
 * @param {string} root - The shared workspace root.
 * @param {string} id - The fixture tag (a Jarvis session id).
 * @returns {'final'|'no-capture'|'running'|'absent'} What the workspace shows.
 */
function fixtureWorkspaceState(root, id) {
  const dir = fixtureWorkspaceDir(root, id);
  if (!dir || !fs.existsSync(dir)) return 'absent';
  const capture = path.join(dir, CAPTURE_DIR);
  if (!fs.existsSync(capture)) return 'no-capture';
  return fs.existsSync(path.join(capture, FINAL_FILE)) ? 'final' : 'running';
}

/**
 * @description Remove a fixture's ask workspace after checking every captured frame belongs to the
 * owner. Never touches a directory that is not `<root>/<fixture tag>`.
 * @param {string} root - The shared workspace root.
 * @param {string} id - The fixture tag.
 * @param {string} ownerSub - The owner every frame must carry.
 * @returns {string|null} An error sentence, or null when removed or never created.
 */
function removeFixtureWorkspace(root, id, ownerSub) {
  const dir = fixtureWorkspaceDir(root, id);
  if (!dir) return `refusing to remove a workspace for non-fixture id ${String(id).slice(0, 80)}`;
  if (!fs.existsSync(dir)) return null;
  const capture = path.join(dir, CAPTURE_DIR);
  const frames = fs.existsSync(capture) ? fs.readdirSync(capture).filter((name) => /^frame-\d+\.json$/.test(name)) : [];
  for (const name of frames) {
    const owner = JSON.parse(fs.readFileSync(path.join(capture, name), 'utf8')).userSub ?? null;
    if (owner !== ownerSub) return `workspace ${id} holds a frame stamped for another owner; not removed`;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return fs.existsSync(dir) ? `workspace ${id} still exists after removal` : null;
}

/** A lower-case UUID, the only id shape a file probe accepts. */
const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The closed set of files a case may ask about, by name. Like the closed statement set, a case never
 * sends a path: it names a probe and an id, the probe validates the id and resolves the one path the
 * product itself would use, in the process (api container or api server) that serves the product.
 * A case must probe a file PRESENT before it trusts an ABSENT answer, so a probe whose path drifted
 * from the product's makes the case fail instead of passing blind.
 */
const FILE_PROBES = Object.freeze({
  // vids (store) finished exports: vids/src-routes/vids-artifact-files.ts artifactPath() stores an
  // attached MP4 at <CLINE_WORKSPACE_ROOT or /app/workspace-shared>/vids-artifacts/<artifact id>.mp4.
  'vids.export': Object.freeze({
    idPattern: LOWER_UUID_RE,
    resolve: (env, id) => path.join(env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared', 'vids-artifacts', `${id}.mp4`),
  }),
});

/**
 * @description The path a named file probe checks, after validating the id.
 * @param {unknown} name - The probe a case asked for.
 * @param {unknown} id - The id the probe resolves.
 * @param {NodeJS.ProcessEnv} [env] - The serving process's environment.
 * @returns {string} The one path the product uses for that id.
 * @throws {Error} For a name outside the closed set or an id the probe does not accept.
 */
function fileProbePath(name, id, env = process.env) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(FILE_PROBES, name)) {
    throw new Error(`unknown live-acceptance file probe: ${String(name).slice(0, 60)}`);
  }
  const probe = FILE_PROBES[name];
  if (typeof id !== 'string' || !probe.idPattern.test(id)) throw new Error(`invalid id for file probe ${name}`);
  return probe.resolve(env, id);
}

/**
 * @description Whether the file a named probe resolves exists (a link counts; it is never followed).
 * @param {unknown} name - The probe.
 * @param {unknown} id - The id.
 * @param {NodeJS.ProcessEnv} [env] - The serving process's environment.
 * @returns {'present'|'absent'} What is on disk.
 * @throws {Error} For an invalid probe or id, or any error other than a missing file.
 */
function fileProbeState(name, id, env = process.env) {
  const target = fileProbePath(name, id, env);
  try {
    fs.lstatSync(target);
    return 'present';
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/**
 * The closed set of directories a case may list, by name. A listing returns the directory's resolved
 * path and its files' relative names, never content; links are listed, never followed. Like the file
 * probes, a case names a probe and an id the probe validates, and never sends a path.
 */
const DIR_PROBES = Object.freeze({
  // A build root's folder in the shared workspace: <workspace root>/<root ticket id>, the folder
  // every child of the tree writes into (createTicketWorkspace's PHASE_45 rule).
  'build.root': Object.freeze({ idPattern: LOWER_UUID_RE }),
});
/** Bounds on one listing, so a runaway tree cannot flood a receipt. */
const DIR_LIST_MAX_ENTRIES = 400;
const DIR_LIST_MAX_DEPTH = 4;

/**
 * @description The directory a named probe lists, after validating the id.
 * @param {unknown} name - The probe a case asked for.
 * @param {unknown} id - The id the probe resolves.
 * @param {string} root - The serving process's shared workspace root.
 * @returns {string} The one directory the product uses for that id.
 * @throws {Error} For a name outside the closed set, an id the probe does not accept, or no root.
 */
function dirProbePath(name, id, root) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(DIR_PROBES, name)) {
    throw new Error(`unknown live-acceptance directory probe: ${String(name).slice(0, 60)}`);
  }
  if (typeof id !== 'string' || !DIR_PROBES[name].idPattern.test(id)) throw new Error(`invalid id for directory probe ${name}`);
  if (typeof root !== 'string' || !root) throw new Error('no shared workspace root to list under');
  return path.join(path.resolve(root), id);
}

/**
 * @description Collect relative file names under a directory, depth-first, within the listing bounds.
 * @param {string} dir - The directory being walked.
 * @param {string} prefix - Its path relative to the listing root.
 * @param {number} depth - Its depth below the listing root.
 * @param {{files: string[], truncated: boolean}} out - The accumulating listing.
 * @returns {void}
 */
function collectFileNames(dir, prefix, depth, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.files.length >= DIR_LIST_MAX_ENTRIES) { out.truncated = true; return; }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && depth < DIR_LIST_MAX_DEPTH) collectFileNames(path.join(dir, entry.name), relative, depth + 1, out);
    else if (!entry.isDirectory()) out.files.push(relative);
  }
}

/**
 * @description List a named probe's directory: whether it exists and its files' relative names.
 * @param {unknown} name - The probe.
 * @param {unknown} id - The id.
 * @param {string} root - The serving process's shared workspace root.
 * @returns {{path: string, exists: boolean, files: string[], truncated: boolean}} What is on disk.
 * @throws {Error} For an invalid probe or id, or any error other than a missing directory.
 */
function dirProbeListing(name, id, root) {
  const dir = dirProbePath(name, id, root);
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: dir, exists: false, files: [], truncated: false };
    throw error;
  }
  const out = { files: [], truncated: false };
  if (stat.isDirectory()) collectFileNames(dir, '', 0, out);
  return { path: dir, exists: true, files: out.files.sort(), truncated: out.truncated };
}

/**
 * The Bot Forge edit-in-place case's fixture pack, a closed set like the file probes: a port names a
 * forge-edit tag and a revision, never a path or pack content. The pack lives where the Forge's
 * packer writes it and the deploy route reads it (src/app/routes/swarm-pack-routes.ts): the shared
 * workspace's packs/<sha256(sub), 32 hex>/<tag>/ with a pack.json and one bots/<name>.yml per bot.
 */
const FORGE_TAG_RE = /^testlab-live-forge-edit-[0-9a-f]{8}$/;
/** The two bots every revision declares, so "the same agentIds" is an exact comparison. */
const FORGE_BOTS = Object.freeze(['checker', 'worker']);
/** The pack.json field that marks a pack directory as this run's fixture. */
const FORGE_MARKER = 'liveAcceptanceFixture';

/**
 * @description Validate a forge-edit fixture tag.
 * @param {unknown} tag - Candidate.
 * @returns {string} The tag.
 * @throws {Error} For anything that is not `testlab-live-forge-edit-<8 hex>`.
 */
function forgeTag(tag) {
  if (typeof tag !== 'string' || !FORGE_TAG_RE.test(tag)) throw new Error(`not a forge-edit fixture tag: ${String(tag).slice(0, 80)}`);
  return tag;
}

/**
 * @description Validate a fixture revision: 1 is the first cut, 2 the operator's edit.
 * @param {unknown} revision - Candidate.
 * @returns {1|2} The revision.
 * @throws {Error} For any other value.
 */
function forgeRevision(revision) {
  if (revision !== 1 && revision !== 2) throw new Error(`a forge fixture revision is 1 or 2, not ${String(revision).slice(0, 20)}`);
  return revision;
}

/**
 * @description The per-user packs key, derived exactly as swarm-pack-routes.ts derives userKey().
 * @param {unknown} sub - The owner subject.
 * @returns {string} 32 hex characters.
 * @throws {Error} Without a subject.
 */
function forgeUserKey(sub) {
  if (typeof sub !== 'string' || !sub) throw new Error('an owner subject is required');
  return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32);
}

/**
 * @description The manifest description a revision declares, so the case can tell which revision loaded.
 * @param {string} tag - The fixture tag.
 * @param {1|2} revision - The revision.
 * @returns {string} The description.
 */
function forgeRevisionDescription(tag, revision) {
  return `Live acceptance fixture ${forgeTag(tag)}, revision ${forgeRevision(revision)}.`;
}

/**
 * @description The pack content of one revision. Revision 2 rewrites both briefs and the description
 * and drifts the descriptor's ticketType, which an edit must NOT follow. Each bot's only routing
 * keyword is the tag, which no real request carries.
 * @param {string} tag - The fixture tag.
 * @param {1|2} revision - The revision.
 * @returns {{descriptor: object, bots: object[]}} pack.json and the bot files.
 */
function forgePackRevision(tag, revision) {
  const descriptor = { name: forgeTag(tag), mode: 'swarm', description: forgeRevisionDescription(tag, revision),
    ticketType: forgeRevision(revision) === 1 ? tag : `${tag}-drift`, bots: [...FORGE_BOTS], [FORGE_MARKER]: tag };
  const bots = FORGE_BOTS.map((name) => ({ name, role: name === 'worker' ? 'Worker' : 'Checker',
    perspective: `Synthetic live-acceptance ${name} for ${tag}, revision ${revision}. Nothing is ever dispatched to it.`,
    capabilities: [tag] }));
  return { descriptor, bots };
}

/**
 * @description The fixture pack's directory and its two parents.
 * @param {string} root - The shared workspace root.
 * @param {string} sub - The owner subject.
 * @param {string} tag - The fixture tag.
 * @returns {{packsRoot: string, ownerDir: string, dir: string}} Absolute paths.
 */
function forgePackPaths(root, sub, tag) {
  if (typeof root !== 'string' || !root) throw new Error('a workspace root is required');
  const packsRoot = path.join(path.resolve(root), 'packs');
  const ownerDir = path.join(packsRoot, forgeUserKey(sub));
  return { packsRoot, ownerDir, dir: path.join(ownerDir, forgeTag(tag)) };
}

/**
 * @description The fixture marker a pack directory's pack.json carries, if any.
 * @param {string} dir - The pack directory.
 * @returns {string|null} The marker, or null when there is no readable pack.json.
 */
function forgeMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'))[FORGE_MARKER] ?? null; } catch { return null; }
}

/**
 * @description Write a revision of the fixture pack the way the packer leaves a pack: pack.json and
 * one bots/<name>.yml per bot (JSON text, which is valid YAML). Revision 1 refuses an existing
 * directory; revision 2 edits only a directory that carries this run's marker.
 * @param {string} root - The shared workspace root.
 * @param {string} sub - The owner subject.
 * @param {string} tag - The fixture tag.
 * @param {1|2} revision - The revision.
 * @returns {{files: string[], createdOwnerDir: boolean, createdPacksRoot: boolean}} What was written, and which parents this write created.
 * @throws {Error} When the directory is not this run's to write.
 */
function forgePackWrite(root, sub, tag, revision) {
  const { descriptor, bots } = forgePackRevision(tag, revision);
  const { packsRoot, ownerDir, dir } = forgePackPaths(root, sub, tag);
  if (revision === 1 && fs.existsSync(dir)) throw new Error(`pack ${tag} already exists for this owner; not overwritten`);
  if (revision === 2 && forgeMarker(dir) !== tag) throw new Error(`pack ${tag} is not this run's fixture; not edited`);
  const createdPacksRoot = !fs.existsSync(packsRoot);
  const createdOwnerDir = !fs.existsSync(ownerDir);
  fs.mkdirSync(path.join(dir, 'bots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  for (const bot of bots) fs.writeFileSync(path.join(dir, 'bots', `${bot.name}.yml`), `${JSON.stringify(bot, null, 2)}\n`);
  return { files: ['pack.json', ...bots.map((bot) => `bots/${bot.name}.yml`)], createdOwnerDir, createdPacksRoot };
}

/**
 * @description Entry names in a directory that belong to a fixture tag: the tag itself, or the tag
 * followed by `.` or `-` (a tag ends in 8 hex, so no other run's tag can match).
 * @param {string} dir - The directory.
 * @param {string} tag - The fixture tag.
 * @param {RegExp} [shape] - An extra filter on the name.
 * @returns {string[]} Sorted names; empty when the directory is absent.
 */
function forgeEntries(dir, tag, shape = /./) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => (name === tag || name.startsWith(`${tag}.`) || name.startsWith(`${tag}-`)) && shape.test(name)).sort();
}

/**
 * @description What exists for a fixture tag: the pack, every deployed-apps entry (the Forge's one
 * manifest is `<tag>.yaml`) and every persona file the deploy wrote under the api's working directory.
 * @param {string} root - The shared workspace root.
 * @param {string} appRoot - The api's working directory (personas live in its ai-lab/bot-personas).
 * @param {string} sub - The owner subject.
 * @param {string} tag - The fixture tag.
 * @returns {{pack: string, ownerDir: string, packsRoot: string, manifests: string[], personas: string[]}} present/absent and names.
 */
function forgePackState(root, appRoot, sub, tag) {
  const { packsRoot, ownerDir, dir } = forgePackPaths(root, sub, tag);
  const state = (target) => (fs.existsSync(target) ? 'present' : 'absent');
  return { pack: state(dir), ownerDir: state(ownerDir), packsRoot: state(packsRoot),
    manifests: forgeEntries(path.join(path.resolve(root), 'deployed-apps'), tag),
    personas: forgeEntries(path.join(path.resolve(appRoot), 'ai-lab', 'bot-personas'), tag, /\.ya?ml$/) };
}

/**
 * @description Remove an empty directory; a directory with anything in it stays.
 * @param {string} dir - The directory.
 * @returns {void}
 */
function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * @description Remove everything a fixture tag left on disk (pack, deployed-apps entries, personas)
 * and the parents the first write created, when empty. Refuses, touching nothing, when the pack folder
 * exists without this run's marker (none, an unreadable pack.json, or another run's).
 * @param {string} root - The shared workspace root.
 * @param {string} appRoot - The api's working directory.
 * @param {string} sub - The owner subject.
 * @param {string} tag - The fixture tag.
 * @param {{ownerDir?: boolean, packsRoot?: boolean}} [prune] - Parents the write created.
 * @returns {string|null} What is still there, or null when everything is gone.
 */
function forgePackRemove(root, appRoot, sub, tag, prune = {}) {
  const { packsRoot, ownerDir, dir } = forgePackPaths(root, sub, tag);
  // Only a folder that proves it is this run's fixture is removed: no marker, an unreadable pack.json
  // or another run's marker all mean it is somebody else's, and then nothing under the tag is touched.
  if (fs.existsSync(dir) && forgeMarker(dir) !== tag) return `pack ${tag} does not carry this run's fixture marker; nothing was removed`;
  fs.rmSync(dir, { recursive: true, force: true });
  const deployed = path.join(path.resolve(root), 'deployed-apps');
  for (const name of forgeEntries(deployed, tag)) fs.rmSync(path.join(deployed, name), { recursive: true, force: true });
  const personas = path.join(path.resolve(appRoot), 'ai-lab', 'bot-personas');
  for (const name of forgeEntries(personas, tag, /\.ya?ml$/)) fs.rmSync(path.join(personas, name), { force: true });
  if (prune.ownerDir === true) removeIfEmpty(ownerDir);
  if (prune.packsRoot === true) removeIfEmpty(packsRoot);
  const left = forgePackState(root, appRoot, sub, tag);
  const remains = [left.pack === 'present' ? `pack ${tag}` : '', ...left.manifests.map((n) => `deployed-apps/${n}`), ...left.personas.map((n) => `persona ${n}`)]
    .filter(Boolean);
  return remains.length ? `still on disk after removal: ${remains.join(', ')}` : null;
}

module.exports = {
  TAG_PREFIX,
  TAG_RE,
  STATES,
  ISO_DAY_RE,
  SECOND_PAT_ENV,
  mintTag,
  isFixtureTag,
  errorText,
  CleanupLedger,
  receiptLine,
  finish,
  unavailable,
  missingPorts,
  withClock,
  pollUntil,
  sameOriginHeaders,
  budgetsFrom,
  fixtureWorkspaceDir,
  fixtureWorkspaceState,
  removeFixtureWorkspace,
  FILE_PROBES,
  fileProbePath,
  fileProbeState,
  DIR_PROBES,
  dirProbePath,
  dirProbeListing,
  FORGE_TAG_RE,
  FORGE_BOTS,
  FORGE_MARKER,
  forgeTag,
  forgeRevision,
  forgeUserKey,
  forgeRevisionDescription,
  forgePackRevision,
  forgePackWrite,
  forgePackState,
  forgePackRemove,
};
