/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for Bot Forge edit-in-place (backlog "Strategy Studio and Bot Forge conversational parity", the Forge half). As the operator it writes a uniquely tagged two-bot pack into its own packs directory, deploys it through POST /api/swarm/packs/<tag>/deploy, edits the pack (new briefs and description, a drifted descriptor ticketType) and deploys it again through the Packs panel's own "Deploy to swarm" button in headless Chromium. It requires the edit to keep every agentId and the ticketType, to move the version exactly one patch, to leave one manifest (deployed-apps/<tag>.yaml, the path the swarm loaded both times, one app for the tag) and the panel to say "Updated in place". Cleanup removes the pack, the manifest and the personas, unloads the app (DELETE /api/swarm/apps/<tag>) and deletes both agents (DELETE /api/swarm/agents/<id>), each proven gone; the authorization control plane's posture and catalog rows for the tag are listed as kept, because no route removes them. Without a browser port (the Lab) the edit is deployed through the route and the panel leg is a named gap, so the case is degraded there, never pass.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The case refuses a tag it did not mint fresh. Before the first write it requires the minted tag to be unused - no pack, deployed-apps entry or persona on disk, and GET /api/swarm/apps/<tag> answering 404 - and otherwise reports unavailable with nothing written, skipping the final observation and the cleanup. Before this, a tag that was already in use was written into, and the crash path then recorded and deleted whatever was there (pack, manifest, persona, app and that app's agents).
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'forge-edit-in-place-live';
const KEY = 'forge-edit';
const TITLE = 'Bot Forge edit-in-place: an edited pack re-emits the same pack';
const NEEDS = Object.freeze(['api', 'forge', 'ownerSub']);
const PACKS = '/api/swarm/packs';
const APPS = '/api/swarm/apps';
const HOST_COMMAND = 'node scripts/operations/live-acceptance.js forge-edit';
/** The Packs panel is a desktop page; the runner's default phone viewport is for the surfaces. */
const PANEL_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const UI_TIMEOUT_MS = 45_000;
/** What the Packs panel says for a deploy the route reports as `edited` (src/api/swarm-packs.html). */
const EDITED_VERB = 'Updated in place';
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What every app registration leaves in the authorization control plane; no route removes either. */
const AUTHORIZATION_KEPT = Object.freeze([
  ['authorization-posture', 'the oshal_authorization_applications row every app registration publishes; no route removes it (operator-only control plane)'],
  ['authorization-catalog', 'the oshal_authorization_catalogs snapshot(s) recorded at registration so a later upgrade can be classified; no route removes them'],
]);

/**
 * @description The version one patch above another: what an edit must report.
 * @param {unknown} version - `major.minor.patch`.
 * @returns {string|null} The bumped version, or null for anything that is not semver.
 */
function bumpPatch(version) {
  const parts = SEMVER_RE.exec(String(version));
  return parts ? `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}` : null;
}

/**
 * @description The deploy route's `agentIds` answer as a name -> agentId map.
 * @param {unknown} agentIds - `[{name, agentId}]`.
 * @returns {Map<string, string>} The map (empty for anything else).
 */
function idsByName(agentIds) {
  const pairs = Array.isArray(agentIds) ? agentIds : [];
  return new Map(pairs.filter((p) => p && typeof p.name === 'string').map((p) => [p.name, String(p.agentId)]));
}

/**
 * @description The bot names a fixture pack's deploy registers: `<tag>-<bot>`, sorted.
 * @param {string} tag - The fixture tag.
 * @returns {string[]} The names.
 */
function botNames(tag) {
  return common.FORGE_BOTS.map((bot) => `${tag}-${bot}`).sort();
}

/**
 * @description The agent ids a loaded app record carries.
 * @param {object|null} record - GET /api/swarm/apps/<tag>'s `app`.
 * @returns {string[]} The ids, sorted.
 */
function recordAgentIds(record) {
  return (record && Array.isArray(record.agentIds) ? record.agentIds.map(String) : []).sort();
}

/**
 * @description The last segment of a manifest path, on either separator.
 * @param {unknown} manifestPath - A path the swarm reports.
 * @returns {string} Its file name.
 */
function fileName(manifestPath) {
  return String(manifestPath || '').split(/[\\/]/).pop();
}

/**
 * @description Record a fixture once: a later sighting of the same thing is not a second creation.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {string} kind - What it is.
 * @param {string} id - Its identifier.
 * @returns {void}
 */
function noteCreated(ledger, kind, id) {
  if (!ledger.entries.some((e) => e.kind === kind && e.id === String(id))) ledger.created(kind, id);
}

/**
 * @description Read-only gates before anything is written: the caller must be an operator (the
 * cleanup routes are operator-only) and the Forge's packs routes must answer for this caller.
 * @param {object} ports - api.
 * @returns {Promise<{ok: boolean, detail?: string}>} Whether the case may write.
 */
async function preflight(ports) {
  const who = await ports.api('GET', '/api/cli-tokens/whoami');
  if (who.status !== 200) return { ok: false, detail: `GET /api/cli-tokens/whoami answered HTTP ${who.status}.` };
  if (who.json.operator !== true) {
    return { ok: false, detail: 'The caller is not an operator, and removing a deployed pack needs DELETE /api/swarm/apps/:name and DELETE /api/swarm/agents/:agentId, which are operator-only, so nothing is deployed.' };
  }
  const packs = await ports.api('GET', PACKS);
  if (packs.status !== 200) return { ok: false, detail: `GET ${PACKS} answered HTTP ${packs.status}: the Bot Forge packs routes are not mounted for this caller.` };
  return { ok: true };
}

/**
 * @description Whether the freshly minted tag is unused: no pack, deployed-apps entry or persona on
 * disk, and no app under it. Anything already there is not this run's, so the case must neither write
 * into it nor clean it up.
 * @param {object} ports - api, forge.
 * @param {string} tag - The minted tag.
 * @returns {Promise<{ok: boolean, detail?: string}>} Whether the run may write under the tag.
 */
async function tagIsFree(ports, tag) {
  const files = await ports.forge.state(tag);
  const held = [files.pack === 'present' ? `a pack ${tag}` : '', ...files.manifests.map((name) => `deployed-apps/${name}`),
    ...files.personas.map((name) => `persona ${name}`)].filter(Boolean);
  const app = await ports.api('GET', `${APPS}/${tag}`);
  if (app.status !== 404) held.push(`GET ${APPS}/${tag} answered HTTP ${app.status}, not 404`);
  if (!held.length) return { ok: true };
  return { ok: false, detail: `The freshly minted tag ${tag} is already in use (${held.join('; ')}), so the case neither writes under it nor cleans it up.` };
}

/**
 * @description Deploy the fixture pack through the route the Packs panel posts to.
 * @param {object} ports - api.
 * @param {string} tag - The fixture tag.
 * @returns {Promise<{status: number, json: object}>} The route's answer.
 */
async function deployByRoute(ports, tag) {
  const res = await ports.api('POST', `${PACKS}/${tag}/deploy`);
  return { status: res.status, json: res.json || {} };
}

/**
 * @description Record what exists for the tag now (pack, manifests, personas, the loaded app and its
 * agents), so cleanup accounts for everything the run caused even when a deploy failed half way.
 * @param {object} ports - api, forge.
 * @param {{tag: string, agentIds: Set<string>, registered: boolean}} ctx - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {{json: object}|null} deploy - The deploy just made, whose agent ids are the run's too.
 * @returns {Promise<{files: object, record: object|null, appStatus: number}>} What exists.
 */
async function observe(ports, ctx, ledger, deploy) {
  const files = await ports.forge.state(ctx.tag);
  if (files.pack === 'present') noteCreated(ledger, 'forge-pack', ctx.tag);
  for (const name of files.manifests) noteCreated(ledger, 'forge-manifest', name);
  for (const name of files.personas) noteCreated(ledger, 'persona', name);
  const app = await ports.api('GET', `${APPS}/${ctx.tag}`);
  const record = app.status === 200 && app.json.app ? app.json.app : null;
  if (record || (deploy && deploy.status === 200)) ctx.registered = true;
  if (record) noteCreated(ledger, 'swarm-app', ctx.tag);
  const ids = [...recordAgentIds(record), ...(deploy ? idsByName(deploy.json.agentIds).values() : [])];
  for (const id of ids) {
    ctx.agentIds.add(id);
    noteCreated(ledger, 'agent', id);
  }
  return { files, record, appStatus: app.status };
}

/**
 * @description Open the Packs panel, press the tagged pack's "Deploy to swarm", accept its confirm,
 * and read the deploy the page posted and the toast it showed.
 * @param {object} ports - browser.
 * @param {string} tag - The fixture tag.
 * @returns {Promise<{ok: boolean, detail?: string, status?: number, json?: object, toast?: string, dialogs: string[]}>} What happened.
 */
async function deployThroughPanel(ports, tag) {
  let outcome = { ok: false, detail: 'the browser session never reported', dialogs: [] };
  await ports.browser.session(async (session) => {
    const page = await session.newPage();
    const dialogs = [];
    // What the page posted, kept apart so a panel that deploys but shows no toast still reports the deploy.
    let posted = {};
    page.on('dialog', (dialog) => { dialogs.push(String(dialog.message()).slice(0, 200)); dialog.accept().catch(() => undefined); });
    try {
      const opened = await page.goto(`${session.origin}${PACKS}/studio`, { waitUntil: 'domcontentloaded' });
      if (!opened || opened.status() !== 200) throw new Error(`${PACKS}/studio answered HTTP ${opened ? opened.status() : 'none'}`);
      const button = page.locator(`button[data-deploy="${tag}"]`).first();
      await button.waitFor({ timeout: UI_TIMEOUT_MS });
      const index = await button.getAttribute('data-i');
      const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `${PACKS}/${tag}/deploy`, { timeout: UI_TIMEOUT_MS });
      await button.click();
      const response = await answered;
      const json = await response.json().catch(() => ({}));
      posted = { status: response.status(), json: json && typeof json === 'object' ? json : {} };
      await page.waitForFunction((id) => { const el = document.getElementById(id); return Boolean(el && el.textContent && el.textContent.trim()); }, `t-${index}`, { timeout: UI_TIMEOUT_MS });
      const toast = (await page.locator(`#t-${index}`).first().innerText()).replace(/\s+/g, ' ').trim();
      outcome = { ok: true, ...posted, toast, dialogs };
    } catch (error) {
      outcome = { ok: false, detail: common.errorText(error).split(/\r?\n/)[0], dialogs, ...posted };
    } finally {
      await page.close().catch(() => undefined);
    }
  }, { viewport: PANEL_VIEWPORT });
  return outcome;
}

