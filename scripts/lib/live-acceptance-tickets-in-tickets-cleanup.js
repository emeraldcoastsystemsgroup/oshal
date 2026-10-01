/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cleanup for the tickets-in-tickets live case, in order: cancel what is unfinished; wait until no child's unit work item is still assigned (a node call cannot be aborted, and its engine writes the root folder until it returns), keeping everything in place if the wait runs out; delete the leftovers anchored to the root (work items, their swarm runs, governance, DLQ and escalation rows); delete the children; delete the shadow tickets the pipeline upserted for the run's ids (ownerless, so through the operator's list); delete the root only when its linked workspace is the one this run created (deleting the root removes that workspace's folder); then, after a settle wait, prove every id gone, the residue zero and the folder removed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes before the first live run. The node wait also covers the root's in-process planning round, whose return writes the plan file. Every step records through the ledger, so one failed call no longer abandons the rest or hides the misses; a cancel that did not land is an error. The root, and with it the folder, is deleted only when every child was verified gone, and only when the tree read proves the root is this case's own. Shadow tickets are read in pages and re-checked after the deletes. The residue check covers only what was removed, so a deliberate keep is not also reported as a return.
 */

'use strict';

const common = require('./live-acceptance-common.js');

/** Ticket states a cancel cannot move; such tickets are left as they are. */
const TERMINAL = new Set(['complete', 'customer_action', 'cancelled', 'escalated', 'dead_letter']);
/** The title prefix every root this case files carries; the SQL anchors use the same prefix. */
const TITLE_PREFIX = 'testlab-live-tickets-in-tickets-';
/** Shadow tickets are read in pages of this size, so one read never carries the whole backlog. */
const SHADOW_PAGE = 200;

/**
 * @description The run's tickets as they stand: the root and its children.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @returns {Promise<object[]>} Ticket rows (empty once the root is gone, or when it is not this case's).
 */
async function readTree(io, rootId) {
  return (await io.sql('tickets-in-tickets.tree', [io.ownerSub, rootId])).rows;
}

/**
 * @description The work-item unit ids whose `assigned` status means a call is in flight: each
 * child's execution unit, and the root's in-process planning round (its return writes the plan file).
 * @param {string} rootId - The root.
 * @param {string[]} childIds - The children.
 * @returns {Set<string>} The unit ids.
 */
function inFlightUnits(rootId, childIds) {
  return new Set([`${rootId}-phase-2-round-1`, ...childIds.map((id) => `${id}-unit-1`)]);
}

/**
 * @description Cancel every unfinished ticket of the run, children first. A cancel that neither
 * answers 200 nor leaves the ticket terminal is recorded as an error.
 * @param {object} io - Ports.
 * @param {object[]} tickets - Ticket rows, children before the root.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when every cancel was sent and checked.
 */
async function cancelUnfinished(io, tickets, ledger) {
  for (const ticket of tickets) {
    if (TERMINAL.has(ticket.status)) continue;
    await ledger.attempt(`ticket ${ticket.ticket_id} cancel`, async () => {
      const res = await io.api('PUT', `/api/tickets/${ticket.ticket_id}/cancel`, {});
      if (res.status === 200) return null;
      const after = await io.api('GET', `/api/tickets/${ticket.ticket_id}`);
      const status = after.json && after.json.status;
      return TERMINAL.has(status) ? null : `cancelling ticket ${ticket.ticket_id} answered HTTP ${res.status} and it is ${status || 'unreadable'}`;
    });
  }
}

/**
 * @description Wait until no in-flight unit of the run is still assigned to a node. A read that
 * fails ends the wait as "still running", so nothing is removed under a node whose state is unknown.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {string[]} childIds - The children.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<boolean>} True when every node call has returned.
 */
async function awaitNodeCalls(io, rootId, childIds, ledger) {
  const units = inFlightUnits(rootId, childIds);
  let failure = null;
  const outcome = await common.pollUntil(io, { budgetMs: io.budgets.settleBudgetMs, pollMs: io.budgets.pollMs }, async () => {
    try {
      const items = (await io.sql('tickets-in-tickets.work-items', [io.ownerSub, rootId])).rows;
      return { done: !items.some((item) => units.has(item.unit_id) && item.status === 'assigned') };
    } catch (error) {
      failure = common.errorText(error);
      return { done: true };
    }
  });
  if (failure) {
    ledger.error(`reading the run's work items while waiting for its node calls failed: ${failure}`);
    return false;
  }
  return outcome.done;
}

