import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { seedPersonaAuthorizations } from '../../src/features/tool-switch/services/persona-authorization-seeder';

describe('persona authorization seeder', () => {
  it('normalizes legacy auth aliases and resolves snake_case persona tool names', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-persona-auth-'));
    const personaPath = path.join(tmpDir, 'travel-concierge.yaml');
    fs.writeFileSync(personaPath, [
      'name: travel-concierge',
      'role: Travel Concierge',
      'agent_id: agent-travel',
      'authorizations:',
      '  prepare_booking: "approval"',
      '  read_file: "enabled"',
      '  docker: "blocked"',
    ].join('\n'));

    const inserts: Array<{ agentId: string; toolId: string; authMode: string }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT name, tool_id FROM tools')) {
          return {
            rows: [
              { name: 'prepare-booking', tool_id: 'tool-booking' },
              { name: 'read-file', tool_id: 'tool-read' },
              { name: 'docker', tool_id: 'tool-docker' },
            ],
          };
        }
        if (sql.includes('INSERT INTO agent_tools')) {
          inserts.push({
            agentId: String(params[0]),
            toolId: String(params[1]),
            authMode: String(params[2]),
          });
          return { rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    try {
      await expect(seedPersonaAuthorizations(pool as never, 'agent-travel', personaPath)).resolves.toBe(3);
      expect(inserts).toEqual([
        { agentId: 'agent-travel', toolId: 'tool-booking', authMode: 'ask' },
        { agentId: 'agent-travel', toolId: 'tool-read', authMode: 'auto' },
        { agentId: 'agent-travel', toolId: 'tool-docker', authMode: 'off' },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
