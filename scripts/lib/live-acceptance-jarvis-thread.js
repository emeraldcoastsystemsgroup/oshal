/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - open and remove a fixture-tagged Jarvis conversation for the live-acceptance cases that need one (the Jarvis prompt-cache measurement; the developer-workspace case, whose package-tool proposals must name a Jarvis session the caller owns). A conversation is opened only through the real POST /api/jarvis/ask, which registers it owner- and issuer-bound exactly as the Jarvis surface does, and followed until Jarvis's answer is written into it (read through the caller's own /api/jarvis/history) and the bot has finished writing its ask workspace. Removal closes the thread, deletes its chat ticket and task, dismisses the job, removes the workspace, and proves from the database that nothing is left.
 */

'use strict';

const common = require('./live-acceptance-common.js');

/**
 * @description Follow one ask until an answer lands in its thread or the job errors.
 * @param {object} io - api, sleep, now.
 * @param {string} sessionId - The conversation.
 * @param {string} jobId - The ask's job.
 * @param {{answerBudgetMs: number, pollMs: number}} budgets - Bounds.
 * @returns {Promise<{delivered: boolean, answer: string, status: string, elapsedMs: number}>} What was seen.
 */
async function followAnswer(io, sessionId, jobId, budgets) {
  let status = 'pending';
  const seen = await common.pollUntil(io, { budgetMs: budgets.answerBudgetMs, pollMs: budgets.pollMs }, async () => {
    const job = await io.api('GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`);
    if (job.status === 200) status = String(job.json.status || status);
    const history = await io.api('GET', `/api/jarvis/history?sessionId=${encodeURIComponent(sessionId)}`);
    const turns = history.status === 200 && Array.isArray(history.json.turns) ? history.json.turns : [];
    const answer = turns.filter((t) => t && t.role !== 'user').map((t) => String(t.text || '')).join('\n').trim();
    return { done: Boolean(answer) || status === 'error', value: answer };
  });
  return { delivered: Boolean(seen.value), answer: String(seen.value || ''), status, elapsedMs: seen.elapsedMs };
}

/**
 * @description Open one fresh conversation through the real ask route and follow it to its answer
 * and to the end of the bot's workspace writes.
 * @param {object} io - api, workspace, sleep, now.
 * @param {string} sessionId - A fixture tag.
 * @param {string} message - What to ask.
 * @param {{answerBudgetMs: number, settleBudgetMs: number, pollMs: number}} budgets - Bounds.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{sessionId: string, jobId: string|null, chatTicketId: string|null, delivered: boolean, answer: string,
 *   answerSeconds: number|null, workspace: string|null, error?: string}>} The conversation.
 */
async function openConversation(io, sessionId, message, budgets, ledger) {
  if (!common.isFixtureTag(sessionId)) throw new Error(`refusing a non-fixture session id: ${sessionId}`);
  const ask = await io.api('POST', '/api/jarvis/ask', { message, sessionId });
  const jobId = typeof ask.json.jobId === 'string' ? ask.json.jobId : null;
  const chatTicketId = typeof ask.json.chatTicketId === 'string' ? ask.json.chatTicketId : null;
  ledger.created('jarvis-thread', sessionId);
  if (chatTicketId) ledger.created('chat-ticket', chatTicketId);
  if (ask.status !== 202 || !jobId) {
    return { sessionId, jobId, chatTicketId, delivered: false, answer: '', answerSeconds: null, workspace: null, error: `ask answered HTTP ${ask.status}: ${ask.json.error || 'no job'}` };
  }
  ledger.created('ask-job', jobId);
  const followed = await followAnswer(io, sessionId, jobId, budgets);
  const settled = await common.pollUntil(io, { budgetMs: budgets.settleBudgetMs, pollMs: budgets.pollMs }, async () => {
    const state = await io.workspace.state(sessionId);
    return { done: state !== 'running', value: state };
  });
  return { sessionId, jobId, chatTicketId, delivered: followed.delivered, answer: followed.answer,
    answerSeconds: Math.round(followed.elapsedMs / 1000), workspace: settled.value };
}

/**
 * @description Remove one conversation's thread, ticket, task, job and workspace.
 * @param {object} io - api, workspace.
 * @param {object} conversation - What openConversation returned.
 * @returns {Promise<string[]>} Problems; empty when every step answered as done.
 */
async function removeConversation(io, conversation) {
  const ok = async (method, route, body, codes) => codes.includes((await io.api(method, route, body)).status);
  const problems = [];
  if (!await ok('POST', '/api/jarvis/thread/close', { sessionId: conversation.sessionId }, [200, 404])) problems.push('thread close failed');
  if (conversation.chatTicketId && !await ok('DELETE', `/api/tickets/${encodeURIComponent(conversation.chatTicketId)}`, undefined, [200, 204, 404])) problems.push('chat ticket delete failed');
  if (!await ok('DELETE', `/api/tasks/${encodeURIComponent(conversation.sessionId)}`, undefined, [200, 204, 404])) problems.push('task delete failed');
  if (conversation.jobId && !await ok('POST', '/api/jarvis/ask/dismiss', { jobId: conversation.jobId }, [200, 404])) problems.push('job dismiss failed');
  if (conversation.workspace === 'running') problems.push('the bot was still writing the ask workspace; it was left');
  else {
    const removed = await io.workspace.remove(conversation.sessionId);
    if (removed) problems.push(removed);
  }
  return problems;
}

/**
 * @description Remove every conversation a run opened, then prove it from the database under the owner.
 * @param {object} io - api, sql, workspace, ownerSub.
 * @param {object[]} conversations - What openConversation returned, per conversation.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function closeConversations(io, conversations, ledger) {
  for (const conversation of conversations) {
    await ledger.attempt(`conversation ${conversation.sessionId}`, async () => {
      const problems = await removeConversation(io, conversation);
      if (conversation.jobId) ledger.removed('ask-job', conversation.jobId);
      return problems.length ? `${conversation.sessionId}: ${problems.join(', ')}` : null;
    });
  }
  if (!conversations.length) return;
  await ledger.attempt('conversation residue', async () => {
    const ids = conversations.map((c) => c.sessionId);
    const row = ((await io.sql('jarvis.residue', [io.ownerSub, ids])).rows || [])[0] || {};
    const left = Object.entries(row).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k}=${n}`);
    if (left.length) return `residue remains for ${ids.join(', ')}: ${left.join(', ')}`;
    for (const c of conversations) { ledger.removed('jarvis-thread', c.sessionId); if (c.chatTicketId) ledger.removed('chat-ticket', c.chatTicketId); }
    return null;
  });
}

module.exports = { followAnswer, openConversation, removeConversation, closeConversations };