/**
 * @description Delete one ticket through the API and prove it gone.
 * @param {object} io - Ports.
 * @param {string} kind - Its ledger kind.
 * @param {string} id - The ticket.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<boolean>} True when the ticket is verified gone.
 */
async function deleteTicket(io, kind, id, ledger) {
  let gone = false;
  await ledger.attempt(`${kind} ${id} delete`, async () => {
    const res = await io.api('DELETE', `/api/tickets/${id}`);
    if (res.status !== 200 && res.status !== 404) return `deleting ${kind} ${id} answered HTTP ${res.status}`;
    const after = await io.api('GET', `/api/tickets/${id}`);
    if (after.status !== 404) return `${kind} ${id} is still readable after its delete (HTTP ${after.status})`;
    ledger.removed(kind, id);
    gone = true;
    return null;
  });
  return gone;
}

/**
 * @description The internal tickets the pipeline upserted for the run's ids: ownerless backlog
 * tickets with provider `direct` whose external id is one of the run's ticket ids. They have no
 * owner, so only the operator's list reaches them, read in pages.
 * @param {object} io - Ports.
 * @param {string[]} runIds - The root and children.
 * @returns {Promise<object[]>} The shadow tickets found.
 */
async function listShadows(io, runIds) {
  const shadows = [];
  for (let offset = 0; ; offset += SHADOW_PAGE) {
    const res = await io.api('GET', `/api/tickets?status=backlog&scope=all&limit=${SHADOW_PAGE}&offset=${offset}`);
    if (res.status !== 200) throw new Error(`listing backlog tickets (offset ${offset}) answered HTTP ${res.status}`);
    const page = Array.isArray(res.json && res.json.tickets) ? res.json.tickets : [];
    shadows.push(...page.filter((t) => t.externalProvider === 'direct' && runIds.includes(t.externalId) && !t.ownerSub));
    if (page.length < SHADOW_PAGE) return shadows;
  }
}

/**
 * @description Delete the run's shadow tickets.
 * @param {object} io - Ports.
 * @param {string[]} runIds - The root and children.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function deleteShadowTickets(io, runIds, ledger) {
  let shadows = [];
  await ledger.attempt('shadow-ticket listing', async () => { shadows = await listShadows(io, runIds); return null; });
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
  if (!String(root.title).startsWith(TITLE_PREFIX)) return 'the root is not titled with this case tag';
  if (!root.workspaceId) return null;
  const ws = await io.api('GET', `/api/workspaces/${root.workspaceId}`);
  if (ws.status !== 200 || !ws.json) return `reading the root's workspace answered HTTP ${ws.status}`;
  const expected = `workspace-${String(root.title).slice(0, 50).replace(/[^a-zA-Z0-9-_]/g, '-')}`;
  if (ws.json.name !== expected) return `the root is linked to workspace "${String(ws.json.name).slice(0, 80)}", not the one its title names`;
  if (new Date(ws.json.createdAt).getTime() < new Date(root.createdAt).getTime()) return 'the root is linked to a workspace older than the root';
  return null;
}

/**
 * @description Delete the root, which also removes its folder, only when every child is gone and
 * its workspace is this run's.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {boolean} childrenGone - Whether every child was verified gone.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function deleteRoot(io, rootId, childrenGone, ledger) {
  if (!childrenGone) {
    ledger.error('a child could not be removed; the root and its folder were kept so a cleanup-only run can finish the job');
    return;
  }
  await ledger.attempt(`ticket ${rootId} read before delete`, async () => {
    const read = await io.api('GET', `/api/tickets/${rootId}`);
    if (read.status === 404) { ledger.removed('ticket', rootId); return null; }
    if (read.status !== 200 || !read.json) return `reading the root before its delete answered HTTP ${read.status}`;
    const refusal = await foreignWorkspace(io, read.json);
    if (refusal) return `${refusal}; the root and its folder were not deleted`;
    await deleteTicket(io, 'ticket', rootId, ledger);
    return null;
  });
}

/**
 * @description Whether the ledger records a ticket of the run as removed.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {string} id - The ticket.
 * @returns {boolean} True when removed.
 */
