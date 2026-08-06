#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Smart-home (home bundle) device-control CLI. Reads the per-user SmartThings Personal Access Token from the OSHAL connector store (oshal_connections, provider='smartthings') — connected at /utilities, no separate CLI auth. Mirrors scripts/oshal-gmail.js token resolution: prefer a controller-brokered token (.oshal-cred-smartthings / OSHAL_CRED_SMARTTHINGS), else decrypt the per-user token from the DB. Commands: devices/status/control on|off|set, scenes list|execute, and a default JSON digest (devices + state + scenes) the home-bot reasons over.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Multi-account selection (ADR-042): a user/household can have several SmartThings connections; pick one with OSHAL_CONNECTION_LABEL / OSHAL_CONNECTION_EMAIL / OSHAL_CONNECTION_ID (the home-bot tools pass the label the user named, e.g. "lake house"). New `accounts` verb lists the caller's labeled connections (the catalog the bot selects from). Resolution is personal ∪ shared (household). With a selector, resolve from the DB by it (ignoring the single brokered default); a bare request with multiple connections exits 2 listing the labels so the bot asks which.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bot-owned store (ADR-036): new `index` verb builds the unified, DEDUPED device index (canonical-name join across hubs, prior user renames preserved) and persists it to the per-user store at $OSHAL_HOME_DATA_DIR/<sub>/devices.json (shared `home-data` volume, home-bot :rw / api :ro). The cheap read-model the Smart Home surface renders without an LLM call (GET /api/home/devices). Store helpers (readStore/writeStore/slug) added; foundation for bot-owned scenes/prefs/history next.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bot-owned SCENES: scene-save/scene-run/scene-del/myscenes verbs over scenes.json. SmartThings can't create vendor scenes via API, so the bot owns its own — a named step list ([{device:<canonical key>,cmd:on|off|set,...}]) replayed through the control commands; steps reference devices by index key (hub-agnostic, survives id churn). Surfaced cheaply at GET /api/home/scenes.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Read SmartThings PATs through the shared v2/k2/legacy connector-token codec instead of a private legacy-only decryptor.
 *
 *   node scripts/oshal-smartthings.js                      # JSON digest (devices+state, scenes)
 *   node scripts/oshal-smartthings.js index                # build+persist the deduped device index (store)
 *   node scripts/oshal-smartthings.js myscenes             # list BOT-OWNED scenes
 *   node scripts/oshal-smartthings.js scene-save <name> '<stepsJson>'  # create/replace a bot-owned scene
 *   node scripts/oshal-smartthings.js scene-run <name>     # replay a bot-owned scene
 *   node scripts/oshal-smartthings.js scene-del <name>     # delete a bot-owned scene
 *   node scripts/oshal-smartthings.js accounts             # list THIS user's labeled connections
 *   node scripts/oshal-smartthings.js devices              # list devices
 *   node scripts/oshal-smartthings.js status <deviceId>    # one device's status
 *   node scripts/oshal-smartthings.js control <deviceId> on|off
 *   node scripts/oshal-smartthings.js control <deviceId> set <capability> <command> [arg]
 *   node scripts/oshal-smartthings.js scenes               # list scenes
 *   node scripts/oshal-smartthings.js scene <sceneId>      # execute a scene
 *   OSHAL_CONNECTION_LABEL="lake house" node scripts/oshal-smartthings.js  # pick an account
 *
 * Exit 2 = no SmartThings connection (or ambiguous — connect at /utilities / name a label).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const { decryptToken } = require('./lib/connector-token-crypto');

const API = 'https://api.smartthings.com/v1';

