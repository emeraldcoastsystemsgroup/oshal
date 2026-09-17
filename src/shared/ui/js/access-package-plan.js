/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Review required package access and hand explicit role choices to the existing audited batch flow.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep package review steps small and disable planning without a current person and applications.
 */
'use strict';
const PACKAGE_ACCESS_LABELS = { 'choose-role': 'Choose a role', 'grant-app-admin': 'Explicit app administrator role required',
  'already-granted': 'Already has access', 'no-grant-required': 'No structural grant required',
  'blocked-explicit-deny': 'Explicitly denied — review the deny separately', 'blocked-management-denied': 'No management permission',
  'blocked-not-installed': 'Not installed', 'blocked-inactive': 'Application inactive',
  'blocked-subject-inactive': 'User inactive', 'blocked-tenant': 'User is not a member of this tenant' };

function createPackageAccessElements() {
  const bar = document.createElement('div'); bar.className = 'row';
  bar.id = 'package-access-toolbar';
  bar.innerHTML = '<label for="package-access-app">Assign a package</label><select id="package-access-app"></select><label for="package-access-tenant">Business tenant (optional)</label><input id="package-access-tenant" maxlength="512"><button id="package-access-plan" type="button">Review package access</button><span id="package-access-status" role="status"></span>';
  document.getElementById('bulk-toolbar').before(bar);
  const dialog = document.createElement('dialog'); dialog.id = 'package-access-dialog';
  dialog.setAttribute('aria-labelledby', 'package-access-title');
  dialog.innerHTML = '<h2 id="package-access-title">Package access review</h2><p id="package-access-person"></p><p>Only required applications are included. Choose each missing role in the next step; nothing is granted by this plan.</p><div id="package-access-entries"></div><p id="package-access-needs"></p><p id="package-access-offers"></p><p id="package-access-result" role="status"></p><div class="actions"><button id="package-access-continue" type="button">Choose required roles</button><button id="package-access-close" type="button">Close</button></div>';
  document.body.append(dialog);
  return dialog;
}

function summarizePackageAccess(plan, snapshot) {
  const rows = plan.entries.filter(entry => ['choose-role', 'grant-app-admin'].includes(entry.action));
  const blocked = plan.entries.some(entry => !PACKAGE_ACCESS_LABELS[entry.action] || entry.action.startsWith('blocked-'))
    || rows.some(entry => !snapshot.apps.some(app => app.app === entry.app && app.canAssign));
  if (plan.cycles.length) return { rows, error: 'The package has a dependency cycle. Correct its declaration before assigning access.' };
  if (blocked) return { rows, error: 'Resolve the blocked applications before assigning this package. No changes have been made.' };
  if (rows.length > 20) return { rows, error: 'This package exceeds the 20-application review limit. Use the application table to review smaller batches.' };
  return { rows, error: rows.length ? '' : 'No missing roles in this package. Use Edit roles to change an existing role.' };
}