/**
 * @description Deploy the edit: through the Packs panel when the runner has a browser, else through
 * the route, with the panel leg reported as a gap naming the host command.
 * @param {object} ports - api, and browser on the host.
 * @param {string} tag - The fixture tag.
 * @returns {Promise<{deploy: {status: number, json: object}|null, ui: object}>} The edit's deploy and the panel leg.
 */
async function deployEdit(ports, tag) {
  if (!ports.browser) {
    return { deploy: await deployByRoute(ports, tag),
      ui: { state: 'unavailable', detail: `the Packs panel leg needs the host runner's browser port (a headless Chromium); run ${HOST_COMMAND}` } };
  }
  const panel = await deployThroughPanel(ports, tag);
  if (panel.status === undefined) return { deploy: null, ui: { state: 'fail', detail: `the Packs panel did not deploy the edit: ${panel.detail}`, dialogs: panel.dialogs } };
  const deploy = { status: panel.status, json: panel.json };
  if (!panel.ok) return { deploy, ui: { state: 'fail', detail: `the Packs panel posted the edit but showed no result: ${panel.detail}`, dialogs: panel.dialogs } };
  return { deploy, ui: { state: 'ran', toast: panel.toast, dialogs: panel.dialogs } };
}

/**
 * @description The first deploy must stand the pack up as a new app: 200, not an edit, a semver
 * version, the declared ticketType, both bots, and the app loaded.
 * @param {string} tag - The fixture tag.
 * @param {{status: number, json: object}} first - The first deploy.
 * @param {{record: object|null, appStatus: number}} before - What existed after it.
 * @returns {string[]} Problems (empty when it stood up).
 */