// ── Bot-owned per-user store (ADR-036) ──────────────────────────────────────
// Durable, user_sub-keyed JSON the home-bot OWNS and the surface reads cheaply.
// Lives in the shared `home-data` volume (home-bot :rw, api :ro) — NOT the
// ephemeral per-request workspace (that belongs to the fast-loop costing path).
const HOME_DATA_DIR = process.env.OSHAL_HOME_DATA_DIR || '/app/home-data';
/** Canonical, stable key for a device — the dedupe + cross-hub join key. */
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function storePath(sub, file) { return path.join(HOME_DATA_DIR, sub, file); }
/** Read a store file (returns {} when absent — the store is created lazily). */
function readStore(sub, file) {
  try { return JSON.parse(fs.readFileSync(storePath(sub, file), 'utf8')); } catch { return {}; }
}
/** Write a store file (creates the user's dir on first write). */
function writeStore(sub, file, obj) {
  fs.mkdirSync(path.join(HOME_DATA_DIR, sub), { recursive: true });
  fs.writeFileSync(storePath(sub, file), JSON.stringify(obj, null, 2));
}

/** The codex sandbox may not forward OSHAL_USER_SUB to shelled commands, so the
 *  wrapper also drops it as a cwd-relative file. Read whichever is present. */
function resolveUserSub() {
  return resolveExactUserSubject();
}

function truthyEnv(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || ''));
}

function stripConfirmArgs(argv) {
  return argv.filter((arg) => arg !== '--confirm' && arg !== '--yes');
}

function isDeviceWrite(argv) {
  return ['control', 'scene', 'scene-run'].includes(String(argv[0] || ''));
}

function hasDeviceWriteConfirmation(argv) {
  return truthyEnv('OSHAL_DEVICE_WRITE_CONFIRM')
    || truthyEnv('OSHAL_ALLOW_DEVICE_WRITE')
    || argv.includes('--confirm')
    || argv.includes('--yes');
}

function assertDeviceWriteConfirmed(argv) {
  if (!isDeviceWrite(argv) || hasDeviceWriteConfirmation(argv)) return;
  throw new Error('no-device-write: SmartThings device writes require OSHAL_DEVICE_WRITE_CONFIRM=true or --confirm. No device command was sent.');
}

/** Token broker: a short-lived token the controller decrypted for THIS user and dropped
 *  into the workspace. Prefer it so we never touch SESSION_SECRET / the DB. */