/** Read-only package planning. This controller never posts a grant or chooses a role. */
class OshalPackageAccessController {
  constructor(ports) {
    this.ports = ports;
    this.generation = 0; this.busy = false; this.pending = false; this.reviewed = null;
    this.dialog = createPackageAccessElements();
    this.bind(); this.update();
  }
  $(id) { return document.getElementById(id); }
  snapshotNow() { return this.ports.snapshot(this.$('package-access-tenant').value.trim()); }
  identity(snapshot) { return JSON.stringify([snapshot?.target, snapshot?.revision, snapshot?.apps]); }
  current(token, snapshot) { return token === this.generation && this.identity(this.snapshotNow()) === this.identity(snapshot); }
  update() {
    const snapshot = this.snapshotNow();
    this.$('package-access-plan').disabled = this.busy || this.pending || !snapshot?.apps?.length || !this.$('package-access-app').value;
  }
  reset() {
    this.generation++; this.reviewed = null; this.pending = false; this.dialog.close();
    this.$('package-access-status').textContent = ''; this.update();
  }
  attach() {
    this.reset(); const previous = this.$('package-access-app').value;
    this.$('package-access-app').replaceChildren();
    for (const app of this.snapshotNow()?.apps || []) {
      const option = document.createElement('option'); option.value = app.app; option.textContent = app.app;
      this.$('package-access-app').append(option);
    }
    if ([...this.$('package-access-app').options].some(option => option.value === previous)) this.$('package-access-app').value = previous;
    this.update();
  }
  render(plan, snapshot, token) {
    const result = summarizePackageAccess(plan, snapshot); this.reviewed = { plan, snapshot, token, ...result };
    this.$('package-access-person').textContent = `${snapshot.label} · ${plan.targetIssuer} / ${plan.targetSub}`;
    const list = document.createElement('ul');
    for (const entry of plan.entries) {
      const item = document.createElement('li'); item.textContent = `${entry.app}: ${PACKAGE_ACCESS_LABELS[entry.action] || 'Unsupported plan entry'}`;
      if (entry.inertAssignments) item.textContent += ' — previous assignments need separate migration review';
      list.append(item);
    }
    this.$('package-access-entries').replaceChildren(list);
    this.$('package-access-needs').textContent = plan.declaredNeeds.length
      ? 'Connections and tools to configure separately: ' + plan.declaredNeeds.map(need => need.id).join(', ') : '';
    this.$('package-access-offers').textContent = plan.offers.length
      ? 'Optional applications are excluded: ' + plan.offers.map(offer => offer.app).join(', ') : '';
    this.$('package-access-result').textContent = result.error || `${result.rows.length} applications need an explicit role choice.`;
    this.$('package-access-continue').disabled = Boolean(result.error); this.dialog.showModal();
  }
  async plan() {
    if (this.busy || this.pending) return;
    const snapshot = this.snapshotNow(), app = this.$('package-access-app').value, token = ++this.generation;
    if (!snapshot || !app) return;
    this.pending = true; this.reviewed = null; this.update(); this.$('package-access-status').textContent = 'Checking package dependencies and current access…';
    try {
      const input = { app, ...snapshot.target }, result = await this.ports.request('/package-plan', input);
      if (!this.current(token, snapshot)) return;
      if (result.app !== app || result.targetSub !== input.targetSub || result.targetIssuer !== input.targetIssuer
        || (result.tenantId || '') !== (input.tenantId || '') || result.revision !== snapshot.revision
        || !Array.isArray(result.entries) || !Array.isArray(result.cycles) || !Array.isArray(result.declaredNeeds) || !Array.isArray(result.offers)) {
        throw new Error('Package access changed. Refresh applications before reviewing again.');
      }
      this.render(result, snapshot, token); this.$('package-access-status').textContent = '';
    } catch (error) {
      if (this.current(token, snapshot)) this.$('package-access-status').textContent = error.message || 'Could not read package access.';
    } finally { if (token === this.generation) { this.pending = false; this.update(); } }
  }
  continueReview() {
    if (!this.reviewed || this.reviewed.error || this.busy || !this.current(this.reviewed.token, this.reviewed.snapshot)) { this.reset(); return; }
    const selection = this.reviewed; this.dialog.close(); this.reviewed = null;
    this.ports.review(selection.rows.map(entry => entry.app), selection.snapshot.target.tenantId || '');
  }
  bind() {
    this.$('package-access-plan').addEventListener('click', () => { void this.plan(); });
    this.$('package-access-app').addEventListener('change', () => this.reset());
    this.$('package-access-tenant').addEventListener('input', () => this.reset());
    this.$('package-access-close').addEventListener('click', () => this.reset());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.reset(); });
    this.$('package-access-continue').addEventListener('click', () => this.continueReview());
  }
}

window.installOshalPackageAccess = function installOshalPackageAccess(ports) {
  const controller = new OshalPackageAccessController(ports);
  return { attach: () => controller.attach(), reset: () => controller.reset(),
    busy(value) { controller.busy = value; controller.update(); } };
};
