/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A second printer whose destination is the SWARM, not a folder (ADR-135 amendment F). Operator's correction: this is not a drop folder being watched and forwarded — it is a distinct printer, advertised on the network, and printing to it puts the document straight into the swarm's print-queue inbox. The consequence worth naming: the printing machine needs NO swarm credential and no software. This process holds the token; a person just picks a printer. Delivery posts the RECOVERED TEXT plus the job sidecar, never the binary, so the swarm never parses an untrusted document — the same reason intake takes text. Never throws: a swarm that is down, slow or refusing must not fail the print job or lose the document, so a failed delivery leaves the spooled file exactly where it is and says why.
 */
'use strict';

/** A print job must never hang on a swarm that stopped answering. */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * @description Whether a swarm destination is configured well enough to use.
 * A half-configured target is refused rather than half-attempted: a printer that
 * silently keeps documents locally while the operator believes they are reaching
 * the swarm is the failure this check exists to prevent.
 * @param {{target:string,intakeUrl:string,intakeToken:string}} config The runtime configuration.
 * @returns {{ok:true}|{ok:false,reason:string}} Whether delivery can be attempted.
 */
function swarmTargetReady(config) {
  if (config.target !== 'swarm') return { ok: false, reason: 'not a swarm-target printer' };
  if (!config.intakeUrl) return { ok: false, reason: 'no intake URL configured (--intake-url)' };
  if (!config.intakeToken) return { ok: false, reason: 'no swarm credential configured (OSHAL_PRINT_INTAKE_TOKEN)' };
  return { ok: true };
}

/**
 * @description Deliver one printed document to the swarm's print intake. Posts the
 * recovered text and the job metadata; the document's bytes stay on this machine.
 * Never throws — the caller keeps the spooled file when this reports a failure.
 * @param {{intakeUrl:string,intakeToken:string,timeoutMs?:number}} config Where to deliver and with what credential.
 * @param {{text:string,sidecar:object}} document The recovered text and its job metadata.
 * @returns {Promise<{ok:true,intakeId:string,duplicate:boolean}|{ok:false,reason:string}>} The outcome.
 */
async function deliverToSwarm(config, document) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(config.intakeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.intakeToken}`,
      },
      body: JSON.stringify({ text: document.text, sidecar: document.sidecar }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, reason: `swarm answered ${res.status}: ${body.slice(0, 200)}` };
    }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (err) { /* a 2xx with no JSON is still delivered */ }
    return {
      ok: true,
      intakeId: String(parsed?.intake?.intakeId || ''),
      duplicate: parsed?.duplicate === true,
    };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `swarm did not answer within ${config.timeoutMs || DEFAULT_TIMEOUT_MS}ms`
      : err.message;
    return { ok: false, reason: String(reason).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { deliverToSwarm, swarmTargetReady, DEFAULT_TIMEOUT_MS };