function judgeFirst(tag, first, before) {
  if (first.status !== 200 || first.json.ok !== true) return [`POST ${PACKS}/${tag}/deploy answered HTTP ${first.status}${first.json.error ? ` (${first.json.error})` : ''}`];
  const problems = [];
  if (first.json.edited !== false) problems.push('the first deploy of a new pack was reported as an edit');
  if (!SEMVER_RE.test(String(first.json.version))) problems.push(`the first deploy reported version ${first.json.version}`);
  if (first.json.ticketType !== tag) problems.push(`the first deploy's ticket type is ${first.json.ticketType}, not ${tag} as the pack declares`);
  const names = [...idsByName(first.json.agentIds).keys()].sort();
  if (names.join() !== botNames(tag).join()) problems.push(`the first deploy registered ${names.join(', ') || 'no bots'}, not ${botNames(tag).join(', ')}`);
  if (!before.record) problems.push(`GET ${APPS}/${tag} answered HTTP ${before.appStatus} after the first deploy: the swarm did not load the pack`);
  return problems;
}

/**
 * @description Fact 1: the edit keeps every agentId and the ticketType, in the deploy's answer and
 * in what the swarm loaded.
 * @param {string} tag - The fixture tag.
 * @param {{json: object}} first - The first deploy.
 * @param {{json: object}} edit - The edit's deploy.
 * @param {{record: object|null}} after - What the swarm holds after the edit.
 * @returns {string[]} Problems.
 */
