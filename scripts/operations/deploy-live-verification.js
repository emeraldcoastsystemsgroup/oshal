/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The loopback half of the post-deploy live verification (scripts/lib/deploy-verify.sh): ask Jarvis one fixed question as the operator, and put one synthetic ticket through the queue, on a stack that just reported DEPLOYED. Both halves failed on 2026-09-15 behind a deploy that reported success. Statuses and safe bodies only - never the token, the secret or the operator subject.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Read every knob at call time and export runCheck, so the guard can drive the real checks in-process against a real loopback server. The CLI shape is unchanged; the reason is that this host's firewall refuses a cross-process connection to a Node listener (curl reproduces it), so a spawned probe could only ever be tested against a doubled fetch. 
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Clean up what the check writes, and say so out loud when it cannot. The Jarvis half used to close its thread and leave the rest: POST /api/jarvis/ask registers the thread as a chat_tasks row (ensureSessionTask) and opens a chat-ticket, and /thread/close only marks that ticket complete - so every deploy left a chat row, a board card and its chat_messages behind forever, and a REFUSED ask leaked the row without even closing the thread (the row is written before the ownership gate; a refused thread sits at status 'created'). The ask response already carries chatTicketId, so the thread's ticket is deleted by id and the session task by DELETE /api/tasks/:taskId, which removes the row and its messages. Nothing is reused, so the bookmarked-thread refusal is not in play. Every cleanup step that does not succeed - here and on the synthetic ticket's delete - now reports at error level naming exactly what was left behind, on stderr so stdout stays the single verdict line. Cleanup runs after the verdict is decided and can never change it.
 */
// Runs INSIDE the api container on loopback, one check per invocation:
//   node deploy-live-verification.js jarvis   - ask Jarvis a fixed question as the operator
//   node deploy-live-verification.js ticket   - push one synthetic ticket through the queue
// Exit 0 = passed, 1 = failed, 2 = this box carries no operator identity to act as.
// Prints exactly one detail line. It never prints the minted token or the operator subject:
// the PAT is minted with the service secret already present in this container's environment,
// used on loopback, and revoked by id in a finally block.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    requestTimeoutMs: Number(process.env.OSHAL_VERIFY_REQUEST_TIMEOUT_MS || 20000),
    budgetMs: Number(process.env.OSHAL_VERIFY_BUDGET_MS || 300000),
    pollMs: Number(process.env.OSHAL_VERIFY_POLL_MS || 5000),
    question: process.env.OSHAL_VERIFY_QUESTION || 'Reply with the single word ready.',
    ticketType: process.env.OSHAL_VERIFY_TICKET_TYPE || 'task',
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
 * @description Poll one ticket until the queue manager moves it off the queued state.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @param ticketId - The synthetic ticket's id.
 * @returns The last observed status, or null when the ticket could not be read back.
 */
async function awaitTicketMove(cfg, token, ticketId) {
  const deadline = Date.now() + cfg.budgetMs;
  let status = cfg.queuedState;
  while (Date.now() < deadline) {
    await sleep(cfg.pollMs);
    const read = await call(cfg, `/api/tickets/${ticketId}`, { token });
    if (read.status !== 200) return null;
    status = read.body.status || status;
    if (status !== cfg.queuedState) return status;
  }
  return status;
}

/**
 * @description Create one synthetic queued ticket, require the queue to dispatch it without parking
 * it in a failed state, then cancel and delete it so the board is left exactly as it was found.
 * @param cfg - Resolved configuration.
 * @param token - The operator bearer token.
 * @returns { ok, detail } - ok when the ticket left the queued state into a non-failed status.
 */
async function pushTicket(cfg, token) {
  const created = await call(cfg, '/api/tickets/', {
    method: 'POST',
    token,
    body: JSON.stringify({
      title: `deploy verification ${new Date().toISOString()}`,
      description: 'Synthetic post-deploy check from scripts/lib/deploy-verify.sh. It is cancelled and deleted as soon as the queue moves it; no work is expected of the assigned bot.',
      ticketType: cfg.ticketType,
      status: cfg.queuedState,
      priority: 'low',
    }),
  });
  const ticketId = created.body.ticketId;
  if (!ticketId) {
    return { ok: false, detail: `POST /api/tickets returned HTTP ${created.status}${created.body.error ? ` ${created.body.error}` : ''} and no ticketId` };
  }
  try {
    const status = await awaitTicketMove(cfg, token, ticketId);
    if (status === null) return { ok: false, detail: `ticket ${ticketId} could not be read back as its own owner` };
    if (status === cfg.queuedState) return { ok: false, detail: `ticket ${ticketId} (${cfg.ticketType}) sat at '${cfg.queuedState}' for ${Math.round(cfg.budgetMs / 1000)}s - the queue never dispatched it` };
    if (cfg.failedStates.has(status)) return { ok: false, detail: `ticket ${ticketId} (${cfg.ticketType}) was dispatched and landed in '${status}'` };
    return { ok: true, detail: `ticket ${ticketId} (${cfg.ticketType}) moved '${cfg.queuedState}' -> '${status}'` };
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
 * @description Run one named check as the operator: mint a time-boxed personal access token from
 * the service secret already in this process's environment, run the check with it, and revoke it by
 * id whatever happens. The token never leaves this process.
 * @param name - 'jarvis' or 'ticket'.
 * @returns { ok, detail, code } - code is the process exit code the CLI wrapper uses.
 */
async function runCheck(name) {
  const check = CHECKS[name];
  if (!check) return { ok: false, code: 1, detail: `unknown check '${name || ''}' - expected one of: ${Object.keys(CHECKS).join(', ')}` };
  const cfg = readConfig();
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
    const verdict = await check(cfg, mint.body.token);
    return { ...verdict, code: verdict.ok ? 0 : 1 };
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

module.exports = { readConfig, runCheck, main };

if (require.main === module) void main();