function removedTicket(ledger, id) {
  return ledger.entries.some((e) => e.kind === 'ticket' && e.id === id && e.state === 'removed');
}

/**
 * @description After the settle wait: every removed id unreadable, and when the root went, no
 * residue row, no shadow and no root folder. What was deliberately kept is not checked again.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {string[]} runIds - The root and children.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object>} The residue counts.
 */
async function confirmGone(io, rootId, runIds, ledger) {
  await io.sleep(io.budgets.residueWaitMs);
  for (const id of runIds.filter((candidate) => removedTicket(ledger, candidate))) {
    await ledger.attempt(`ticket ${id} residue`, async () => {
      const after = await io.api('GET', `/api/tickets/${id}`);
      return after.status === 404 ? null : `ticket ${id} is readable again after the settle wait (HTTP ${after.status})`;
    });
  }
  if (!removedTicket(ledger, rootId)) return {};
  let residue = {};
  await ledger.attempt('row residue', async () => {
    residue = (await io.sql('tickets-in-tickets.residue', [io.ownerSub, runIds])).rows[0] || {};
    const left = Object.entries(residue).filter(([, count]) => Number(count) > 0);
    return left.length ? `rows remain after the settle wait: ${left.map(([name, count]) => `${name} ${count}`).join(', ')}` : null;
  });
  await ledger.attempt('shadow-ticket residue', async () => {
    const left = await listShadows(io, runIds);
    return left.length ? `${left.length} shadow ticket(s) remain for the run's ids after the settle wait` : null;
  });
  await ledger.attempt('root folder residue', async () => {
    const folder = await io.files.dir('build.root', rootId);
    if (folder.exists) return 'the root folder still exists after the root was deleted';
    ledger.removed('workspace-folder', rootId);
    return null;
  });
  return residue;
}

/**
 * @description The run's tree, or why cleanup cannot start: the anchored read found no root, and
 * the id is either already gone (recorded as removed) or not a root this case filed for this caller.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object[]|null>} The tree, or null when nothing may be touched.
 */
async function anchoredTree(io, rootId, ledger) {
  let tree = null;
  await ledger.attempt('run tree read', async () => { tree = await readTree(io, rootId); return null; });
  if (!tree) return null;
  if (tree.some((t) => t.ticket_id === rootId)) return tree;
  const read = await io.api('GET', `/api/tickets/${rootId}`);
  if (read.status === 404) { ledger.removed('ticket', rootId); return null; }
  ledger.error(`ticket ${rootId} is not a root this case filed for this caller (HTTP ${read.status}); nothing was touched`);
  return null;
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
  const tree = await anchoredTree(io, rootId, ledger);
  if (!tree) return {};
  const children = tree.filter((t) => t.parent_ticket_id === rootId);
  const childIds = children.map((t) => t.ticket_id);
  for (const id of childIds) {
    if (!ledger.entries.some((e) => e.kind === 'ticket' && e.id === id)) ledger.created('ticket', id, 'a child planned from the run root');
  }
  await cancelUnfinished(io, [...children, ...tree.filter((t) => t.ticket_id === rootId)], ledger);
  if (!(await awaitNodeCalls(io, rootId, childIds, ledger))) {
    ledger.error(`a node call of the run was still running after ${io.budgets.settleBudgetMs / 1000} s; the root, its children and the folder were left in place`);
    return {};
  }
  let removed = {};
  await ledger.attempt('leftover rows delete', async () => {
    removed = (await io.sql('tickets-in-tickets.delete-leftovers', [io.ownerSub, rootId])).rows[0] || {};
    return null;
  });
  let childrenGone = true;
  for (const id of childIds) childrenGone = (await deleteTicket(io, 'ticket', id, ledger)) && childrenGone;
  const runIds = [rootId, ...childIds];
  await deleteShadowTickets(io, runIds, ledger);
  await deleteRoot(io, rootId, childrenGone, ledger);
  const residue = await confirmGone(io, rootId, runIds, ledger);
  return { ...removed, residue };
}

module.exports = { cleanup, readTree, cancelUnfinished, foreignWorkspace, awaitNodeCalls, deleteShadowTickets, listShadows };
