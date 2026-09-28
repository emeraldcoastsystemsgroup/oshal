/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Render explicit connection selection and owner opt-in without exposing connector secrets.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Change Log brought to the standard block format; no behavior change.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('calling-form');
  const status = $('status');
  const selection = $('connection');
  const reasons = {
    application_disabled: 'Calling is off for this application.',
    connection_not_selected: 'Select a Twilio connection.',
    connection_unavailable: 'The selected connection is no longer available; choose another.',
    transfer_phone_missing: 'Add your transfer phone.',
    live_calling_not_installed: 'The live calling service is not installed; no calls can be placed yet.',
  };
  function render(data) {
    selection.replaceChildren(new Option('Choose a connection', ''));
    for (const connection of data.connections || []) {
      selection.add(new Option(`${connection.label} (${connection.scope})`, connection.id));
    }
    const config = data.config || {};
    selection.value = data.selectedConnectionAvailable ? (config.connectionId || '') : '';
    $('transfer-phone').value = config.transferPhone || '';
    $('max-minutes').value = String(config.maxMinutes ?? '');
    $('max-cost').value = (Number(config.maxCostCents || 0) / 100).toFixed(2);
    $('enabled').checked = config.enabled === true;
    $('consent').checked = config.consented === true;
    const blocked = (data.blockedReasons || []).map((reason) => reasons[reason] || reason);
    status.textContent = blocked.join(' ') || 'Configuration saved.';
  }
  async function load() {
    try {
      const response = await fetch('/api/jarvis/calling/config', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Calling settings could not be loaded.');
      render(await response.json());
    } catch (error) { status.textContent = error.message; }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const enabled = $('enabled').checked;
    const phone = $('transfer-phone').value.trim();
    const cost = Number($('max-cost').value);
    const minutes = Number($('max-minutes').value);
    if (enabled && (!selection.value || !phone || !$('consent').checked)) {
      status.textContent = 'To opt in, choose a connection, enter your transfer phone, and acknowledge per-call approval.';
      return;
    }
    if (!Number.isFinite(cost) || !Number.isFinite(minutes)) { status.textContent = 'Enter valid limits.'; return; }
    $('save').disabled = true;
    status.textContent = 'Saving…';
    try {
      const response = await fetch('/api/jarvis/calling/config', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Oshal-Calling-Config': '1' },
        body: JSON.stringify({
          connectionId: selection.value || null, enabled,
          transferPhone: phone || null, maxMinutes: minutes,
          maxCostCents: Math.round(cost * 100), consent: $('consent').checked,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save calling settings.');
      render(data);
      status.textContent = `Saved. ${status.textContent}`;
    } catch (error) { status.textContent = error.message; }
    finally { $('save').disabled = false; }
  });
  void load();
})();