function judgeIdentity(tag, first, edit, after) {
  const problems = [];
  const was = idsByName(first.json.agentIds);
  const now = idsByName(edit.json.agentIds);
  for (const [name, id] of was) if (now.get(name) !== id) problems.push(`${name} was re-identified by the edit: ${id} became ${now.get(name) || 'nothing'}`);
  for (const name of now.keys()) if (!was.has(name)) problems.push(`the edit registered a bot the pack never had: ${name}`);
  const expected = [...was.values()].sort();
  if (recordAgentIds(after.record).join() !== expected.join()) problems.push(`the swarm holds agentIds [${recordAgentIds(after.record).join(', ')}] after the edit, not [${expected.join(', ')}]`);
  if (edit.json.ticketType !== first.json.ticketType) {
    const forked = edit.json.ticketType === `${tag}-drift` ? '; the drifted descriptor forked a second queue' : '';
    problems.push(`the edit moved the ticket type from ${first.json.ticketType} to ${edit.json.ticketType}${forked}`);
  }
  const loadedType = after.record && after.record.manifest ? after.record.manifest.ticketType : undefined;
  if (loadedType !== first.json.ticketType) problems.push(`the swarm loaded ticket type ${loadedType}, not ${first.json.ticketType}`);
  return problems;
}

/**
 * @description Fact 2: the edit is reported as an edit and moves the version exactly one patch.
 * @param {{json: object}} first - The first deploy.
 * @param {{json: object}} edit - The edit's deploy.
 * @param {{record: object|null}} after - What the swarm holds after the edit.
 * @returns {string[]} Problems.
 */
function judgeVersion(first, edit, after) {
  const problems = [];
  const expected = bumpPatch(first.json.version);
  if (edit.json.edited !== true) problems.push('the edit was reported as a fresh deploy (edited is not true)');
  if (!expected || edit.json.version !== expected) problems.push(`the edit reported version ${edit.json.version}, not ${expected}, one patch above ${first.json.version}`);
  if (after.record && after.record.version !== edit.json.version) problems.push(`the swarm loaded version ${after.record.version}, not ${edit.json.version}`);
  return problems;
}

/**
 * @description Fact 3: one manifest. deployed-apps holds exactly `<tag>.yaml`, the swarm loaded the
 * edit from the same path as the first deploy, lists one app for the tag, and that app carries the edit.
 * @param {string} tag - The fixture tag.
 * @param {{record: object|null}} before - After the first deploy.
 * @param {{files: object, record: object|null}} after - After the edit.
 * @param {string[]} listed - App names the swarm lists for the tag.
 * @returns {string[]} Problems.
 */
