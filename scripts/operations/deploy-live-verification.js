/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The loopback half of the post-deploy live verification (scripts/lib/deploy-verify.sh): ask Jarvis one fixed question as the operator, and put one synthetic ticket through the queue, on a stack that just reported DEPLOYED. Both halves failed on 2026-09-15 behind a deploy that reported success. Statuses and safe bodies only - never the token, the secret or the operator subject.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Read every knob at call time and export runCheck, so the guard can drive the real checks in-process against a real loopback server. The CLI shape is unchanged; the reason is that this host's firewall refuses a cross-process connection to a Node listener (curl reproduces it), so a spawned probe could only ever be tested against a doubled fetch. 
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Clean up what the check writes, and say so out loud when it cannot. The Jarvis half used to close its thread and leave the rest: POST /api/jarvis/ask registers the thread as a chat_tasks row (ensureSessionTask) and opens a chat-ticket, and /thread/close only marks that ticket complete - so every deploy left a chat row, a board card and its chat_messages behind forever, and a REFUSED ask leaked the row without even closing the thread (the row is written before the ownership gate; a refused thread sits at status 'created'). The ask response already carries chatTicketId, so the thread's ticket is deleted by id and the session task by DELETE /api/tasks/:taskId, which removes the row and its messages. Nothing is reused, so the bookmarked-thread refusal is not in play. Every cleanup step that does not succeed - here and on the synthetic ticket's delete - now reports at error level naming exactly what was left behind, on stderr so stdout stays the single verdict line. Cleanup runs after the verdict is decided and can never change it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Make both product checks answerable on a box with delegation signing on, without weakening a single authorization rule. Two separate walls were hit on 2026-09-15 and again on 2026-09-16: (a) this check asks as a PAT minted from the service secret, and that mint records NO principal issuer by design (cli-token-routes.ts refuses to let a fleet secret assert an IdP namespace), so with signing configured resolveDelegatedPrincipal refuses 'User-bound delegation requires a verified principal issuer' for the Jarvis ask AND for the queued dispatch; (b) the synthetic 'task' ticket routes by ADR-083 CALL-OUT, and the bid winner on this box was an inline bot, which signed delegation refuses before the issuer is ever consulted. So: an operator may hand the check a session-minted PAT (OSHAL_VERIFY_OPERATOR_PAT) that carries a verified issuer, in which case both checks run for real; absent one, a refusal that is EXACTLY the missing-issuer refusal, under signing, on the self-minted bootstrap PAT, exits 3 - 'not verifiable from automation', a third state that is neither PASS nor FAIL. Every other refusal still fails, including the same refusal when an operator PAT WAS supplied (then the supplied token is the thing at fault). The dispatch check also pins its worker to the 'task' workflow's DECLARED owner (general-bot, requiresOwnNode -> a dedicated node) via metadata.targetAgentId, resolved by name through GET /api/agents so no agent id is hardcoded, and now quotes the ticket's own lastStatusTransition reason/message so a parked ticket says WHY without a log dig.
 */
// Runs INSIDE the api container on loopback, one check per invocation:
//   node deploy-live-verification.js jarvis   - ask Jarvis a fixed question as the operator
//   node deploy-live-verification.js ticket   - push one synthetic ticket through the queue
// Exit 0 = passed, 1 = failed, 2 = this box carries no operator identity to act as,
//        3 = not verifiable from automation (see UNVERIFIABLE_REFUSAL below) - NOT a pass.
// Prints exactly one detail line. It never prints the minted token or the operator subject:
// the PAT is minted with the service secret already present in this container's environment,
// used on loopback, and revoked by id in a finally block.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one refusal automation cannot answer for itself. `POST /api/cli-tokens` behind the service
 * secret records `principal_issuer: null` ON PURPOSE - a fleet-wide secret every bot container
 * carries is not proof of an identity-provider namespace (cli-token-routes.ts). With controller
 * signing configured, `resolveDelegatedPrincipal` (bot-node-client.ts) therefore refuses a
 * user-bound delegation raised under that PAT, for the Jarvis ask and for the queued dispatch
 * alike. That is the authorization rule working, not a product outage - so this check must not
 * report it as one, and must not pretend it verified anything either.
 */
