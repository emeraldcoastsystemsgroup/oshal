/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the pieces every automated live-acceptance case shares (scripts/lib/live-acceptance-*.js, driven by scripts/operations/live-acceptance.js and the Test Lab cards in test-lab-live-acceptance-scenarios.ts): uniquely tagged fixture names, a cleanup ledger that turns anything created-and-not-removed (or any cleanup error) into a red result, the one result shape with its cleanup receipt, a bounded poll, same-origin action headers and the fixture-workspace removal the Jarvis cases need. Plain CommonJS with node built-ins only, so the image carries it (Dockerfile.oshal COPY scripts/lib/*.js) and the host runner can stage it into a container.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A closed set of named file probes (FILE_PROBES, fileProbeState), the file counterpart of the closed statement set: a case names a probe and an id, never a path, and the probe resolves the one path the product uses in the process that serves it. The first probe, `vids.export`, is the attached MP4 of a vids finished job, so the vids-publish case can prove its cleanup removed the media and not only the rows. A case probes the file present before it trusts an absent answer.
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

module.exports = {
  TAG_PREFIX,
  TAG_RE,
  STATES,
  ISO_DAY_RE,
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
};
