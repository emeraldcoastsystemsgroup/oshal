const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  InMemoryTicketStore,
} = require('../src/features/ticketing/services/in-memory-ticket-store');
const {
  TicketService,
} = require('../src/features/ticketing/services/ticket-service');
const {
  QueueManagerService,
} = require('../src/features/swarm-orchestration/services/queue-manager-service');
const {
  TaskFolderService,
} = require('../src/features/swarm-orchestration/services/task-folder-service');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

async function main() {
  const workspaceRoot = path.join(process.cwd(), 'test-results-codex', 'queue-phase-zero-contract');
  ensureCleanDir(workspaceRoot);

  const ticketStore = new InMemoryTicketStore();
  const ticketService = new TicketService(ticketStore);
  const taskFolderService = new TaskFolderService(workspaceRoot);
  const processCalls = [];

  const swarmProcessingService = {
    async getRuntimeReadiness() {
      return { ready: true };
    },
    async processTickets(items) {
      const item = items[0];
      processCalls.push(item.externalId);

      if (processCalls.length === 1) {
        return {
          processedCount: 1,
          processed: [{
            externalId: item.externalId,
            title: item.title,
            selectedAgentId: 'project-manager',
            selectedStrategy: 'catch-all',
            workUnitCount: 1,
            planningDecomposition: [{
              title: 'Implement approved build',
              description: 'Build the implementation after human approval.',
              acceptanceCriteria: ['Build is complete'],
              workType: 'implementation',
              labels: ['build'],
            }],
            agentAssignments: [{
              subtaskTitle: 'Implement approved build',
              suggestedRole: 'code-developer',
            }],
          }],
        };
      }

      return {
        processedCount: 1,
        processed: [{
          externalId: item.externalId,
          title: item.title,
          selectedAgentId: 'code-developer',
          selectedStrategy: 'score',
          workUnitCount: 1,
        }],
      };
    },
  };

  const workspaceService = {
    async createWorkspace() {
      return { workspaceId: '11111111-1111-1111-1111-111111111111' };
    },
  };

  const queueManager = new QueueManagerService(
    ticketService,
    swarmProcessingService,
    {
      taskFolderService,
      workspaceService,
    },
  );

  const rootTicket = await ticketService.createTicket({
    title: 'Serious product ticket',
    description: 'Needs discovery, planning, and human approval before build.',
    status: 'approved',
    metadata: {
      recommendedPath: 'structured-project',
      planningMode: 'structured',
      outcomeType: 'integration',
    },
  });

  await queueManager.dispatchTicket(rootTicket);

  const hydratedRoot = await ticketService.getTicket(rootTicket.ticketId);
  assert.ok(hydratedRoot, 'root ticket should still exist');
  assert.equal(hydratedRoot.status, 'approval_required');

  const rootHistory = await ticketService.getStatusHistory(rootTicket.ticketId, 10);
  const rootStatuses = rootHistory.map((entry) => entry.toStatus);
  assert.ok(rootStatuses.includes('in_process_discovery'), 'root should enter phase 0 discovery first');
  assert.ok(rootStatuses.includes('approval_required'), 'root should stop in approval_required after planning');

  const childTickets = await ticketService.listTickets({ parentTicketId: rootTicket.ticketId });
  assert.equal(childTickets.length, 1, 'planning should create exactly one child build ticket in this fixture');
  assert.equal(childTickets[0].status, 'approved', 'child build ticket should remain approved/queued');

  const taskBriefPath = path.join(workspaceRoot, rootTicket.ticketId, 'TASK-BRIEF.md');
  assert.ok(fs.existsSync(taskBriefPath), 'root task brief should be written');
  const taskBrief = fs.readFileSync(taskBriefPath, 'utf8');
  assert.match(taskBrief, /\*\*Status:\*\* approval_required/i);
  assert.match(taskBrief, /human interaction \/ approval required/i);

  processCalls.length = 0;
  await queueManager.pollCycle();
  await sleep(50);
  assert.equal(processCalls.length, 0, 'approved child ticket should not dispatch while parent is awaiting approval');

  await ticketService.updateStatus(rootTicket.ticketId, 'in_process_build');
  await queueManager.pollCycle();
  await sleep(100);

  assert.equal(processCalls.length, 1, 'child ticket should dispatch once the parent enters build');
  assert.equal(processCalls[0], childTickets[0].ticketId);

  const hydratedChild = await ticketService.getTicket(childTickets[0].ticketId);
  assert.ok(hydratedChild, 'child ticket should still exist');
  assert.equal(hydratedChild.status, 'complete', 'child should complete after execution in this fixture');

  console.log('queue-phase-zero-contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
