/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage proving direct project-manager chat intake creates a canonical internal ticket and dedicated linked task
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched regression coverage to the shared runtime provider config file so PM intake stays deterministic even though provider selection is global rather than per-agent
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const PROJECT_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';
const CONFIG_DIR = path.resolve(process.cwd(), process.env.CONFIG_OUTPUT_DIR ?? './output');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'global-config.json');

/**
 * @description Reads the current runtime provider settings backup.
 * @returns Raw JSON content or null when the file does not exist.
 */
function readSettingsBackup(): string | null {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return null;
  }
  return fs.readFileSync(SETTINGS_PATH, 'utf8');
}

/**
 * @description Forces the runtime provider onto the noop stub for deterministic ticket-intake tests.
 */
function writeStubSettings(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      mode: 'act',
      planModeApiProvider: 'noop',
      planModeApiModelId: 'noop-v1',
      actModeApiProvider: 'noop',
      actModeApiModelId: 'noop-v1',
    }, null, 2),
    'utf8',
  );
}

/**
 * @description Restores the runtime provider settings after the regression run.
 * @param originalContent - Original file contents or null when absent.
 */
function restoreSettings(originalContent: string | null): void {
  if (originalContent === null) {
    if (fs.existsSync(SETTINGS_PATH)) {
      fs.unlinkSync(SETTINGS_PATH);
    }
    return;
  }
  fs.writeFileSync(SETTINGS_PATH, originalContent, 'utf8');
}

test.describe('Project Manager Ticket Intake', () => {
  test.setTimeout(120000);

  test('direct PM chat creates a canonical internal ticket and dedicated linked task', async ({ request }) => {
    const originalSettings = readSettingsBackup();
    const requestedTaskId = randomUUID();

    try {
      writeStubSettings();

      const sendResponse = await request.post('/api/send-message', {
        data: {
          taskId: requestedTaskId,
          text: 'please create a ticket to build a website about dogs',
          agenticMode: false,
          source: 'swarmbot-chat',
          agentId: PROJECT_MANAGER_AGENT_ID,
        },
      });

      expect(sendResponse.ok()).toBeTruthy();
      const sendBody = await sendResponse.json();
      expect(sendBody.ticketCreated).toBe(true);
      expect(sendBody.ticketId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(sendBody.taskIdUsed).not.toBe(requestedTaskId);

      const ticketResponse = await request.get(`/api/tickets/${sendBody.ticketId}`);
      expect(ticketResponse.ok()).toBeTruthy();
      const ticket = await ticketResponse.json();
      expect(ticket.status).toBe('approved');
      expect(ticket.title).toContain('website about dogs');
      expect(ticket.metadata.projectId).toBe('default');
      expect(ticket.metadata.projectName).toBe('Default');

      const taskLinkResponse = await request.get(`/api/tickets/${sendBody.ticketId}/tasks`);
      expect(taskLinkResponse.ok()).toBeTruthy();
      const taskLinkBody = await taskLinkResponse.json();
      expect(taskLinkBody.count).toBeGreaterThan(0);
      expect(taskLinkBody.links.some((link: { taskId?: string; role?: string }) => (
        link.taskId === sendBody.taskIdUsed && link.role === 'primary'
      ))).toBe(true);

      const taskResponse = await request.get(`/api/tasks/${sendBody.taskIdUsed}`);
      expect(taskResponse.ok()).toBeTruthy();
      const task = await taskResponse.json();
      expect(task.title).toContain('website about dogs');
      expect(task.metadata.ticketId).toBe(sendBody.ticketId);
      expect(task.metadata.projectId).toBe('default');

      const messagesResponse = await request.get(`/api/${sendBody.taskIdUsed}/messages`);
      expect(messagesResponse.ok()).toBeTruthy();
      const messagesBody = await messagesResponse.json();
      expect(messagesBody.messages.some((message: { role?: string; text?: string }) => (
        message.role === 'user' && String(message.text || '').includes('create a ticket')
      ))).toBe(true);
    } finally {
      restoreSettings(originalSettings);
    }
  });
});
