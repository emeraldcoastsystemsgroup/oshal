/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cleanup for the tickets-in-tickets live case, in order: cancel what is unfinished; wait until no child's unit work item is still assigned (a node call cannot be aborted, and its engine writes the root folder until it returns), keeping everything in place if the wait runs out; delete the leftovers anchored to the root (work items, their swarm runs, governance, DLQ and escalation rows); delete the children; delete the shadow tickets the pipeline upserted for the run's ids (ownerless, so through the operator's list); delete the root only when its linked workspace is the one this run created (deleting the root removes that workspace's folder); then, after a settle wait, prove every id gone, the residue zero and the folder removed.
 */

'use strict';

const common = require('./live-acceptance-common.js');

/** Ticket states a cancel cannot move; a 400 from the cancel route is expected for these. */
const TERMINAL = new Set(['complete', 'customer_action', 'cancelled', 'escalated', 'dead_letter']);

/**
 * @description The run's tickets as they stand: the root and its children.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @returns {Promise<object[]>} Ticket rows (empty once the root is gone).
 */
async function readTree(io, rootId) {
  return (await io.sql('tickets-in-tickets.tree', [io.ownerSub, rootId])).rows;
}

/**
 * @description Cancel every unfinished ticket of the run, children first.
 * @param {object} io - Ports.
 * @param {object[]} tickets - Ticket rows, children before the root.
 * @returns {Promise<void>} Resolves when every cancel was sent.
 */
async function cancelUnfinished(io, tickets) {
  for (const ticket of tickets) {
    if (!TERMINAL.has(ticket.status)) await io.api('PUT', `/api/tickets/${ticket.ticket_id}/cancel`, {});
  }
}

/**
 * @description Wait until no child's unit work item is still assigned to a node.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {string[]} childIds - The children.
 * @returns {Promise<boolean>} True when every node call has returned.
 */
async function awaitNodeCalls(io, rootId, childIds) {
  const units = new Set(childIds.map((id) => `${id}-unit-1`));
  const outcome = await common.pollUntil(io, { budgetMs: io.budgets.settleBudgetMs, pollMs: io.budgets.pollMs }, async () => {
    const items = (await io.sql('tickets-in-tickets.work-items', [io.ownerSub, rootId])).rows;
    return { done: !items.some((item) => units.has(item.unit_id) && item.status === 'assigned') };
  });
  return outcome.done;
}

/**
 * @description Delete one ticket through the API and prove it gone.
 * @param {object} io - Ports.
 * @param {string} kind - Its ledger kind.
 * @param {string} id - The ticket.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function deleteTicket(io, kind, id, ledger) {
  await ledger.attempt(`${kind} ${id} delete`, async () => {
    const res = await io.api('DELETE', `/api/tickets/${id}`);
    if (res.status !== 200 && res.status !== 404) return `deleting ${kind} ${id} answered HTTP ${res.status}`;
    const after = await io.api('GET', `/api/tickets/${id}`);
    if (after.status !== 404) return `${kind} ${id} is still readable after its delete (HTTP ${after.status})`;
    ledger.removed(kind, id);
    return null;
  });
}

/**
 * @description Delete the internal tickets the pipeline upserted for the run's ids: ownerless backlog
 * tickets with provider `direct` whose external id is one of the run's ticket ids.
 * @param {object} io - Ports.
 * @param {string[]} runIds - The root and children.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function deleteShadowTickets(io, runIds, ledger) {
  const res = await io.api('GET', '/api/tickets?status=backlog&scope=all');
  if (res.status !== 200) { ledger.error(`listing backlog tickets for the run's shadow tickets answered HTTP ${res.status}`); return; }
  const shadows = (res.json.tickets || []).filter((t) => t.externalProvider === 'direct' && runIds.includes(t.externalId) && !t.ownerSub);
  for (const shadow of shadows) {
    ledger.created('shadow-ticket', shadow.ticketId, 'the internal ticket the pipeline upserts for a run ticket');
    await deleteTicket(io, 'shadow-ticket', shadow.ticketId, ledger);
  }
}

/**
 * @description Whether the root's linked workspace is the one this run created: the name the queue
 * derives from the root's title, created no earlier than the root. createWorkspace reuses a workspace
 * of the same name, and deleting the root removes the linked workspace's folder, so anything else
 * must not be cascaded.
 * @param {object} io - Ports.
 * @param {object} root - The root ticket as GET /api/tickets/:id returns it.
 * @returns {Promise<string|null>} Why the root must not be deleted, or null.
 */
