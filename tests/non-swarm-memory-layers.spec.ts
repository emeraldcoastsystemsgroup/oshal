/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright API regression coverage for checkpoint creation, agent memory persistence, and checkpoint restore
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DEFAULT_CHAT_AGENT_ID } from '@/features/chat-orchestration/constants/default-chat-agent';

const CONFIG_DIR = path.resolve(process.cwd(), process.env.CONFIG_OUTPUT_DIR ?? './output');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'global-config.json');

function readSettingsBackup(): string | null {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return null;
  }
  return fs.readFileSync(SETTINGS_PATH, 'utf8');
}

function writeStubSettings(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      mode: 'plan',
      planModeApiProvider: 'noop',
      planModeApiModelId: 'noop-v1',
      actModeApiProvider: 'noop',
      actModeApiModelId: 'noop-v1',
    }, null, 2),
    'utf8',
  );
}

function restoreSettings(originalContent: string | null): void {
  if (originalContent === null) {
    if (fs.existsSync(SETTINGS_PATH)) {
      fs.unlinkSync(SETTINGS_PATH);
    }
    return;
  }
  fs.writeFileSync(SETTINGS_PATH, originalContent, 'utf8');
}

test.describe('Non-Swarm Memory Layers', () => {
  test.setTimeout(180000);

  test('persists checkpoints and per-agent memory, then restores from a checkpoint', async ({ request }) => {
    const backup = readSettingsBackup();
    const taskId = randomUUID();

    try {
      writeStubSettings();

      const sendResponse = await request.post('/api/send-message', {
        data: {
          taskId,
          text: 'remember this build context for checkpoint restore testing',
          agenticMode: false,
          source: 'playwright-memory-layers',
          agentId: DEFAULT_CHAT_AGENT_ID,
        },
      });

      expect(sendResponse.ok()).toBeTruthy();
      const sendBody = await sendResponse.json();
      expect(sendBody.success).toBe(true);
      expect(sendBody.response).toContain('[noop]');

      const manualCheckpointResponse = await request.post(`/api/tasks/${taskId}/checkpoints`, {
        data: {
          label: 'Manual regression checkpoint',
          summary: 'Checkpoint created during Playwright regression coverage',
          metadata: { source: 'playwright' },
        },
      });
      expect(manualCheckpointResponse.ok()).toBeTruthy();

      const checkpointListResponse = await request.get(`/api/tasks/${taskId}/checkpoints`);
      expect(checkpointListResponse.ok()).toBeTruthy();
      const checkpointListBody = await checkpointListResponse.json();
      expect(checkpointListBody.count).toBeGreaterThanOrEqual(2);
      const checkpointId = checkpointListBody.checkpoints[0].checkpointId as string;

      const checkpointDetailResponse = await request.get(`/api/checkpoints/${checkpointId}`);
      expect(checkpointDetailResponse.ok()).toBeTruthy();
      const checkpointDetailBody = await checkpointDetailResponse.json();
      expect(checkpointDetailBody.checkpoint.taskId).toBe(taskId);

      const memoryListResponse = await request.get(`/api/memory/agents/${DEFAULT_CHAT_AGENT_ID}`);
      expect(memoryListResponse.ok()).toBeTruthy();
      const memoryListBody = await memoryListResponse.json();
      const matchingMemory = memoryListBody.memories.find((memory: { taskId: string }) => memory.taskId === taskId);
      expect(matchingMemory).toBeTruthy();
      expect(matchingMemory.summary).toContain('[noop]');

      const restoreResponse = await request.post(`/api/checkpoints/${checkpointId}/restore`);
      expect(restoreResponse.ok()).toBeTruthy();
      const restoreBody = await restoreResponse.json();
      expect(restoreBody.success).toBe(true);
      expect(restoreBody.task.taskId).toBe(taskId);
      expect(restoreBody.task.metadata.restoredFromCheckpointId).toBe(checkpointId);
    } finally {
      restoreSettings(backup);
    }
  });
});