function judgeManifest(tag, before, after, listed) {
  const problems = [];
  const one = `${tag}.yaml`;
  if (after.files.manifests.join() !== one) problems.push(`deployed-apps holds [${after.files.manifests.join(', ')}] for the pack, not exactly ${one}`);
  const was = before.record ? before.record.manifestPath : null;
  const now = after.record ? after.record.manifestPath : null;
  if (!now || now !== was || fileName(now) !== one) problems.push(`the swarm loaded the edit from ${fileName(now) || 'nowhere'}, not the one manifest ${one} it loaded first`);
  if (listed.length !== 1 || listed[0] !== tag) problems.push(`the swarm lists [${listed.join(', ')}] for the pack, not exactly one app ${tag}`);
  const description = common.forgeRevisionDescription(tag, 2);
  if (!after.record || after.record.description !== description) problems.push(`the loaded app does not carry the edit (description "${after.record ? after.record.description : ''}")`);
  return problems;
}

/**
 * @description Fact 4: the Packs panel says "Updated in place" for the edit.
 * @param {object} ui - The panel leg.
 * @returns {string[]} Problems (none when the leg is a gap; the verdict reports the gap).
 */
function judgePanel(ui) {
  if (ui.state === 'fail') return [ui.detail];
  if (ui.state !== 'ran') return [];
  return String(ui.toast).includes(EDITED_VERB) ? [] : [`the Packs panel said "${String(ui.toast).slice(0, 160)}", not "${EDITED_VERB}"`];
}

/**
 * @description The app names the swarm lists for the tag (the tag, or the tag followed by `-`).
 * @param {object} ports - api.
 * @param {string} tag - The fixture tag.
 * @returns {Promise<string[]>} Sorted names.
 */
async function appsForTag(ports, tag) {
  const res = await ports.api('GET', APPS);
  const apps = Array.isArray(res.json && res.json.apps) ? res.json.apps : [];
  return apps.map((app) => String(app && app.name)).filter((name) => name === tag || name.startsWith(`${tag}-`)).sort();
}

/**
 * @description The evidence a reader needs: both deploys' identities and versions, the manifests,
 * the loaded path's file name, the apps listed and what the panel said.
 * @param {string} tag - The fixture tag.
 * @param {{json: object}} first - The first deploy.
 * @param {{json: object}} edit - The edit's deploy.
 * @param {object} after - After the edit.
 * @param {string[]} listed - Apps listed for the tag.
 * @param {object} ui - The panel leg.
 * @returns {object} The evidence.
 */
function evidenceOf(tag, first, edit, after, listed, ui) {
  const view = (d) => ({ status: d.status, edited: d.json.edited, version: d.json.version, ticketType: d.json.ticketType,
    agentIds: Object.fromEntries(idsByName(d.json.agentIds)) });
  return { tag, first: view(first), edit: view(edit), manifests: after.files.manifests,
    loadedManifest: after.record ? fileName(after.record.manifestPath) : null, appsForPack: listed,
    panel: ui.state === 'ran' ? { toast: ui.toast, confirm: (ui.dialogs || [])[0] || null } : { state: ui.state, detail: ui.detail } };
}

/**
 * @description Write, deploy, edit, redeploy and judge. Cleanup is the caller's.
 * @param {object} ports - api, forge, browser on the host.
 * @param {object} ctx - The run (tag, agent ids, prune flags).
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{verdict: {state: string, detail: string}, evidence: object}>} The verdict.
 */
