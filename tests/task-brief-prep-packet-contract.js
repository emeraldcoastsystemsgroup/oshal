const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  TaskFolderService,
} = require('../src/features/swarm-orchestration/services/task-folder-service');
const {
  writeTaskBrief,
} = require('../src/features/swarm-orchestration/services/queue-manager-workspace-helpers');

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function main() {
  const workspaceRoot = path.join(process.cwd(), 'test-results-codex', 'task-brief-prep-packet-contract');
  ensureCleanDir(workspaceRoot);

  const taskFolderService = new TaskFolderService(workspaceRoot);
  taskFolderService.createTaskFolder('ticket-123', {
    status: 'in_process_design',
  });

  writeTaskBrief(
    {
      ticketId: 'ticket-123',
      title: 'Serious planning ticket',
      description: 'Ticket description for serious planning work.',
      metadata: {
        acceptanceCriteria: ['AC-1'],
        pmPrepPacket: [
          '# PM-PREP-PACKET',
          '',
          '## PM Instructions',
          '1. Read the packet first.',
        ].join('\n'),
      },
    },
    ['child-1', 'child-2'],
    taskFolderService,
  );

  const taskBriefPath = path.join(workspaceRoot, 'ticket-123', 'TASK-BRIEF.md');
  const prepPacketPath = path.join(workspaceRoot, 'ticket-123', 'PM-PREP-PACKET.md');

  assert.ok(fs.existsSync(taskBriefPath), 'TASK-BRIEF.md should be written');
  assert.ok(fs.existsSync(prepPacketPath), 'PM-PREP-PACKET.md should be written');

  const taskBrief = fs.readFileSync(taskBriefPath, 'utf8');
  const prepPacket = fs.readFileSync(prepPacketPath, 'utf8');

  assert.match(taskBrief, /If PM-PREP-PACKET\.md exists, read it before planning or setup work/i);
  assert.match(taskBrief, /child-1/);
  assert.match(prepPacket, /## PM Instructions/);
  assert.match(prepPacket, /Read the packet first/i);

  console.log('task-brief-prep-packet-contract: ok');
}

main();
