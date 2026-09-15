/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The loopback half of the post-deploy live verification (scripts/lib/deploy-verify.sh): ask Jarvis one fixed question as the operator, and put one synthetic ticket through the queue, on a stack that just reported DEPLOYED. Both halves failed on 2026-09-15 behind a deploy that reported success. Statuses and safe bodies only - never the token, the secret or the operator subject.
 */
// Runs INSIDE the api container on loopback, one check per invocation:
//   node deploy-live-verification.js jarvis   - ask Jarvis a fixed question as the operator
//   node deploy-live-verification.js ticket   - push one synthetic ticket through the queue
// Exit 0 = passed, 1 = failed, 2 = this box carries no operator identity to act as.
// Prints exactly one detail line. It never prints the minted token or the operator subject:
// the PAT is minted with the service secret already present in this container's environment,
// used on loopback, and revoked by id in a finally block.
const BASE = `http://127.0.0.1:${process.env.PORT || '5000'}`;
const SECRET = process.env.SWARM_SERVICE_SECRET || '';
const SUBJECT = (process.env.OSHAL_VERIFY_SUB || process.env.OSHAL_OPERATOR_SUBS || '')
  .split(',')[0]
  .trim();
const REQUEST_TIMEOUT_MS = Number(process.env.OSHAL_VERIFY_REQUEST_TIMEOUT_MS || 20000);
const BUDGET_MS = Number(process.env.OSHAL_VERIFY_BUDGET_MS || 300000);
const POLL_MS = Number(process.env.OSHAL_VERIFY_POLL_MS || 5000);
const QUESTION = process.env.OSHAL_VERIFY_QUESTION || 'Reply with the single word ready.';
const TICKET_TYPE = process.env.OSHAL_VERIFY_TICKET_TYPE || 'task';
// 'approved' is the only state the queue manager polls; anything else is never dispatched.
const QUEUED_STATE = process.env.OSHAL_VERIFY_TICKET_QUEUED_STATE || 'approved';
// The states that mean the dispatch itself failed. 'escalated' is where
// dispatch-manifest-worker parks a ticket after manifest_worker_dispatch_failed.
const FAILED_STATES = new Set(
  (process.env.OSHAL_VERIFY_TICKET_FAILED_STATES || 'escalated,dead_letter,failed,cancelled')
    .split(',')
    .map((state) => state.trim())
    .filter(Boolean),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @description One loopback request with a hard per-call timeout, returning status and parsed body
 * together so no caller has to decide whether a non-JSON error page is fatal.
 * @param path - API path beginning with a slash.
 * @param init - fetch init; `token` adds the caller's bearer authorization.
 * @returns The HTTP status and the parsed JSON body (an empty object when the body is not JSON).
 */
async function call(path, init = {}) {
  const { token, ...rest } = init;
  const headers = { ...(rest.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (rest.body) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    ...rest,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/**
 * @description Mint a personal access token for the operator subject, run the check with it, and
 * revoke it by id whatever happens. The token never leaves this process.
 * @param label - PAT label recorded on the row so an abandoned token is identifiable.
 * @param check - Receives the bearer token and resolves to { ok, detail }.
 * @returns The check's verdict, or a mint failure described without the secret.
 */
async function asOperator(label, check) {
  const mint = await call('/api/cli-tokens', {
    method: 'POST',
    headers: { 'x-service-secret': SECRET, 'x-oshal-user-sub': SUBJECT },
    body: JSON.stringify({ label }),
  });
  if (!mint.body.token) {
    return { ok: false, detail: `could not mint an operator token (HTTP ${mint.status}${mint.body.error ? `, ${mint.body.error}` : ''})` };
  }
  try {
    return await check(mint.body.token);
  } finally {
    await call(`/api/cli-tokens/${mint.body.id}`, { method: 'DELETE', token: mint.body.token })
      .catch(() => ({}));
  }
}

/**
 * @description Ask Jarvis one fixed question on a fresh thread and require a real answer, then close
 * the thread so the operator's board does not keep a verification card open.
 * @param token - The operator bearer token.
 * @returns { ok, detail } - ok only when the poll returns status 'done' with answer text.
 */
async function askJarvis(token) {
  const sessionId = `deploy-verify-${crypto.randomUUID()}`;
  const ask = await call('/api/jarvis/ask', { method: 'POST', token, body: JSON.stringify({ message: QUESTION, sessionId }) });
  if (!ask.body.jobId) {
    return { ok: false, detail: `POST /api/jarvis/ask returned HTTP ${ask.status}${ask.body.error ? ` ${ask.body.error}` : ''} and no jobId` };
  }
  const deadline = Date.now() + BUDGET_MS;
  let last = 'pending';
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const poll = await call(`/api/jarvis/ask/result?jobId=${encodeURIComponent(ask.body.jobId)}`, { token });
      last = poll.body.status || `HTTP ${poll.status}`;
      if (last === 'pending') continue;
      if (last === 'done' && typeof poll.body.answer === 'string' && poll.body.answer.trim()) {
        return { ok: true, detail: `Jarvis answered in ${Math.round((BUDGET_MS - (deadline - Date.now())) / 1000)}s (${poll.body.answer.trim().length} chars)` };
      }
      return { ok: false, detail: `Jarvis returned status '${last}'${poll.body.error ? `: ${poll.body.error}` : ' with no answer text'}` };
    }
    return { ok: false, detail: `Jarvis never answered within ${Math.round(BUDGET_MS / 1000)}s (last status '${last}')` };
  } finally {
    await call('/api/jarvis/thread/close', { method: 'POST', token, body: JSON.stringify({ sessionId }) }).catch(() => ({}));
  }
}

/**
 * @description Poll one ticket until the queue manager moves it off the queued state.
 * @param token - The operator bearer token.
 * @param ticketId - The synthetic ticket's id.
 * @returns The last observed status, or null when the ticket could not be read back.
 */
async function awaitTicketMove(token, ticketId) {
  const deadline = Date.now() + BUDGET_MS;
  let status = QUEUED_STATE;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const read = await call(`/api/tickets/${ticketId}`, { token });
    if (read.status !== 200) return null;
    status = read.body.status || status;
    if (status !== QUEUED_STATE) return status;
  }
  return status;
}

/**
 * @description Create one synthetic queued ticket, require the queue to dispatch it without parking
 * it in a failed state, then cancel and delete it so the board is left exactly as it was found.
 * @param token - The operator bearer token.
 * @returns { ok, detail } - ok when the ticket left the queued state into a non-failed status.
 */
async function pushTicket(token) {
  const title = `deploy verification ${new Date().toISOString()}`;
  const created = await call('/api/tickets/', {
    method: 'POST',
    token,
    body: JSON.stringify({
      title,
      description: 'Synthetic post-deploy check from scripts/lib/deploy-verify.sh. It is cancelled and deleted as soon as the queue moves it; no work is expected of the assigned bot.',
      ticketType: TICKET_TYPE,
      status: QUEUED_STATE,
      priority: 'low',
    }),
  });
  const ticketId = created.body.ticketId;
  if (!ticketId) {
    return { ok: false, detail: `POST /api/tickets returned HTTP ${created.status}${created.body.error ? ` ${created.body.error}` : ''} and no ticketId` };
  }
  try {
    const status = await awaitTicketMove(token, ticketId);
    if (status === null) return { ok: false, detail: `ticket ${ticketId} could not be read back as its own owner` };
    if (status === QUEUED_STATE) return { ok: false, detail: `ticket ${ticketId} (${TICKET_TYPE}) sat at '${QUEUED_STATE}' for ${Math.round(BUDGET_MS / 1000)}s - the queue never dispatched it` };
    if (FAILED_STATES.has(status)) return { ok: false, detail: `ticket ${ticketId} (${TICKET_TYPE}) was dispatched and landed in '${status}'` };
    return { ok: true, detail: `ticket ${ticketId} (${TICKET_TYPE}) moved '${QUEUED_STATE}' -> '${status}'` };
  } finally {
    await call(`/api/tickets/${ticketId}/cancel`, { method: 'PUT', token, body: JSON.stringify({}) }).catch(() => ({}));
    await call(`/api/tickets/${ticketId}`, { method: 'DELETE', token }).catch(() => ({}));
  }
}

const CHECKS = { jarvis: askJarvis, ticket: pushTicket };

/**
 * @description Entry point: resolve the requested check, refuse loudly when the inputs this box must
 * supply are absent, and translate the verdict into a process exit code.
 * @returns Resolves after the single detail line is written.
 */
async function main() {
  const name = process.argv[2];
  const check = CHECKS[name];
  if (!check) {
    console.log(`unknown check '${name || ''}' - expected one of: ${Object.keys(CHECKS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!SECRET) {
    console.log('SWARM_SERVICE_SECRET is not set in this container, so no operator token can be minted');
    process.exitCode = 2;
    return;
  }
  if (!SUBJECT) {
    console.log('no operator subject: OSHAL_OPERATOR_SUBS is empty in this container');
    process.exitCode = 2;
    return;
  }
  const verdict = await asOperator(`deploy-verify-${name}`, check);
  console.log(verdict.detail);
  process.exitCode = verdict.ok ? 0 : 1;
}

main().catch((error) => {
  console.log(`check aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