async function exercise(ports, ctx, ledger) {
  const { tag } = ctx;
  const written = await ports.forge.write(tag, 1);
  ctx.prune = { ownerDir: written.createdOwnerDir === true, packsRoot: written.createdPacksRoot === true };
  if (ctx.prune.packsRoot) noteCreated(ledger, 'packs-root', 'packs');
  if (ctx.prune.ownerDir) noteCreated(ledger, 'packs-owner-dir', 'packs/<owner>');
  const first = await deployByRoute(ports, tag);
  const before = await observe(ports, ctx, ledger, first);
  const stood = judgeFirst(tag, first, before);
  if (stood.length) return { verdict: { state: 'fail', detail: `The first deploy did not stand pack ${tag} up: ${stood.join('; ')}.` }, evidence: { tag, first } };
  await ports.forge.write(tag, 2);
  const { deploy: edit, ui } = await deployEdit(ports, tag);
  const after = await observe(ports, ctx, ledger, edit);
  if (!edit) return { verdict: { state: 'fail', detail: `${ui.detail}.` }, evidence: { tag, panel: ui } };
  if (edit.status !== 200 || edit.json.ok !== true) {
    return { verdict: { state: 'fail', detail: `The edit's deploy answered HTTP ${edit.status}${edit.json.error ? ` (${edit.json.error})` : ''}.` }, evidence: { tag, edit } };
  }
  const listed = await appsForTag(ports, tag);
  const problems = [...judgeIdentity(tag, first, edit, after), ...judgeVersion(first, edit, after), ...judgeManifest(tag, before, after, listed), ...judgePanel(ui)];
  const evidence = evidenceOf(tag, first, edit, after, listed, ui);
  if (problems.length) return { verdict: { state: 'fail', detail: `The edit of pack ${tag} was not an edit in place: ${problems.join('; ')}.` }, evidence };
  const held = `The edit of pack ${tag} kept both agentIds and ticket type ${edit.json.ticketType}, moved the version ${first.json.version} -> ${edit.json.version}, and left one manifest (${tag}.yaml, loaded from the same path, one app)`;
  if (ui.state !== 'ran') return { verdict: { state: 'degraded', detail: `${held}; ${ui.detail}.` }, evidence };
  return { verdict: { state: 'pass', detail: `${held}; the Packs panel said "${ui.toast}".` }, evidence };
}

