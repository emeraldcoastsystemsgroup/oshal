#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | PRIVATE GCP cost + health diagnostics CLI for cloud-ops-bot. 20 read-only check verbs over the Cloud REST APIs (no gcloud), authed by the per-user GCP connector token (brokered .oshal-cred-gcp / OSHAL_CRED_GCP, DB-decrypt fallback) — identical token plumbing to scripts/oshal-gcp.js. This is a PRIVATE tool (bot-internal, invoked via bash, NOT registered in gcpToolKit.js / cloud.yaml — by design). Each check returns structured JSON {check, findings[], ...}; `summary` aggregates a curated set into health (0-100) + monthly $ savings scores. Every API call is defensive (apiSafe) so a disabled API / missing permission on one check degrades to a finding instead of crashing the diagnostic.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *
 *   node scripts/oshal-gcp-diag.js summary [projectId]      # health score + cost savings rollup
 *   node scripts/oshal-gcp-diag.js list                     # all 20 checks
 *   node scripts/oshal-gcp-diag.js idle-vms [projectId]     # one check
 *   OSHAL_CONNECTION_LABEL="work gcp" node scripts/oshal-gcp-diag.js summary
 *
 * Exit 2 = no GCP connection (connect at /utilities) or ambiguous account; 3 = token refresh failed.
 * Read-only — needs the GCP connector's cloud-platform(.read-only) scope. Recommender checks
 * require the Recommender API enabled on the project (a disabled API surfaces as a finding).
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const SU = 'https://serviceusage.googleapis.com/v1';
const GCE = 'https://compute.googleapis.com/compute/v1';
const BILL = 'https://cloudbilling.googleapis.com/v1';
const IAM = 'https://iam.googleapis.com/v1';
const REC = 'https://recommender.googleapis.com/v1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';
const SQL = 'https://sqladmin.googleapis.com/v1';

