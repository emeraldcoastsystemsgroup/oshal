/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Render source settings and honor server-owned announcement channels without client-side identity claims.
 */
(function () {
  'use strict';
  const base = '/api/jarvis/briefings';
  const messages = {
    same_origin_required: 'Refresh this page and try saving again.',
    briefing_source_unavailable: 'This source is no longer available to your account. Refresh to see your current sources.',
    briefing_identity_required: 'Sign in again to manage your briefings.',
    not_authenticated: 'Sign in again to manage your briefings.',
    briefing_access_denied: 'This source is no longer available to your account. Refresh to see your current sources.',
    invalid_briefing_request: 'Review your selections and try saving again.',
  };
  async function request(path, method, body) {
    const response = await fetch(base + path, { method, credentials: 'include', signal: AbortSignal.timeout(10000),
      headers: body ? { 'Content-Type': 'application/json', 'X-Oshal-Briefing-Request': '1' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(messages[value.error] || 'Briefings are temporarily unavailable. Please try again.');
    return value;
  }
  window.OshalBriefings = {
    reconcile(cache, tasks) {
      const visible = new Set(tasks.map(task => task.id));
      const removed = [];
      for (const [id, task] of Object.entries(cache)) {
        if (task.briefing && !visible.has(id)) { delete cache[id]; removed.push(id); }
      }
      return removed;
    },
    async deliver(tasks, away, deliver) {
      const ordinary = tasks.filter(task => !task.briefing);
      const briefings = tasks.filter(task => task.briefing);
      if (!briefings.length) { if (ordinary.length) deliver(ordinary, away, true); return; }
      // A failed claim never falls through to the ordinary voice path.
      let result;
      try { result = await request('/claim', 'POST', { taskIds: briefings.map(task => task.id) }); }
      catch (error) { if (ordinary.length) deliver(ordinary, away, true); throw error; }
      for (const channel of ['voice', 'bubble', 'screen']) {
        const ids = new Set(result.claimed.filter(item => item.channel === channel).map(item => item.id));
        const selected = briefings.filter(task => ids.has(task.id));
        for (const task of selected) task.delivered = true;
        const batch = channel === 'voice' ? [...ordinary, ...selected] : selected;
        if (batch.length && channel !== 'screen') deliver(batch, away, channel === 'voice');
      }
    },
  };
  if (document.body.hasAttribute('data-briefing-settings')) renderOshalBriefingSettings(request);
}());

function renderOshalBriefingSettings(request) {
  const status = document.getElementById('briefing-status');
  const container = document.getElementById('briefing-sources');
  function element(tag, text) { const node = document.createElement(tag); if (text) node.textContent = text; return node; }
  function select(label, values, selected) {
    const row = element('label', label); const control = element('select'); control.setAttribute('aria-label', label);
    for (const [value, title] of values) { const option = element('option', title); option.value = value; control.append(option); }
    control.value = selected; row.append(control); return { row, control };
  }
  request('', 'GET').then(({ sources }) => {
    status.textContent = sources.length ? '' : 'No briefing sources are registered for your available applications.';
    for (const source of sources) {
      const card = element('article'); card.dataset.sourceId = source.sourceId;
      card.append(element('h2', source.title), element('p', source.description || source.app));
      const enabledLabel = element('label', 'Enabled'); const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = source.preference.enabled;
      enabled.setAttribute('aria-label', 'Enabled'); enabledLabel.append(enabled);
      const frequency = select('Frequency', [['as-available', 'As updates arrive'], ['hourly', 'At most hourly'], ['daily', 'At most daily'], ['weekly', 'At most weekly']], source.preference.frequency);
      const labels = { voice: 'Voice and bubble', bubble: 'Bubble only', screen: 'Main screen only' };
      const channel = select('Channel', source.channels.map(value => [value, labels[value]]), source.preference.channel);
      const save = element('button', 'Save'); save.type = 'button';
      const feedback = element('p'); feedback.setAttribute('role', 'status');
      save.addEventListener('click', async () => {
        save.disabled = true; feedback.textContent = 'Saving…';
        try { await request('/' + encodeURIComponent(source.sourceId), 'PUT', { enabled: enabled.checked, frequency: frequency.control.value, channel: channel.control.value }); feedback.textContent = 'Saved'; }
        catch (error) { feedback.textContent = error.message; }
        finally { save.disabled = false; }
      });
      card.append(enabledLabel, frequency.row, channel.row, save, element('small', source.delivery), feedback); container.append(card);
    }
  }).catch(error => { status.textContent = error.message; });
}