/**
 * @description Remove the pack, the manifest and the personas first, so nothing on disk can load the
 * app again, then prove them gone. A parent the first write created is removed only when empty; one
 * that now holds a pack this run did not write is kept and named.
 * @param {object} ports - forge.
 * @param {{tag: string, prune: object}} ctx - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeFiles(ports, ctx, ledger) {
  await ledger.attempt(`fixture files for ${ctx.tag}`, async () => {
    const problem = await ports.forge.remove(ctx.tag, ctx.prune);
    if (problem) return problem;
    const left = await ports.forge.state(ctx.tag);
    if (left.pack !== 'absent' || left.manifests.length || left.personas.length) return `files remain for ${ctx.tag} after removal`;
    const done = ledger.entries.filter((e) => ['forge-pack', 'forge-manifest', 'persona'].includes(e.kind) && e.state === 'created');
    for (const { kind, id } of done) ledger.removed(kind, id);
    for (const [flag, kind, id] of [['ownerDir', 'packs-owner-dir', 'packs/<owner>'], ['packsRoot', 'packs-root', 'packs']]) {
      if (!ctx.prune[flag]) continue;
      if (left[flag] === 'absent') ledger.removed(kind, id);
      else ledger.kept(kind, id, 'it now holds a pack this run did not write');
    }
    return null;
  });
}

/**
 * @description Unload the app through DELETE /api/swarm/apps/<tag> and prove it gone (404). The
 * record's agent ids join the run's before the unload, so the agent cleanup cannot miss one.
 * @param {object} ports - api.
 * @param {{tag: string, agentIds: Set<string>, registered: boolean}} ctx - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeApp(ports, ctx, ledger) {
  await ledger.attempt(`swarm app ${ctx.tag} unload`, async () => {
    const route = `${APPS}/${ctx.tag}`;
    const present = await ports.api('GET', route);
    if (present.status === 404) {
      if (ledger.entries.some((e) => e.kind === 'swarm-app' && e.state === 'created')) ledger.removed('swarm-app', ctx.tag);
      return null;
    }
    if (present.status !== 200) return `GET ${route} answered HTTP ${present.status} before the unload`;
    ctx.registered = true;
    noteCreated(ledger, 'swarm-app', ctx.tag);
    for (const id of recordAgentIds(present.json.app)) { ctx.agentIds.add(id); noteCreated(ledger, 'agent', id); }
    const unloaded = await ports.api('DELETE', route);
    if (unloaded.status !== 200 || unloaded.json.unloaded !== true) return `DELETE ${route} answered HTTP ${unloaded.status}${unloaded.json.error ? ` (${unloaded.json.error})` : ''}`;
    const gone = await ports.api('GET', route);
    if (gone.status !== 404) return `GET ${route} answered HTTP ${gone.status} after the unload, not 404`;
    ledger.removed('swarm-app', ctx.tag);
    return null;
  });
}

/**
 * @description Delete one agent the run caused through DELETE /api/swarm/agents/<id> and prove it gone
 * through its profile read (404). Its config, tool and persona-layer rows cascade.
 * @param {object} ports - api.
 * @param {string} agentId - The agent.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeAgent(ports, agentId, ledger) {
  await ledger.attempt(`agent ${agentId} delete`, async () => {
    if (!UUID_RE.test(agentId)) return `refusing to delete a non-uuid agent id ${String(agentId).slice(0, 60)}`;
    const profile = `/api/agents/${agentId}/profile`;
    const present = await ports.api('GET', profile);
    if (present.status === 404) { ledger.removed('agent', agentId); return null; }
    if (present.status !== 200) return `GET ${profile} answered HTTP ${present.status} before the delete`;
    const deleted = await ports.api('DELETE', `/api/swarm/agents/${agentId}`);
    if (deleted.status !== 200) return `DELETE /api/swarm/agents/${agentId} answered HTTP ${deleted.status}`;
    const gone = await ports.api('GET', profile);
    if (gone.status !== 404) return `GET ${profile} answered HTTP ${gone.status} after the delete, not 404`;
    ledger.removed('agent', agentId);
    return null;
  });
}

/**
 * @description Remove everything the run caused: files first, then the app, then its agents; the
 * authorization control plane's rows for the tag are listed as kept once the app was registered.
 * @param {object} ports - api, forge.
 * @param {object} ctx - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function cleanup(ports, ctx, ledger) {
  await removeFiles(ports, ctx, ledger);
  await removeApp(ports, ctx, ledger);
  for (const agentId of [...ctx.agentIds]) await removeAgent(ports, agentId, ledger);
  if (!ctx.registered) return;
  for (const [kind, why] of AUTHORIZATION_KEPT) {
    noteCreated(ledger, kind, ctx.tag);
    ledger.kept(kind, ctx.tag, why);
  }
}

/**
 * @description Run the case once.
 * @param {object} ports - api, forge, ownerSub; browser on the host.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const gate = await preflight(ports);
  if (!gate.ok) return common.unavailable(CASE_ID, gate.detail);
  const ctx = { tag: common.mintTag(KEY), agentIds: new Set(), registered: false, prune: {} };
  // Before the first write: a tag already in use is not this run's, so nothing below may run for it,
  // including the final observation and the cleanup, which would claim and delete what is there.
  const free = await tagIsFree(ports, ctx.tag);
  if (!free.ok) return common.unavailable(CASE_ID, free.detail, { tag: ctx.tag });
  const ledger = new common.CleanupLedger();
  let outcome;
  try {
    outcome = await exercise(ports, ctx, ledger);
  } catch (error) {
    outcome = { verdict: { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` }, evidence: { tag: ctx.tag } };
  }
  // A crash can leave a step unobserved; one last look puts whatever exists for the tag on the ledger.
  await observe(ports, ctx, ledger, null).catch((error) => ledger.error(`final observation failed: ${common.errorText(error)}`));
  await cleanup(ports, ctx, ledger);
  return common.finish(CASE_ID, outcome.verdict, ledger, outcome.evidence);
}

module.exports = {
  CASE_ID, KEY, TITLE, NEEDS, HOST_COMMAND, EDITED_VERB, PANEL_VIEWPORT, AUTHORIZATION_KEPT,
  bumpPatch, judgeFirst, judgeIdentity, judgeVersion, judgeManifest, judgePanel, run,
};