const UNVERIFIABLE_REFUSAL = 'User-bound delegation requires a verified principal issuer';

/**
 * @description Resolve every knob from the environment at call time, so one process can run a
 * check, and so the deploy can retune a budget without a code change.
 * @returns The resolved configuration for one check run.
 */
function readConfig() {
  return {
    base: `http://127.0.0.1:${process.env.PORT || '5000'}`,
    secret: process.env.SWARM_SERVICE_SECRET || '',
    subject: (process.env.OSHAL_VERIFY_SUB || process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0].trim(),
    // A PAT the operator minted from a SIGNED-IN session, which is the only mint that records a
    // verified principal issuer. Supplying one turns both checks back into real PASS/FAIL under
    // signing; it is used as-is and never revoked, because it is the operator's own credential.
    operatorToken: (process.env.OSHAL_VERIFY_OPERATOR_PAT || '').trim(),
    // Presence only - the value is never read, logged or compared. Both halves must be present for
    // the controller to sign, which is the condition that makes the refusal above structural.
    signing: Boolean((process.env.OSHAL_DELEGATION_SIGNING_KID || '').trim())
      && Boolean((process.env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY || '').trim()),
    requestTimeoutMs: Number(process.env.OSHAL_VERIFY_REQUEST_TIMEOUT_MS || 20000),
    budgetMs: Number(process.env.OSHAL_VERIFY_BUDGET_MS || 300000),
    pollMs: Number(process.env.OSHAL_VERIFY_POLL_MS || 5000),
    question: process.env.OSHAL_VERIFY_QUESTION || 'Reply with the single word ready.',
    ticketType: process.env.OSHAL_VERIFY_TICKET_TYPE || 'task',
    // The 'task' workflow DECLARES general-bot as its worker (WORKFLOW_PIPELINES in
    // dispatch-routing.ts) and the registry marks general-bot `requiresOwnNode: true`, so
    // resolve-bot-node-endpoint.ts gives it a real node endpoint instead of the controller-inline
    // path. What replaces that declared owner at dispatch time is the ADR-083 call-out, whose bid
    // winner can be any online knowledge owner - an INLINE one on 2026-09-15/16, which signed
    // delegation refuses outright. Pinning the declared owner via metadata.targetAgentId is what
    // makes this check land on a dedicated bot node deterministically instead of on whoever bid.
    ticketWorker: (process.env.OSHAL_VERIFY_TICKET_WORKER || 'general-bot').trim(),
    // 'approved' is the only state the queue manager polls; anything else is never dispatched.
    queuedState: process.env.OSHAL_VERIFY_TICKET_QUEUED_STATE || 'approved',
    // Where a failed dispatch parks a ticket. dispatch-manifest-worker writes 'escalated'
    // with reason manifest_worker_dispatch_failed, which is the 2026-09-15 shape exactly.
    failedStates: new Set((process.env.OSHAL_VERIFY_TICKET_FAILED_STATES || 'escalated,dead_letter,failed,cancelled')
      .split(',').map((state) => state.trim()).filter(Boolean)),
  };
}

/**
 * @description One loopback request with a hard per-call timeout, returning status and parsed body
 * together so no caller has to decide whether a non-JSON error page is fatal.
 * @param cfg - Resolved configuration.
 * @param path - API path beginning with a slash.
 * @param init - fetch init; `token` adds the caller's bearer authorization.
 * @returns The HTTP status and the parsed JSON body (an empty object when the body is not JSON).
 */