// ── identity + token plumbing (mirrors scripts/oshal-gcp.js) ──────────────────
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return (fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined); } catch { return undefined; }
}
function resolveSelector() {
  return { label: process.env.OSHAL_CONNECTION_LABEL || undefined, email: process.env.OSHAL_CONNECTION_EMAIL || undefined, connectionId: process.env.OSHAL_CONNECTION_ID || undefined };
}
function resolveProvidedToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-gcp'), 'utf8').trim(); if (t) return t; } catch { /* env next */ }
  return process.env.OSHAL_CRED_GCP || undefined;
}
function hkey() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', hkey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', hkey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function accessibleWhere() {
  return `provider='gcp' AND ((user_sub=$1 AND tenant_id IS NULL)
            OR tenant_id IN (SELECT tenant_id FROM oshal_tenant_memberships WHERE user_sub=$1))`;
}
async function tokenFromDb(pool, sel) {
  const userSub = resolveUserSub();
  sel = sel || {};
  const named = !!(sel.label || sel.email || sel.connectionId);
  let rows;
  if (userSub) {
    const params = [userSub];
    let sql = accessibleWhere();
    if (sel.connectionId) { params.push(sel.connectionId); sql += ` AND connection_id=$${params.length}`; }
    else if (sel.label) { params.push(sel.label); sql += ` AND lower(label)=lower($${params.length})`; }
    else if (sel.email) { params.push(sel.email); sql += ` AND lower(account_email)=lower($${params.length})`; }
    rows = (await pool.query(`SELECT connection_id, access_token, refresh_token, expiry FROM oshal_connections WHERE ${sql} ORDER BY is_default DESC, updated_at DESC`, params)).rows;
  } else {
    rows = (await pool.query(`SELECT connection_id, access_token, refresh_token, expiry FROM oshal_connections WHERE provider='gcp' ORDER BY updated_at DESC`)).rows;
    if (rows.length > 1 && !named) { console.error(`Refusing to guess: ${rows.length} GCP connections. Set OSHAL_USER_SUB or a label.`); process.exit(2); }
  }
  if (!rows || !rows.length) { console.error(named ? 'No GCP connection matches that account.' : 'No GCP connection. Connect Google Cloud at /utilities first.'); process.exit(2); }
  const row = rows[0];
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60_000) return decrypt(row.access_token);
  if (!row.refresh_token) return row.access_token ? decrypt(row.access_token) : (console.error('GCP token expired and no refresh token; reconnect at /utilities.'), process.exit(2));
  const body = new URLSearchParams({ client_id: process.env.GCP_CLIENT_ID || '', client_secret: process.env.GCP_CLIENT_SECRET || '', refresh_token: decrypt(row.refresh_token), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { console.error('GCP token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160)); process.exit(3); }
  const tok = await r.json();
  await pool.query('UPDATE oshal_connections SET access_token=$2, expiry=$3, updated_at=NOW() WHERE connection_id=$1', [row.connection_id, encrypt(tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]);
  return tok.access_token;
}

// ── API helpers (defensive: never throw out of a check) ───────────────────────
async function api(token, url, opts) {
  const r = await fetch(url, { method: (opts && opts.method) || 'GET', headers: { Authorization: `Bearer ${token}`, ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts && opts.body });
  if (!r.ok) throw new Error(`GCP ${r.status} ${url.replace(/^https:\/\//, '').split('?')[0]}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
/** Collected, deduped read-blocker warnings (e.g. a disabled API) surfaced in output so a
 *  diagnostic never reports a false "all clear" when it actually couldn't read the account. */
const _warnings = new Map();
function warn(key, msg) { _warnings.set(key, msg); }
/** Reset module-level memo/warning state between test cases. */
function _resetForTest() { _projCache = undefined; _warnings.clear(); }
async function apiSafe(token, url, opts) {
  try { return { ok: true, data: await api(token, url, opts) }; }
  catch (e) {
    const msg = (e && e.message) || String(e);
    const host = (msg.match(/GCP \d+ ([a-z][\w.-]*\.googleapis\.com)/) || [])[1];
    const proj = (msg.match(/in project (\d+)/) || [])[1];
    if (/has not been used in project|it is disabled|SERVICE_DISABLED/.test(msg) && host) {
      warn(host, `Enable the ${host} API${proj ? ` on project ${proj}` : ''} (your OAuth client's project), then retry — https://console.cloud.google.com/apis/library/${host}${proj ? `?project=${proj}` : ''}`);
    } else if (/PERMISSION_DENIED|\b403\b/.test(msg)) {
      warn('perm:' + (host || 'gcp'), `Permission denied on ${host || 'a GCP API'} — the connector token may need the full cloud-platform scope (reconnect with write scope at /utilities).`);
    }
    return { ok: false, error: msg };
  }
}
/** Dollar value of a Cloud Billing/Recommender money object {units,nanos}. */
function dollars(money) { return money ? Number(money.units || 0) + Number(money.nanos || 0) / 1e9 : 0; }
function round2(n) { return Math.round(n * 100) / 100; }

/** Active, accessible projects (ids only) — the iteration set for cross-project checks.
 *  Memoized so the ~15 summary checks don't each re-hit (and re-warn on) projects.list. */
let _projCache;
async function activeProjects(token, only) {
  if (only) return [only];
  if (_projCache) return _projCache;
  const j = await apiSafe(token, `${CRM}/projects`);
  if (!j.ok) { if (!_warnings.size) warn('list-projects', 'Could not list your GCP projects: ' + j.error.slice(0, 140)); _projCache = []; return []; }
  _projCache = (j.data.projects || []).filter((p) => p.lifecycleState === 'ACTIVE').map((p) => p.projectId);
  return _projCache;
}
/** Zones/regions that actually hold a resource (keeps recommender calls bounded). */
function locationsFromAggregated(items, kind, scope) {
  const out = new Set();
  for (const [k, v] of Object.entries(items || {})) if ((v[kind] || []).length) out.add(k.replace(new RegExp(`^${scope}/`), ''));
  return [...out];
}
/** Query one recommender across locations; return ACTIVE recommendations with $ savings. */
async function recommend(token, project, recommenderId, locations) {
  const found = [];
  for (const loc of locations) {
    const j = await apiSafe(token, `${REC}/projects/${project}/locations/${loc}/recommenders/${recommenderId}/recommendations`);
    if (!j.ok) continue; // disabled Recommender API / no permission in this location → skip (persona tells the bot to suggest enabling it)
    for (const r of j.data.recommendations || []) {
      if (r.stateInfo && r.stateInfo.state && r.stateInfo.state !== 'ACTIVE') continue;
      const cost = r.primaryImpact && r.primaryImpact.costProjection && r.primaryImpact.costProjection.cost;
      found.push({ location: loc, description: r.description, subtype: r.recommenderSubtype, priority: r.priority, monthlySavings: round2(Math.abs(dollars(cost))) });
    }
  }
  return found;
}

// ── HEALTH checks (1-12) ──────────────────────────────────────────────────────
async function inventory(token, p) {
  const out = [];
  for (const id of await activeProjects(token, p)) {
    const [vm, dk, bk, sq] = await Promise.all([
      apiSafe(token, `${GCE}/projects/${id}/aggregated/instances`), apiSafe(token, `${GCE}/projects/${id}/aggregated/disks`),
      apiSafe(token, `${STORAGE}/b?project=${id}`), apiSafe(token, `${SQL}/projects/${id}/instances`)]);
    const count = (res, kind, scope) => res.ok ? Object.values(res.data.items || {}).reduce((n, z) => n + (z[kind] || []).length, 0) : 0;
    out.push({ projectId: id, instances: count(vm, 'instances'), disks: count(dk, 'disks'), buckets: bk.ok ? (bk.data.items || []).length : 0, sqlInstances: sq.ok ? (sq.data.items || []).length : 0 });
  }
  return { check: 'inventory', projects: out };
}
async function vmStatus(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}/aggregated/instances`);
    if (!j.ok) continue;
    for (const z of Object.values(j.data.items || {})) for (const i of z.instances || [])
      if (i.status === 'TERMINATED') findings.push({ projectId: id, severity: 'low', resource: i.name, zone: String(i.zone).split('/').pop(), note: 'VM stopped but its boot/attached disks still bill' });
  }
  return { check: 'vm-status', findings };
}
async function disksUnattached(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}/aggregated/disks`);
    if (!j.ok) continue;
    for (const z of Object.values(j.data.items || {})) for (const d of z.disks || [])
      if (!(d.users || []).length) findings.push({ projectId: id, severity: 'medium', resource: d.name, sizeGb: Number(d.sizeGb || 0), zone: String(d.zone).split('/').pop(), note: 'Unattached persistent disk — paying for idle storage' });
  }
  return { check: 'disks-unattached', findings };
}
async function ipsIdle(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}/aggregated/addresses`);
    if (!j.ok) continue;
    for (const r of Object.values(j.data.items || {})) for (const a of r.addresses || [])
      if (a.status === 'RESERVED' && !(a.users || []).length) findings.push({ projectId: id, severity: 'medium', resource: a.name, address: a.address, region: String(a.region || 'global').split('/').pop(), note: 'Reserved static IP not in use — billed hourly' });
  }
  return { check: 'ips-idle', findings };
}
async function firewallOpen(token, p) {
  const findings = [];
  const risky = ['22', '3389', '0-65535'];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}/global/firewalls`);
    if (!j.ok) continue;
    for (const fw of j.data.items || []) {
      const open = (fw.sourceRanges || []).includes('0.0.0.0/0');
      const ports = (fw.allowed || []).flatMap((a) => a.ports || (a.IPProtocol === 'all' ? ['0-65535'] : []));
      if (open && fw.direction !== 'EGRESS' && (ports.some((pt) => risky.includes(pt)) || (fw.allowed || []).some((a) => a.IPProtocol === 'all')))
        findings.push({ projectId: id, severity: 'high', resource: fw.name, note: `Firewall allows 0.0.0.0/0 → ${ports.join(',') || 'all'} (SSH/RDP/all exposed to the internet)` });
    }
  }
  return { check: 'firewall-open', findings };
}
async function iamOwners(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${CRM}/projects/${id}:getIamPolicy`, { method: 'POST', body: '{}' });
    if (!j.ok) continue;
    const owners = (j.data.bindings || []).filter((b) => b.role === 'roles/owner').flatMap((b) => b.members || []);
    if (owners.length > 3) findings.push({ projectId: id, severity: 'medium', count: owners.length, note: `${owners.length} project Owners — broad blast radius; prefer least-privilege roles` });
    const ext = owners.filter((m) => /^user:/.test(m) && !/emeraldcoastsystemsgroup\.com|gmail\.com$/.test(m));
    if (ext.length) findings.push({ projectId: id, severity: 'high', members: ext, note: 'External-domain project Owner(s)' });
  }
  return { check: 'iam-owners', findings };
}
async function serviceAccountKeys(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${IAM}/projects/${id}/serviceAccounts`);
    if (!j.ok) continue;
    for (const sa of j.data.accounts || []) {
      const k = await apiSafe(token, `${IAM}/projects/${id}/serviceAccounts/${sa.uniqueId}/keys?keyTypes=USER_MANAGED`);
      const userKeys = (k.ok && (k.data.keys || []).length) || 0;
      if (userKeys) findings.push({ projectId: id, severity: 'medium', resource: sa.email, userManagedKeys: userKeys, note: 'User-managed SA keys never expire — rotate or move to workload identity' });
    }
  }
  return { check: 'service-account-keys', findings };
}
async function bucketsPublic(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${STORAGE}/b?project=${id}`);
    if (!j.ok) continue;
    for (const b of j.data.items || []) {
      const pol = await apiSafe(token, `${STORAGE}/b/${b.name}/iam`);
      const pub = pol.ok && (pol.data.bindings || []).some((bd) => (bd.members || []).some((m) => m === 'allUsers' || m === 'allAuthenticatedUsers'));
      if (pub) findings.push({ projectId: id, severity: 'high', resource: b.name, note: 'Bucket grants allUsers/allAuthenticatedUsers — publicly readable' });
    }
  }
  return { check: 'buckets-public', findings };
}
async function sqlHealth(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${SQL}/projects/${id}/instances`);
    if (!j.ok) continue;
    for (const i of j.data.items || []) {
      const ha = i.settings && i.settings.availabilityType === 'REGIONAL';
      const backups = i.settings && i.settings.backupConfiguration && i.settings.backupConfiguration.enabled;
      if (!backups) findings.push({ projectId: id, severity: 'high', resource: i.name, note: 'Cloud SQL automated backups DISABLED' });
      if (!ha) findings.push({ projectId: id, severity: 'low', resource: i.name, note: 'Cloud SQL is zonal (no HA failover)' });
    }
  }
  return { check: 'sql-health', findings };
}
async function snapshotsOld(token, p, days) {
  const cut = Date.now() - (days || 180) * 864e5;
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}/global/snapshots`);
    if (!j.ok) continue;
    for (const s of j.data.items || []) if (new Date(s.creationTimestamp).getTime() < cut)
      findings.push({ projectId: id, severity: 'low', resource: s.name, ageDays: Math.floor((Date.now() - new Date(s.creationTimestamp).getTime()) / 864e5), storageGb: Number(s.storageBytes || 0) / 1e9, note: 'Snapshot older than retention window — stale storage cost' });
  }
  return { check: 'snapshots-old', findings };
}
async function quotaPressure(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${GCE}/projects/${id}`);
    if (!j.ok) continue;
    for (const q of (j.data.quotas || [])) if (q.limit > 0 && q.usage / q.limit >= 0.8)
      findings.push({ projectId: id, severity: q.usage / q.limit >= 0.95 ? 'high' : 'medium', metric: q.metric, usage: q.usage, limit: q.limit, pct: Math.round((q.usage / q.limit) * 100), note: 'Quota near limit — request an increase before it blocks deploys' });
  }
  return { check: 'quota-pressure', findings };
}
async function apisSurface(token, p) {
  const broad = ['cloudfunctions', 'run', 'container', 'compute', 'sqladmin', 'aiplatform'];
  const out = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${SU}/projects/${id}/services?filter=state:ENABLED&pageSize=200`);
    if (!j.ok) continue;
    const names = (j.data.services || []).map((s) => (s.config && s.config.name) || s.name);
    out.push({ projectId: id, enabledCount: names.length, costBearing: names.filter((n) => broad.some((b) => n.startsWith(b))) });
  }
  return { check: 'apis-surface', projects: out };
}

// ── COST checks (13-20, Recommender-driven) ───────────────────────────────────
async function zonesWith(token, id, kind) {
  const j = await apiSafe(token, `${GCE}/projects/${id}/aggregated/${kind}`);
  return j.ok ? locationsFromAggregated(j.data.items, kind, 'zones') : [];
}
async function regionsWith(token, id, kind) {
  const j = await apiSafe(token, `${GCE}/projects/${id}/aggregated/${kind}`);
  return j.ok ? locationsFromAggregated(j.data.items, kind, 'regions') : [];
}
async function recCheck(name, token, p, recId, locs) {
  const findings = [];
  let total = 0;
  for (const id of await activeProjects(token, p)) {
    const locations = typeof locs === 'function' ? await locs(token, id) : locs;
    for (const f of await recommend(token, id, recId, locations)) { findings.push({ projectId: id, ...f }); total += f.monthlySavings; }
  }
  return { check: name, monthlySavingsUsd: round2(total), findings };
}
const idleVms = (t, p) => recCheck('idle-vms', t, p, 'google.compute.instance.IdleResourceRecommender', (tk, id) => zonesWith(tk, id, 'instances'));
const vmRightsizing = (t, p) => recCheck('vm-rightsizing', t, p, 'google.compute.instance.MachineTypeRecommender', (tk, id) => zonesWith(tk, id, 'instances'));
const idleDisks = (t, p) => recCheck('idle-disks', t, p, 'google.compute.disk.IdleResourceRecommender', (tk, id) => zonesWith(tk, id, 'disks'));
const idleIps = (t, p) => recCheck('idle-ips', t, p, 'google.compute.address.IdleResourceRecommender', (tk, id) => regionsWith(tk, id, 'addresses'));
const cudRecommend = (t, p) => recCheck('cud-recommendations', t, p, 'google.compute.commitment.UsageCommitmentRecommender', (tk, id) => regionsWith(tk, id, 'instances'));
const unattendedProjects = (t, p) => recCheck('unattended-projects', t, p, 'google.resourcemanager.projectUtilization.Recommender', ['global']);

async function billingLinked(token, p) {
  const findings = [];
  for (const id of await activeProjects(token, p)) {
    const j = await apiSafe(token, `${BILL}/projects/${id}/billingInfo`);
    if (!j.ok) continue;
    if (!j.data.billingEnabled) findings.push({ projectId: id, severity: 'high', note: 'Project has NO active billing account — APIs will fail/are disabled' });
  }
  return { check: 'billing-linked', findings };
}
async function costRecommendations(token, p) {
  const parts = await Promise.all([idleVms(token, p), idleDisks(token, p), idleIps(token, p), vmRightsizing(token, p), cudRecommend(token, p), unattendedProjects(token, p)]);
  const findings = parts.flatMap((r) => (r.findings || []).map((f) => ({ source: r.check, ...f })));
  const monthlySavingsUsd = round2(parts.reduce((n, r) => n + (r.monthlySavingsUsd || 0), 0));
  return { check: 'cost-recommendations', monthlySavingsUsd, count: findings.length, findings };
}

// ── registry + summary ────────────────────────────────────────────────────────
const CHECKS = {
  inventory, 'vm-status': vmStatus, 'disks-unattached': disksUnattached, 'ips-idle': ipsIdle,
  'firewall-open': firewallOpen, 'iam-owners': iamOwners, 'service-account-keys': serviceAccountKeys,
  'buckets-public': bucketsPublic, 'sql-health': sqlHealth, 'snapshots-old': (t, p) => snapshotsOld(t, p),
  'quota-pressure': quotaPressure, 'apis-surface': apisSurface,
  'cost-recommendations': costRecommendations, 'idle-vms': idleVms, 'vm-rightsizing': vmRightsizing,
  'idle-disks': idleDisks, 'idle-ips': idleIps, 'cud-recommendations': cudRecommend,
  'billing-linked': billingLinked, 'unattended-projects': unattendedProjects,
};
const SEV_WEIGHT = { high: 12, medium: 5, low: 2 };

/** Curated cost+health rollup → a health score (0-100) and total monthly savings. */
async function summary(token, p) {
  const health = ['billing-linked', 'firewall-open', 'buckets-public', 'iam-owners', 'sql-health', 'disks-unattached', 'ips-idle', 'quota-pressure', 'service-account-keys'];
  const results = await Promise.all(health.map((c) => CHECKS[c](token, p)));
  const cost = await costRecommendations(token, p);
  let score = 100;
  const top = [];
  for (const r of results) for (const f of r.findings || []) { score -= SEV_WEIGHT[f.severity] || 3; top.push({ check: r.check, severity: f.severity, projectId: f.projectId, note: f.note, resource: f.resource }); }
  top.sort((a, b) => (SEV_WEIGHT[b.severity] || 0) - (SEV_WEIGHT[a.severity] || 0));
  const projects = await activeProjects(token, p);
  const unreadable = projects.length === 0 && _warnings.size > 0;
  return {
    check: 'summary', generatedAt: new Date().toISOString(),
    status: unreadable ? 'incomplete — could not read your GCP account (see warnings)' : 'ok',
    projectsScanned: projects.length,
    healthScore: unreadable ? null : Math.max(0, score), healthFindings: top.length,
    costMonthlySavingsUsd: cost.monthlySavingsUsd, costOpportunities: cost.count,
    warnings: [..._warnings.values()],
    topFindings: top.slice(0, 15), costRecommendations: cost.findings.slice(0, 15),
  };
}

async function dispatch(token, argv) {
  const verb = argv[0] || 'summary';
  const projectId = argv[1] || process.env.OSHAL_GCP_PROJECT || undefined;
  if (verb === 'list' || verb === 'checks') return { checks: ['summary', ...Object.keys(CHECKS)] };
  if (verb === 'summary' || verb === 'score') return summary(token, projectId);
  if (!CHECKS[verb]) throw new Error(`unknown check: ${verb}. Try: list`);
  const out = await CHECKS[verb](token, projectId);
  // Surface read-blockers (disabled API / permission) on single checks too — never a silent empty.
  if (_warnings.size && out && typeof out === 'object' && !Array.isArray(out)) out.warnings = [..._warnings.values()];
  return out;
}

module.exports = {
  CHECKS, dispatch, summary, activeProjects, _resetForTest,
  inventory, vmStatus, disksUnattached, ipsIdle, firewallOpen, iamOwners, serviceAccountKeys,
  bucketsPublic, sqlHealth, snapshotsOld, quotaPressure, apisSurface,
  costRecommendations, idleVms, vmRightsizing, idleDisks, idleIps, cudRecommend, billingLinked, unattendedProjects,
};

if (require.main === module) (async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === 'list' || argv[0] === 'checks') { console.log(JSON.stringify({ checks: ['summary', ...Object.keys(CHECKS)] }, null, 2)); return; }
  const sel = resolveSelector();
  const named = !!(sel.label || sel.email || sel.connectionId);
  const provided = named ? undefined : resolveProvidedToken();
  if (provided) {
    try { console.log(JSON.stringify(await dispatch(provided, argv), null, 2)); }
    catch (err) { console.error('oshal-gcp-diag failed: ' + ((err && err.message) || err)); process.exit(1); }
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const token = await tokenFromDb(pool, sel);
    console.log(JSON.stringify(await dispatch(token, argv), null, 2));
  } catch (err) {
    console.error('oshal-gcp-diag failed: ' + ((err && err.message) || err));
    process.exit(1);
  } finally { await pool.end(); }
})();