async function foreignWorkspace(io, root) {
  if (!root.workspaceId) return null;
  const ws = await io.api('GET', `/api/workspaces/${root.workspaceId}`);
  if (ws.status !== 200 || !ws.json) return `reading the root's workspace answered HTTP ${ws.status}`;
  const expected = `workspace-${String(root.title).slice(0, 50).replace(/[^a-zA-Z0-9-_]/g, '-')}`;
  if (ws.json.name !== expected) return `the root is linked to workspace "${String(ws.json.name).slice(0, 80)}", not the one its title names`;
  if (new Date(ws.json.createdAt).getTime() < new Date(root.createdAt).getTime()) return 'the root is linked to a workspace older than the root';
  return null;
}

/**
 * @description Delete the root, which also removes its folder, only when its workspace is this run's.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function deleteRoot(io, rootId, ledger) {
  const read = await io.api('GET', `/api/tickets/${rootId}`);
  if (read.status === 404) { ledger.removed('ticket', rootId); return; }
  if (read.status !== 200 || !read.json) { ledger.error(`reading the root before its delete answered HTTP ${read.status}`); return; }
  const refusal = await foreignWorkspace(io, read.json);
  if (refusal) { ledger.error(`${refusal}; the root and its folder were not deleted`); return; }
  await deleteTicket(io, 'ticket', rootId, ledger);
}

/**
 * @description After the settle wait: every id unreadable, no residue row, and the root folder gone.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {string[]} runIds - The root and children.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object>} The residue counts.
 */
async function confirmGone(io, rootId, runIds, ledger) {
  await io.sleep(io.budgets.residueWaitMs);
  for (const id of runIds) {
    const after = await io.api('GET', `/api/tickets/${id}`);
    if (after.status !== 404) ledger.error(`ticket ${id} is readable again after the settle wait (HTTP ${after.status})`);
  }
  const residue = (await io.sql('tickets-in-tickets.residue', [io.ownerSub, runIds])).rows[0] || {};
  const left = Object.entries(residue).filter(([, count]) => Number(count) > 0);
  if (left.length) ledger.error(`rows remain after the settle wait: ${left.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  const folder = await io.files.dir('build.root', rootId);
  if (folder.exists) ledger.error('the root folder still exists after the root was deleted');
  else ledger.removed('workspace-folder', rootId);
  return residue;
}

/**
 * @description Remove everything one run created, in the safe order, and prove it gone.
 * @param {object} io - Ports, with budgets.
 * @param {{rootId: string}} ctx - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object>} Counts of leftover rows removed, for evidence.
 */
async function cleanup(io, ctx, ledger) {
  const { rootId } = ctx;
  const tree = await readTree(io, rootId);
  const children = tree.filter((t) => t.parent_ticket_id === rootId);
  const childIds = children.map((t) => t.ticket_id);
  for (const id of childIds) {
    if (!ledger.entries.some((e) => e.kind === 'ticket' && e.id === id)) ledger.created('ticket', id, 'a child planned from the run root');
  }
  await cancelUnfinished(io, [...children, ...tree.filter((t) => t.ticket_id === rootId)]);
  if (!(await awaitNodeCalls(io, rootId, childIds))) {
    ledger.error(`a child's node call was still running after ${io.budgets.settleBudgetMs / 1000} s; the root, its children and the folder were left in place`);
    return {};
  }
  const removed = tree.length ? (await io.sql('tickets-in-tickets.delete-leftovers', [io.ownerSub, rootId])).rows[0] || {} : {};
  for (const id of childIds) await deleteTicket(io, 'ticket', id, ledger);
  const runIds = [rootId, ...childIds];
  await deleteShadowTickets(io, runIds, ledger);
  await deleteRoot(io, rootId, ledger);
  const residue = await confirmGone(io, rootId, runIds, ledger);
  return { ...removed, residue };
}

module.exports = { cleanup, foreignWorkspace, awaitNodeCalls, deleteShadowTickets };
