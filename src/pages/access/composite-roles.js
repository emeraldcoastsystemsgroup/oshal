/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Review explicit experience roles and source-safe lifecycle changes through the existing Access authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep tenant discovery and revocation reasons usable for scoped administrators without widening member authority.
 */
(function () {
  'use strict';
  window.installOshalCompositeAccess = function ({ request, snapshot, refresh }) {
    const root = document.getElementById('experience-role-controls');
    const status = document.getElementById('experience-role-status');
    const assignments = document.getElementById('experience-role-assignments');
    let generation = 0, inventory = null, review = null, selected = null, key = null, pending = false, unresolved = false;
    const el = (tag, text, attributes = {}) => {
      const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
      Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value)); return node;
    };
    const field = (label, node) => { const wrapper = el('div'); wrapper.append(el('label', label, { for: node.id }), node); return wrapper; };
    const form = el('form'), fields = el('fieldset'), grid = el('div', undefined, { class: 'selectors' });
    fields.style.border = '0'; fields.style.padding = '0'; fields.style.minWidth = '0';
    const host = el('select', undefined, { id: 'experience-role-app', required: '' });
    const template = el('select', undefined, { id: 'experience-role-template', required: '' });
    const tenant = el('input', undefined, { id: 'experience-role-tenant', maxlength: '512', autocomplete: 'off' });
    grid.append(field('Experience', host), field('Named role', template));
    const optional = el('fieldset'); optional.append(el('legend', 'Optional members'));
    const reason = el('textarea', undefined, { id: 'experience-role-reason', required: '', maxlength: '2000' });
    const expiry = el('input', undefined, { id: 'experience-role-expiry', type: 'datetime-local' });
    const submit = el('button', 'Review experience role', { type: 'submit' });
    fields.append(grid, optional, field('Role expiry (blank means no expiry)', expiry));
    form.append(field('Business tenant (when applicable)', tenant), fields, field('Reason for this change', reason), submit); root.append(form);
    const dialog = el('dialog', undefined, { 'aria-labelledby': 'experience-role-review-title' });
    dialog.style.cssText = 'color:var(--text-primary);background:var(--bg-primary);border:1px solid var(--border-color);border-radius:14px;width:min(760px,92vw);max-height:85vh;padding:24px;overflow:auto';
    const title = el('h2', 'Review experience roles', { id: 'experience-role-review-title' });
    const details = el('div'), result = el('p', '', { role: 'status', 'aria-live': 'polite' });
    const approvalFields = el('div'), apply = el('button', 'Apply reviewed changes', { type: 'button', class: 'primary' });
    const close = el('button', 'Back to choices', { type: 'button' }), actions = el('div', undefined, { class: 'actions' });
    actions.append(apply, close); dialog.append(title, details, approvalFields, result, actions); document.body.append(dialog);
    const identityKey = identity => JSON.stringify(identity);
    const current = captured => { const next = snapshot(); return next && captured && next.selection === captured.selection && (next.tenantId || '') === (captured.tenantId || '') && identityKey(next.identity) === identityKey(captured.identity); };
    function invalidate() {
      generation++;
      if (pending || unresolved) return;
      review = null; key = null; selected = null; dialog.close();
    }
    function choices() {
      const app = inventory?.experiences.find(row => row.app === host.value);
      template.replaceChildren(...(app?.templates ?? []).map(row => el('option', row.label + ' · version ' + row.version, { value: row.id })));
      rebuildOptional();
    }
    function rebuildOptional() {
      const app = inventory?.experiences.find(row => row.app === host.value);
      optional.replaceChildren(el('legend', 'Optional members'));
      const mapped = new Set(app?.templates.find(row => row.id === template.value)?.members.map(row => row.app) ?? []);
      for (const name of (app?.optionalApps ?? []).filter(name => mapped.has(name))) {
        const label = el('label'), checkbox = el('input', undefined, { type: 'checkbox', 'data-optional-app': name });
        checkbox.style.width = 'auto'; label.append(checkbox, document.createTextNode(' ' + name)); optional.append(label);
      }
      if (optional.children.length === 1) optional.append(el('p', 'No optional members for this role.', { class: 'hint' }));
    }
    function renderAssignments(captured) {
      assignments.replaceChildren(el('h3', 'Assigned experience roles'));
      const selectedRows = inventory.assignments.filter(row => identityKey(row.group ? { group: row.group } : { targetSub: row.targetSub, targetIssuer: row.targetIssuer }) === identityKey(captured.identity));
      if (!selectedRows.length) assignments.append(el('p', 'No assigned experience roles for this identity.', { class: 'hint' }));
      for (const row of selectedRows) {
        const card = el('div', undefined, { class: 'panel' });
        card.append(el('strong', row.app + ' · ' + row.templateLabel), el('p', 'Version ' + row.templateVersion + ' · ' + row.status + ' · ' + (row.tenantId || 'No business tenant')),
          el('p', 'Expiry: ' + (row.expiresAt ? new Date(row.expiresAt).toLocaleString() : 'None'), { class: 'hint' }),
          el('p', row.members.map(member => member.app + ': ' + member.role).join('; '), { class: 'details' }));
        if (row.status !== 'revoked') {
          const revoke = el('button', 'Review revocation', { type: 'button' });
          revoke.addEventListener('click', () => { void prepare('revoke', row); }); card.append(revoke);
          if (inventory.experiences.some(app => app.app === row.app)) {
            const upgrade = el('button', row.upgradeAvailable ? 'Review updated template' : 'Edit assigned role', { type: 'button' });
            upgrade.addEventListener('click', () => {
              invalidate(); host.value = row.app; choices(); template.value = row.templateId;
              // Rebuild optional choices for this exact template, then restore explicit selections.
              rebuildOptional(); optional.querySelectorAll('input').forEach(node => { node.checked = row.optionalApps.includes(node.dataset.optionalApp); });
              tenant.value = row.tenantId || ''; tenant.disabled = true; host.disabled = true; template.disabled = true;
              expiry.value = row.expiresAt ? localTime(row.expiresAt) : ''; form.dataset.assignment = row.id;
              submit.textContent = 'Review assigned role changes'; status.textContent = 'Editing ' + row.templateLabel + '. The identity and business tenant are retained.'; reason.focus();
            }); card.append(upgrade);
          }
        }
        assignments.append(card);
      }
    }
    function localTime(value) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    async function reload(retainTenant = false) {
      if (pending || unresolved) return;
      invalidate(); const sequence = generation, captured = snapshot();
      fields.disabled = true; submit.disabled = true; assignments.replaceChildren();
      if (!captured) { status.textContent = 'Choose a visible user or directory group to review experience roles.'; return; }
      const scope = retainTenant ? tenant.value.trim() : captured.identity.group?.tenantId || captured.tenantId || '';
      tenant.value = scope; tenant.disabled = Boolean(captured.identity.group);
      status.textContent = 'Loading installed experience roles…';
      try {
        const data = await request('/composites' + (scope ? '?' + new URLSearchParams({ tenantId: scope }) : ''));
        if (sequence !== generation || !current(captured)) return;
        inventory = data; host.replaceChildren(...data.experiences.map(row => el('option', row.app, { value: row.app })));
        host.disabled = false; template.disabled = false; delete form.dataset.assignment;
        if (!retainTenant) { expiry.value = ''; reason.value = ''; }
        reason.disabled = false; submit.textContent = 'Review experience role'; submit.disabled = !data.experiences.length;
        choices(); renderAssignments(captured); fields.disabled = false;
        status.textContent = data.experiences.length ? 'Choose a named role and review its member access.' : 'No installed experience role templates are available in your administration scope.';
      } catch (error) { if (sequence === generation) status.textContent = 'Experience role catalog unavailable: ' + error.message; }
    }
    async function prepare(action, assignment) {
      if (pending || unresolved || !snapshot() || !inventory || (action !== 'revoke' && !form.reportValidity())) return;
      if (action === 'revoke' && !reason.value.trim()) { status.textContent = 'Enter a reason before reviewing revocation.'; reason.focus(); return; }
      const captured = snapshot(), sequence = generation;
      pending = true; fields.disabled = true; tenant.disabled = true; reason.disabled = true; submit.disabled = true;
      selected = captured; result.textContent = 'Checking current authority and every member role…'; dialog.showModal(); apply.disabled = true;
      details.replaceChildren(); approvalFields.replaceChildren(); close.disabled = true; apply.textContent = 'Apply reviewed changes';
      const selectedOptional = [...optional.querySelectorAll('input:checked')].filter(node => !node.closest('label').hidden).map(node => node.dataset.optionalApp);
      const expiresAt = expiry.value ? new Date(expiry.value).toISOString() : null;
      const input = { action, app: assignment?.app || host.value, reason: reason.value.trim(), expectedRevision: inventory.revision,
        ...(action === 'assign' ? { template: template.value, ...captured.identity, ...(tenant.value.trim() ? { tenantId: tenant.value.trim() } : {}) } : { assignmentId: assignment.id }),
        ...(action === 'revoke' ? {} : { optionalApps: selectedOptional, ...(expiresAt ? { expiresAt } : action === 'upgrade' ? { expiresAt: null } : {}) }) };
      try {
        const data = await request('/composites/preview', input);
        if (sequence !== generation || !current(captured)) { dialog.close(); status.textContent = 'Identity changed. Review the current selection again.'; return; }
        review = data; key = crypto.randomUUID();
        title.textContent = action === 'revoke' ? 'Review experience revocation' : 'Review experience role';
        details.append(el('p', captured.label + ' · ' + data.app + ' · ' + data.template.label), el('p', 'Reason: ' + input.reason),
          el('p', 'Role expiry: ' + (data.assignmentExpiresAt || 'None')), el('p', 'Policy revision ' + data.revision + (data.expiresAt ? '. Review expires ' + new Date(data.expiresAt).toLocaleString() : '')));
        const list = el('ul');
        for (const member of data.members) {
          list.append(el('li', member.action + ' ' + member.app + ': ' + member.role + (member.blocked ? ' — ' + member.blocked : ' · ' + member.tier + ' · ' + (member.permissions || []).map(grant => grant.permission + ' (' + grant.scope + (grant.fields ? ', ' + grant.fields : '') + ')').join(', '))));
          if (member.requiresApproval) {
            const input = el('input', undefined, { id: 'composite-approval-' + member.preview.previewId, 'data-preview': member.preview.previewId, maxlength: '512', autocomplete: 'off' });
            approvalFields.append(field('Approval reference for ' + member.app + ' / ' + member.role, input));
            approvalFields.append(el('p', 'Enter a verified approval reference. A sole swarm operator may type approve to request the existing self-approval check; the server verifies eligibility.', { class: 'hint' }));
          }
        }
        details.append(list);
        result.textContent = data.ready ? 'Every member is ready. Applying saves the entire reviewed set together.' : 'This role cannot be applied. Resolve the refused member access, then review again.';
        updateApply();
      } catch (error) { result.textContent = 'Review unavailable: ' + error.message; review = null; }
      finally { pending = false; close.disabled = false; updateApply(); if (sequence !== generation || !current(captured)) void reload(); }
    }
    function updateApply() { apply.disabled = pending || !review?.ready || [...approvalFields.querySelectorAll('input')].some(node => !node.value.trim()); }
    async function save() {
      if (pending || !review?.ready || (!unresolved && !current(selected))) return;
      pending = true; close.disabled = true; updateApply(); result.textContent = 'Applying reviewed changes…';
      const approvals = Object.fromEntries([...approvalFields.querySelectorAll('input')].map(node => [node.dataset.preview,
        node.value.trim().toLowerCase() === 'approve' ? 'sole-operator-self-approval:' + node.dataset.preview : node.value.trim()]));
      approvalFields.querySelectorAll('input').forEach(node => { node.disabled = true; });
      try {
        const receipt = await request('/composites/apply', { previewId: review.previewId, idempotencyKey: key, ...(Object.keys(approvals).length ? { approvals } : {}) });
        unresolved = false; review = null; dialog.close(); status.textContent = 'Experience role ' + receipt.status + '. Audit records: ' + receipt.auditIds.join(', ');
        pending = false; await refresh();
      } catch (error) {
        unresolved = !error.status || error.status >= 500;
        result.textContent = unresolved ? 'The result could not be confirmed. Retry this same reviewed apply to retrieve its receipt; the idempotency key is retained.' : 'Apply refused: ' + error.message + '. Return to choices and review current access.';
        if (!unresolved) review = null;
        apply.textContent = unresolved ? 'Retry reviewed apply' : 'Apply reviewed changes';
      } finally { pending = false; close.disabled = unresolved; updateApply(); }
    }
    host.addEventListener('change', () => { invalidate(); choices(); }); template.addEventListener('change', () => { invalidate(); rebuildOptional(); });
    tenant.addEventListener('change', () => { invalidate(); void reload(true); });
    form.addEventListener('submit', event => { event.preventDefault(); const row = inventory?.assignments.find(item => item.id === form.dataset.assignment); void prepare(row ? 'upgrade' : 'assign', row); });
    approvalFields.addEventListener('input', updateApply); apply.addEventListener('click', () => { void save(); });
    function backToChoices() { invalidate(); fields.disabled = false; reason.disabled = false; submit.disabled = !inventory?.experiences.length; tenant.disabled = Boolean(form.dataset.assignment || snapshot()?.identity.group); }
    close.addEventListener('click', () => { if (!pending && !unresolved) backToChoices(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending && !unresolved) backToChoices(); });
    ['target', 'target-kind', 'tenant'].forEach(id => document.getElementById(id).addEventListener('change', () => { invalidate(); void reload(); }));
    return { invalidate, reload };
  };
})();