function resolveProvidedToken() {
  try {
    const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-smartthings'), 'utf8').trim();
    if (t) return t;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_SMARTTHINGS || undefined;
}

/** The connection the bot/user named: a label ("lake house"), an account email, or a
 *  connection id. The home-bot tools set these from the user's request. */
function resolveSelector() {
  return {
    label: process.env.OSHAL_CONNECTION_LABEL || undefined,
    email: process.env.OSHAL_CONNECTION_EMAIL || undefined,
    connectionId: process.env.OSHAL_CONNECTION_ID || undefined,
  };
}

/** WHERE clause + params for the caller's accessible SmartThings connections
 *  (personal ∪ shared/household). $1 = userSub. */
function accessibleWhere(userSub) {
  return {
    where: `provider='smartthings' AND ((user_sub=$1 AND tenant_id IS NULL)
              OR tenant_id IN (SELECT tenant_id FROM oshal_tenant_memberships WHERE user_sub=$1))`,
    params: [userSub],
  };
}

/** List the caller's labeled SmartThings connections (the catalog the bot selects from). */
async function listAccounts(pool) {
  const userSub = resolveUserSub();
  if (!userSub) {
    const all = (await pool.query(`SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE provider='smartthings' ORDER BY updated_at DESC`)).rows;
    return { accounts: all };
  }
  const { where, params } = accessibleWhere(userSub);
  const rows = (await pool.query(`SELECT label, account_email, tenant_id, is_default FROM oshal_connections WHERE ${where} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  return { accounts: rows };
}

/** Resolve the SmartThings PAT from the DB for the signed-in user, honoring a selector
 *  (label/email/connectionId) across personal ∪ shared connections (PAT has no refresh). */
async function tokenFromDb(pool, sel) {
  const userSub = resolveUserSub();
  sel = sel || {};
  const named = !!(sel.label || sel.email || sel.connectionId);
  if (!userSub) {
    // No identity: auto-pick only when exactly one connection exists (single-operator).
    const all = (await pool.query(`SELECT user_sub, access_token, label FROM oshal_connections WHERE provider='smartthings' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1 && !named) { console.error(`Refusing to guess: ${all.length} SmartThings connections exist. Set OSHAL_USER_SUB or a connection label.`); process.exit(2); }
    if (!all[0]) { console.error('No SmartThings connection found. Connect at /utilities first.'); process.exit(2); }
    return decryptToken(pool, all[0].user_sub, all[0].access_token);
  }
  const { where, params } = accessibleWhere(userSub);
  let sql = where;
  if (sel.connectionId) { params.push(sel.connectionId); sql += ` AND connection_id=$${params.length}`; }
  else if (sel.label) { params.push(sel.label); sql += ` AND lower(label)=lower($${params.length})`; }
  else if (sel.email) { params.push(sel.email); sql += ` AND lower(account_email)=lower($${params.length})`; }
  const rows = (await pool.query(`SELECT user_sub, access_token, label, account_email FROM oshal_connections WHERE ${sql} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  if (!rows.length) {
    console.error(named ? `No SmartThings connection matches that account for user ${userSub}.`
      : `No SmartThings connection for user ${userSub}. Connect at /utilities first.`);
    process.exit(2);
  }
  // Bare request among the USER'S OWN accounts → always fall back to a default (the
  // is_default one, else the most-recent). Never errors on "multiple" — the bot may still
  // call `accounts` and ask, but the system always has a working default (backwards-compatible
  // with the single-account era). Rows are already ordered is_default DESC, updated_at DESC.
  return decryptToken(pool, rows[0].user_sub, rows[0].access_token);
}

/** Authorized SmartThings API call → parsed JSON (throws on non-2xx with a short body). */
async function st(token, method, urlPath, body) {
  const r = await fetch(`${API}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`SmartThings ${method} ${urlPath} → ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

async function listDevices(token) {
  const j = await st(token, 'GET', '/devices');
  return (j.items || []).map((d) => ({
    deviceId: d.deviceId,
    label: d.label || d.name || '(unnamed)',
    room: d.roomId || null,
    capabilities: (d.components || []).flatMap((c) => (c.capabilities || []).map((cap) => cap.id)),
  }));
}

/** Read the on/off (switch) state of a device, if it has the switch capability. */
async function switchState(token, deviceId) {
  try {
    const s = await st(token, 'GET', `/devices/${deviceId}/components/main/capabilities/switch/status`);
    return s.switch?.value ?? null;
  } catch { return null; }
}

async function listScenes(token) {
  const j = await st(token, 'GET', '/scenes');
  return (j.items || []).map((s) => ({ sceneId: s.sceneId, name: s.sceneName || s.name || '(unnamed)' }));
}

/** Send a capability command to a device (default: switch on/off). */
async function command(token, deviceId, capability, cmd, arg) {
  const c = { component: 'main', capability, command: cmd };
  if (arg !== undefined) c.arguments = [isNaN(Number(arg)) ? arg : Number(arg)];
  return st(token, 'POST', `/devices/${deviceId}/commands`, { commands: [c] });
}

/**
 * Build (and persist) the bot's unified device index: every device across the
 * connected hub(s), DEDUPED by canonical name, merged with any prior user
 * overrides (e.g. a renamed device), written to the per-user store. This is the
 * cheap read-model the surface renders without an LLM call.
 */
async function buildIndex(token) {
  const sub = resolveUserSub() || '_default';
  const raw = await listDevices(token);
  await Promise.all(raw.map(async (d) => {
    if (d.capabilities.includes('switch')) d.switch = await switchState(token, d.deviceId);
  }));
  // Preserve user decisions (renames, etc.) from the existing index across rebuilds.
  const prior = readStore(sub, 'devices.json');
  const priorByKey = new Map((prior.devices || []).map((e) => [e.key, e]));
  const byKey = new Map();
  for (const d of raw) {
    const key = slug(d.label);
    const src = { hub: 'smartthings', deviceId: d.deviceId, label: d.label };
    const existing = byKey.get(key);
    if (existing) {
      // Same canonical name from another hub/entry → join into one device, union caps.
      existing.sources.push(src);
      existing.capabilities = Array.from(new Set([...existing.capabilities, ...d.capabilities]));
      if (existing.switch == null && d.switch != null) existing.switch = d.switch;
    } else {
      const p = priorByKey.get(key);
      byKey.set(key, {
        key,
        name: d.label,
        userName: p ? (p.userName || null) : null, // user's rename, remembered across rebuilds
        room: d.room,
        capabilities: d.capabilities,
        switch: d.switch ?? null,
        sources: [src],
      });
    }
  }
  const devices = Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  const index = {
    generatedAt: new Date().toISOString(),
    userSub: sub,
    hubs: ['smartthings'],
    deviceCount: devices.length,
    devices,
  };
  writeStore(sub, 'devices.json', index);
  return index;
}

// ── Bot-owned scenes (ADR-036) ──────────────────────────────────────────────
// SmartThings' API can list/execute vendor scenes but CANNOT create them. So the
// bot owns its OWN scenes: a named list of steps in scenes.json, replayed via the
// device-control commands. Steps reference devices by canonical `key` (from the
// index), so a scene is hub-agnostic and survives device-id churn.

/** Resolve a step's device reference (canonical key, preferred — or a raw deviceId). */
function resolveDeviceId(sub, ref) {
  const idx = readStore(sub, 'devices.json');
  const entry = (idx.devices || []).find((d) => d.key === ref);
  if (entry) { const s = (entry.sources || []).find((x) => x.hub === 'smartthings') || entry.sources[0]; return s && s.deviceId; }
  return ref; // already a deviceId (or unknown — let SmartThings reject it)
}

/** Persist (create/replace) a bot-owned scene. steps = [{device,cmd:'on'|'off'|'set',capability?,command?,arg?}]. */
function saveScene(sub, name, stepsJson) {
  let steps; try { steps = JSON.parse(stepsJson); } catch { throw new Error('steps must be JSON, e.g. [{"device":"<key>","cmd":"on"}]'); }
  if (!Array.isArray(steps) || !steps.length) throw new Error('a scene needs at least one step');
  const store = readStore(sub, 'scenes.json'); store.scenes = store.scenes || [];
  const key = slug(name); const now = new Date().toISOString();
  const i = store.scenes.findIndex((s) => s.key === key);
  const prior = i >= 0 ? store.scenes[i] : null;
  const scene = { name, key, steps, trigger: prior ? (prior.trigger ?? null) : null, createdAt: prior ? prior.createdAt : now, updatedAt: now };
  if (i >= 0) store.scenes[i] = scene; else store.scenes.push(scene);
  store.updatedAt = now; writeStore(sub, 'scenes.json', store);
  return { saved: name, key, steps: steps.length };
}

/** Find a bot-owned scene by name or key (case-insensitive). */
function findScene(sub, name) {
  const store = readStore(sub, 'scenes.json');
  const want = slug(name);
  return (store.scenes || []).find((s) => s.key === want || String(s.name).toLowerCase() === String(name).toLowerCase());
}

/** Run a bot-owned scene: replay each step as a device-control command. */
async function runScene(token, sub, name) {
  const scene = findScene(sub, name);
  if (!scene) { const all = (readStore(sub, 'scenes.json').scenes || []).map((s) => s.name).join(', '); throw new Error(`no scene "${name}". Saved: ${all || '(none)'}`); }
  const results = [];
  for (const step of scene.steps) {
    const deviceId = resolveDeviceId(sub, step.device);
    if (step.cmd === 'on' || step.cmd === 'off') { await command(token, deviceId, 'switch', step.cmd); results.push({ device: step.device, did: step.cmd }); }
    else if (step.cmd === 'set') { await command(token, deviceId, step.capability || 'switchLevel', step.command || 'setLevel', step.arg); results.push({ device: step.device, did: `set ${step.capability || 'switchLevel'}=${step.arg}` }); }
    else throw new Error(`unknown step cmd "${step.cmd}" (use on|off|set)`);
  }
  return { ran: scene.name, steps: results };
}

/** Delete a bot-owned scene. */
function deleteScene(sub, name) {
  const store = readStore(sub, 'scenes.json'); const before = (store.scenes || []).length;
  store.scenes = (store.scenes || []).filter((s) => s.key !== slug(name) && String(s.name).toLowerCase() !== String(name).toLowerCase());
  store.updatedAt = new Date().toISOString(); writeStore(sub, 'scenes.json', store);
  return { deleted: before - store.scenes.length, name };
}

/** Default digest: every device with its on/off state + the available scenes. */
async function digest(token) {
  const devices = await listDevices(token);
  await Promise.all(devices.map(async (d) => {
    if (d.capabilities.includes('switch')) d.switch = await switchState(token, d.deviceId);
  }));
  const scenes = await listScenes(token).catch(() => []);
  return { generatedAt: new Date().toISOString(), deviceCount: devices.length, devices, scenes };
}

/** Route a parsed argv to the right SmartThings action; returns a JSON-able result. */
async function run(token, argv) {
  const [verb, a, b, c, d] = argv;
  const sub = resolveUserSub() || '_default';
  if (!verb || verb === 'digest') return digest(token);
  if (verb === 'index') return buildIndex(token); // refresh the bot's persisted device index
  if (verb === 'devices') return { devices: await listDevices(token) };
  // Bot-owned scenes (stored in scenes.json; replayed via control commands).
  if (verb === 'myscenes') return { scenes: readStore(sub, 'scenes.json').scenes || [] };
  if (verb === 'scene-save') { if (!a || !b) throw new Error('usage: scene-save <name> <stepsJson>'); return saveScene(sub, a, b); }
  if (verb === 'scene-run') { if (!a) throw new Error('usage: scene-run <name>'); return runScene(token, sub, a); }
  if (verb === 'scene-del') { if (!a) throw new Error('usage: scene-del <name>'); return deleteScene(sub, a); }
  if (verb === 'status') return st(token, 'GET', `/devices/${a}/status`);
  if (verb === 'scenes') return { scenes: await listScenes(token) };
  if (verb === 'scene') return st(token, 'POST', `/scenes/${a}/execute`);
  if (verb === 'control') {
    if (a && (b === 'on' || b === 'off')) return command(token, a, 'switch', b);
    if (a && b === 'set' && c) return command(token, a, c, d ?? c, argv[5]); // set <capability> <command> [arg]
    throw new Error('usage: control <deviceId> on|off | control <deviceId> set <capability> <command> [arg]');
  }
  throw new Error(`unknown command: ${verb}`);
}

(async () => {
  const rawArgv = process.argv.slice(2);
  assertDeviceWriteConfirmed(rawArgv);
  const argv = stripConfirmArgs(rawArgv);
  const sel = resolveSelector();
  const named = !!(sel.label || sel.email || sel.connectionId);

  // `accounts` lists the caller's labeled connections (catalog) — DB metadata, no token.
  if (argv[0] === 'accounts') {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try { console.log(JSON.stringify(await listAccounts(pool), null, 2)); }
    catch (err) { console.error('oshal-smartthings failed: ' + (err && err.message || err)); process.exit(1); }
    finally { await pool.end(); }
    return;
  }

  // Store-only verbs read/write the bot's own store — no SmartThings token needed.
  // (scene-run + index DO call SmartThings, so they fall through to token resolution.)
  if (['myscenes', 'scene-save', 'scene-del'].includes(argv[0])) {
    try { console.log(JSON.stringify(await run(null, argv), null, 2)); }
    catch (err) { console.error('oshal-smartthings failed: ' + (err && err.message || err)); process.exit(1); }
    return;
  }

  // Fast path: no specific account named → use the brokered single token if present.
  const provided = named ? undefined : resolveProvidedToken();
  if (provided) {
    try { console.log(JSON.stringify(await run(provided, argv), null, 2)); }
    catch (err) { console.error('oshal-smartthings failed: ' + (err && err.message || err)); process.exit(1); }
    return;
  }
  // Otherwise resolve the selected connection's token from the DB.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const token = await tokenFromDb(pool, sel);
    console.log(JSON.stringify(await run(token, argv), null, 2));
  } catch (err) {
    console.error('oshal-smartthings failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
