/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (B4, step B5-3): the AI defaults screen hosts the two unchanged /config
 *   | panel modules (config-admin-fleet-default.js and config-admin-capability-providers.js) with
 *   | the small app contract they expect: state (providers, agents, fleetDefault,
 *   | capabilityProviders), the two panel hosts, setStatus and render. The panels own their forms,
 *   | writes and messages; this page only loads, binds and renders, so the admin's screen and /config
 *   | can never disagree about what a default is. Each read is on its own, so one failure never blanks
 *   | the other panel, and an ended session is named as such (review).
 */

import { fetchJson, toErrorMessage } from '/config-admin/config-admin-utils.js';
import { clearFleetDefault, loadFleetDefault, renderFleetDefaultPanel, saveFleetDefault } from '/config-admin/config-admin-fleet-default.js';
import { bindCapabilityProvidersPanel, loadCapabilityProviders, renderCapabilityProvidersPanel } from '/config-admin/config-admin-capability-providers.js';

/** The app contract the /config panel modules read: state, their hosts, a status line and a re-render. */
const app = {
  state: { providers: [], agents: [], fleetDefault: null, capabilityProviders: null },
  elements: {
    fleetDefaultPanel: document.getElementById('fleetDefaultPanel'),
    capabilityProvidersPanel: document.getElementById('capabilityProvidersPanel'),
    statusBanner: document.getElementById('statusBanner'),
  },
  /**
   * @description Shows one status line with a tone, as the panels report their outcomes.
   * @param {string} message - What happened.
   * @param {'info'|'success'|'error'} tone - How it went.
   * @returns {void}
   */
  setStatus(message, tone) {
    app.elements.statusBanner.textContent = message;
    app.elements.statusBanner.dataset.tone = tone;
  },
  /**
   * @description Re-renders both panels from state (the fleet panel calls this after a switch).
   * @returns {void}
   */
  render() {
    renderFleetDefaultPanel(app);
    renderCapabilityProvidersPanel(app);
  },
};

/**
 * @description Wires the panels' forms exactly as /config does: the fleet form's submit and clear
 * button by delegation, and the capability panel through its own binder.
 * @returns {void}
 */
function bind() {
  app.elements.fleetDefaultPanel.addEventListener('submit', async (event) => {
    if (event.target.matches('#fleetDefaultForm')) {
      event.preventDefault();
      await saveFleetDefault(app);
    }
  });
  app.elements.fleetDefaultPanel.addEventListener('click', async (event) => {
    if (event.target.closest('#clearFleetDefaultButton')) {
      event.preventDefault();
      await clearFleetDefault(app);
    }
  });
  bindCapabilityProvidersPanel(app);
}

/**
 * @description The message for a failed read: a reply that is not JSON means the session has ended
 * and the sign-in page answered instead; anything else is shown as it is.
 * @param {unknown} error - The read's error.
 * @returns {string} What to tell the operator.
 */
function describeLoadError(error) {
  const message = toErrorMessage(error);
  return /Unexpected token|not valid JSON|Unexpected end of JSON/i.test(message) ? 'Your session has ended. Sign in again.' : message;
}

/**
 * @description Loads the provider list the fleet select offers, and both panels, each on its own so
 * one failed read never blanks the others; then renders and reports.
 * @returns {Promise<void>}
 */
async function main() {
  bind();
  const problems = [];
  try {
    const providers = await fetchJson('/api/providers');
    app.state.providers = Array.isArray(providers) ? providers : [];
  } catch (error) {
    problems.push(`the provider list (${describeLoadError(error)})`);
  }
  await Promise.all([loadFleetDefault(app), loadCapabilityProviders(app)]);
  app.render();
  if (app.state.fleetDefault?.error) problems.push(`the fleet default (${describeLoadError(app.state.fleetDefault.error)})`);
  if (app.state.capabilityProviders?.error) problems.push(`the capability defaults (${describeLoadError(app.state.capabilityProviders.error)})`);
  app.setStatus(
    problems.length ? `Could not load ${problems.join(', ')}. Reload the page to try again.` : 'AI defaults loaded. A change takes effect on the next call or dispatch.',
    problems.length ? 'error' : 'success',
  );
}

void main();