async function call(cfg, path, init = {}) {
  const { token, ...rest } = init;
  const headers = { ...(rest.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (rest.body) headers['content-type'] = 'application/json';
  const response = await fetch(cfg.base + path, {
    ...rest,
    headers,
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/**
 * @description Report one cleanup step that did not succeed. Cleanup runs only after the verdict is
 * already decided, so it can never turn a PASS into a FAIL - but a step that failed silently would
 * leave a row on the operator's box on every deploy with nothing in the run log to say so. This
 * writes at error level on stderr, which deploy-verify.sh merges into the run log (it runs the probe
 * with 2>&1), so stdout stays the single verdict line the CLI contract promises.
 * @param cfg - Resolved configuration.
 * @param path - The API path whose call was supposed to remove the state.
 * @param init - fetch init, exactly as `call` takes it.
 * @param leaked - What is still on the box, in plain words, so the leak is actionable.
 * @returns true when the request returned 2xx; false when anything else happened.
 */
async function cleanUp(cfg, path, init, leaked) {
  const outcome = await call(cfg, path, init).then(
    ({ status, body }) => (status >= 200 && status < 300 ? null : `HTTP ${status}${body.error ? ` ${body.error}` : ''}`),
    (error) => (error instanceof Error ? error.message : String(error)),
  );
  if (outcome === null) return true;
  console.error(`CLEANUP FAILED: ${init.method || 'GET'} ${path} -> ${outcome}; ${leaked}`);
  return false;
}

/**
 * @description Remove everything one verification ask wrote. POST /api/jarvis/ask registers the
 * thread as a `chat_tasks` row and opens a chat-ticket for it, and /thread/close only completes that
 * ticket - so closing alone leaves a chat row, a board card and the thread's chat_messages behind on
 * every deploy. The thread id is fresh each run and never reused, so none of this meets the
 * bookmarked-thread refusal. Each step is independent: a failure of one still attempts the rest, and
 * no step can throw into the caller's finally and rewrite an already-decided verdict.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @param sessionId - The thread id this run created.
 * @param chatTicketId - The chat-ticket the ask opened, when the ask got far enough to return one.
 * @returns Resolves once every cleanup step has been attempted and any failure reported.
 */
async function cleanUpThread(cfg, token, sessionId, chatTicketId) {
  const thread = encodeURIComponent(sessionId);
  await cleanUp(cfg, '/api/jarvis/thread/close', { method: 'POST', token, body: JSON.stringify({ sessionId }) },
    `the chat-ticket for thread ${sessionId} may still be open on the Chat board`);
  if (chatTicketId) {
    await cleanUp(cfg, `/api/tickets/${encodeURIComponent(chatTicketId)}`, { method: 'DELETE', token },
      `chat ticket ${chatTicketId} is still on the board`);
  }
  await cleanUp(cfg, `/api/tasks/${thread}`, { method: 'DELETE', token },
    `the chat_tasks row ${sessionId} and its chat_messages may still be in the database`);
}

/**
 * @description Ask Jarvis one fixed question on a fresh thread and require a real answer, then remove
 * the thread entirely - its chat-ticket and its `chat_tasks` row - so a deploy leaves the operator's
 * board and database exactly as it found them. The cleanup covers a REFUSED ask too: the ask writes
 * the thread's row before the ownership gate runs, so an early return used to leak one row per
 * failed verification, which is the path this gate exists to hit.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @returns { ok, detail } - ok only when the poll returns status 'done' with answer text.
 */
async function askJarvis(cfg, token) {
  const sessionId = `deploy-verify-${crypto.randomUUID()}`;
  let chatTicketId;
  try {
    const ask = await call(cfg, '/api/jarvis/ask', { method: 'POST', token, body: JSON.stringify({ message: cfg.question, sessionId }) });
    chatTicketId = ask.body.chatTicketId;
    if (!ask.body.jobId) {
      return { ok: false, detail: `POST /api/jarvis/ask returned HTTP ${ask.status}${ask.body.error ? ` ${ask.body.error}` : ''} and no jobId` };
    }
    const started = Date.now();
    const deadline = started + cfg.budgetMs;
    let last = 'pending';
    while (Date.now() < deadline) {
      await sleep(cfg.pollMs);
      const poll = await call(cfg, `/api/jarvis/ask/result?jobId=${encodeURIComponent(ask.body.jobId)}`, { token });
      last = poll.body.status || `HTTP ${poll.status}`;
      if (last === 'pending') continue;
      if (last === 'done' && typeof poll.body.answer === 'string' && poll.body.answer.trim()) {
        return { ok: true, detail: `Jarvis answered in ${Math.round((Date.now() - started) / 1000)}s (${poll.body.answer.trim().length} chars)` };
      }
      return { ok: false, detail: `Jarvis returned status '${last}'${poll.body.error ? `: ${poll.body.error}` : ' with no answer text'}` };
    }
    return { ok: false, detail: `Jarvis never answered within ${Math.round(cfg.budgetMs / 1000)}s (last status '${last}')` };
  } finally {
    await cleanUpThread(cfg, token, sessionId, chatTicketId);
  }
}

/**
 * @description Reads the reason the queue last recorded for a ticket. Every dispatcher writes its
 * refusal into `metadata.lastStatusTransition` ({reason, message}) before parking the ticket, and
 * without it a FAIL line says only that the ticket escalated - the operator then has to dig through
 * container logs to learn whether it was a delegation refusal, an unresolved worker or a bot error.
 * It is also what tells a structural refusal apart from a product failure in {@link classifyVerdict}.
 * @param body - The ticket as `GET /api/tickets/:id` returned it.
 * @returns A bounded "reason: message" string, or '' when the ticket carries no transition record.
 */
function ticketRefusal(body) {
  const metadata = body && typeof body.metadata === 'object' && body.metadata ? body.metadata : {};
  const transition = metadata.lastStatusTransition;
  if (!transition || typeof transition !== 'object') return '';
  return [transition.reason, transition.message]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(': ')
    .slice(0, 300);
}

/**
 * @description Resolve the bot this check pins its ticket to, BY NAME, from the deployment's own
 * agent registry - so no agent id is written into this file and a renamed or absent worker fails
 * loudly instead of pinning a stale uuid nothing answers on.
 * @param cfg - Resolved configuration.
 * @param token - The caller's bearer token.
 * @returns The agent id, or null when the deployment has no active agent under that name.
 */
async function resolveWorkerAgentId(cfg, token) {
  const { status, body } = await call(cfg, '/api/agents', { token });
  if (status !== 200) return null;
  const agents = Array.isArray(body) ? body : (Array.isArray(body.agents) ? body.agents : []);
  const match = agents.find((agent) => String(agent && agent.name ? agent.name : '').trim() === cfg.ticketWorker);
  const agentId = match && typeof match.agentId === 'string' ? match.agentId.trim() : '';
  return agentId || null;
}

/**
 * @description Poll one ticket until the queue manager moves it off the queued state.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @param ticketId - The synthetic ticket's id.
 * @returns { status, refusal } - status is null when the ticket could not be read back as its owner.
 */
async function awaitTicketMove(cfg, token, ticketId) {
  const deadline = Date.now() + cfg.budgetMs;
  let status = cfg.queuedState;
  let refusal = '';
  while (Date.now() < deadline) {
    await sleep(cfg.pollMs);
    const read = await call(cfg, `/api/tickets/${ticketId}`, { token });
    if (read.status !== 200) return { status: null, refusal };
    status = read.body.status || status;
    refusal = ticketRefusal(read.body) || refusal;
    if (status !== cfg.queuedState) return { status, refusal };
  }
  return { status, refusal };
}

/**
 * @description Create one synthetic queued ticket pinned to the workflow's declared owner, require
 * the queue to dispatch it without parking it in a failed state, then cancel and delete it so the
 * board is left exactly as it was found.
 *
 * The pin is the correction this check needed. Unpinned, a 'task' ticket routes by the ADR-083
 * call-out and lands on whichever knowledge owner wins the bid - an INLINE bot on 2026-09-15/16,
 * which `dispatch-manifest-worker` refuses under signing ("Signed HTTP delegation requires a
 * dedicated bot-node endpoint"). A deploy gate whose target changes per run is not a gate, so this
 * one names its worker and that worker is a dedicated bot node. It is still the workflow's OWN
 * declared owner - the check does not reach for a bot the ticket type would never use.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @returns { ok, detail } - ok when the ticket left the queued state into a non-failed status.
 */
async function pushTicket(cfg, token) {
  const workerAgentId = await resolveWorkerAgentId(cfg, token);
  if (!workerAgentId) {
    return { ok: false, detail: `no active agent named '${cfg.ticketWorker}' in GET /api/agents - the dispatch check has no dedicated bot node to pin` };
  }
  const created = await call(cfg, '/api/tickets/', {
    method: 'POST',
    token,
    body: JSON.stringify({
      title: `deploy verification ${new Date().toISOString()}`,
      description: 'Synthetic post-deploy check from scripts/lib/deploy-verify.sh. It is cancelled and deleted as soon as the queue moves it; no work is expected of the assigned bot.',
      ticketType: cfg.ticketType,
      status: cfg.queuedState,
      priority: 'low',
      metadata: { targetAgentId: workerAgentId },
    }),
  });
  const ticketId = created.body.ticketId;
  if (!ticketId) {
    return { ok: false, detail: `POST /api/tickets returned HTTP ${created.status}${created.body.error ? ` ${created.body.error}` : ''} and no ticketId` };
  }
  const target = `ticket ${ticketId} (${cfg.ticketType} -> ${cfg.ticketWorker})`;
  try {
    const { status, refusal } = await awaitTicketMove(cfg, token, ticketId);
    const because = refusal ? `: ${refusal}` : '';
    if (status === null) return { ok: false, detail: `${target} could not be read back as its own owner` };
    if (status === cfg.queuedState) return { ok: false, detail: `${target} sat at '${cfg.queuedState}' for ${Math.round(cfg.budgetMs / 1000)}s - the queue never dispatched it${because}` };
    if (cfg.failedStates.has(status)) return { ok: false, detail: `${target} was dispatched and landed in '${status}'${because}` };
    return { ok: true, detail: `${target} moved '${cfg.queuedState}' -> '${status}'` };
  } finally {
    // The cancel is a courtesy that stops work on a ticket nobody wants worked; it leaves nothing
    // behind when the delete below succeeds, so it is not reported. The DELETE is the step that
    // actually removes the row, and a silent failure there accumulates synthetic tickets on the
    // operator's board invisibly - so that one says so at error level and names what was left.
    await call(cfg, `/api/tickets/${ticketId}/cancel`, { method: 'PUT', token, body: JSON.stringify({}) }).catch(() => ({}));
    await cleanUp(cfg, `/api/tickets/${ticketId}`, { method: 'DELETE', token },
      `synthetic ${cfg.ticketType} ticket ${ticketId} is still on the board`);
  }
}

const CHECKS = { jarvis: askJarvis, ticket: pushTicket };

/**
 * @description Decide which of THREE outcomes one failed check is, and say so in the detail line.
 *
 * Exit 3 - "not verifiable from automation" - is granted only when every one of these holds:
 *   1. the check failed (a pass is never reclassified);
 *   2. controller signing is configured in this container (absent it, this refusal is a real bug);
 *   3. the check is running on the PAT it minted for itself from the service secret (an operator
 *      who supplied a token asserted a verified identity - if it still refuses, that token is the
 *      fault and the deploy must hear about it); and
 *   4. the refusal is EXACTLY {@link UNVERIFIABLE_REFUSAL}.
 *
 * Every other failure stays exit 1. That narrowness is the whole point: a third state wide enough
 * to swallow a product outage is worse than no check at all, because it reads as green.
 * @param verdict - The raw { ok, detail } the check produced.
 * @param cfg - Resolved configuration, for the signing and identity facts above.
 * @returns The verdict with the process exit code and, for exit 3, the reason it is not a FAIL.
 */
function classifyVerdict(verdict, cfg) {
  if (verdict.ok) return { ...verdict, code: 0 };
  if (!String(verdict.detail || '').includes(UNVERIFIABLE_REFUSAL)) return { ...verdict, code: 1 };
  if (!cfg.signing) {
    return { ...verdict, code: 1, detail: `${verdict.detail} - and this controller has no signing material configured, so nothing should be demanding a delegation issuer` };
  }
  if (cfg.operatorToken) {
    return { ...verdict, code: 1, detail: `${verdict.detail} - the PAT supplied in OSHAL_VERIFY_OPERATOR_PAT carries no verified principal issuer; only a mint made from a signed-in session records one` };
  }
  return {
    ...verdict,
    code: 3,
    detail: `${verdict.detail} - NOT VERIFIABLE FROM AUTOMATION: delegation signing is configured and the only identity this check can mint for itself, a service-secret PAT, records no principal issuer by design (cli-token-routes.ts). Nothing is proved either way about this deployment's product health - supply OSHAL_VERIFY_OPERATOR_PAT to verify it for real.`,
  };
}

/**
 * @description Run one named check as the operator. An operator-supplied PAT
 * (OSHAL_VERIFY_OPERATOR_PAT) is used as-is and never revoked - it is the operator's own durable
 * credential and the only kind that carries a verified principal issuer. Otherwise a time-boxed PAT
 * is minted from the service secret already in this process's environment and revoked by id
 * whatever happens. Neither token ever leaves this process.
 * @param name - 'jarvis' or 'ticket'.
 * @returns { ok, detail, code } - code is the process exit code the CLI wrapper uses.
 */
async function runCheck(name) {
  const check = CHECKS[name];
  if (!check) return { ok: false, code: 1, detail: `unknown check '${name || ''}' - expected one of: ${Object.keys(CHECKS).join(', ')}` };
  const cfg = readConfig();
  if (cfg.operatorToken) {
    return classifyVerdict(await check(cfg, cfg.operatorToken), cfg);
  }
  if (!cfg.secret) return { ok: false, code: 2, detail: 'SWARM_SERVICE_SECRET is not set in this container, so no operator token can be minted' };
  if (!cfg.subject) return { ok: false, code: 2, detail: 'no operator subject: OSHAL_OPERATOR_SUBS is empty in this container' };
  const mint = await call(cfg, '/api/cli-tokens', {
    method: 'POST',
    headers: { 'x-service-secret': cfg.secret, 'x-oshal-user-sub': cfg.subject },
    body: JSON.stringify({ label: `deploy-verify-${name}` }),
  });
  if (!mint.body.token) {
    return { ok: false, code: 1, detail: `could not mint an operator token (HTTP ${mint.status}${mint.body.error ? `, ${mint.body.error}` : ''})` };
  }
  try {
    return classifyVerdict(await check(cfg, mint.body.token), cfg);
  } finally {
    await call(cfg, `/api/cli-tokens/${mint.body.id}`, { method: 'DELETE', token: mint.body.token }).catch(() => ({}));
  }
}

/**
 * @description CLI wrapper: run the requested check, print its single detail line, and translate the
 * verdict into this process's exit code.
 * @returns Resolves once the detail line has been written.
 */
async function main() {
  const verdict = await runCheck(process.argv[2]).catch((error) => ({
    ok: false, code: 1, detail: `check aborted: ${error instanceof Error ? error.message : String(error)}`,
  }));
  console.log(verdict.detail);
  process.exitCode = verdict.code;
}

module.exports = { readConfig, runCheck, main, UNVERIFIABLE_REFUSAL };

if (require.main === module) void main();
