/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove protected prompt authority names only exact non-system AUTO app grants and fails closed without turning them into native bot-node handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolRepository } from '@/entities/tool';
import { createBrokeredPromptAuthorizationResolver } from '@/app/prompt-authorization-resolver';

function repository(tools: Array<Record<string, unknown>>): AgentToolRepository {
  return { getAutoExecutableTools: vi.fn(async () => tools) } as unknown as AgentToolRepository;
}

describe('brokered prompt authorization', () => {
  it('names exact enabled application tools and their derived scopes', async () => {
    const resolver = createBrokeredPromptAuthorizationResolver(repository([
      { name: 'career_database', enabled: true, registeredBy: 'jobs-2026', skills: ['job-search'], authGroup: 'career' },
      { name: 'stock_quote', enabled: true, registeredBy: 'markets-app', skills: [], authGroup: '' },
      { name: 'bash', enabled: true, registeredBy: 'system', skills: ['shell'], authGroup: '' },
      { name: 'disabled_app_tool', enabled: false, registeredBy: 'app', skills: [], authGroup: '' },
    ]));

    await expect(resolver?.('career-bot')).resolves.toEqual({
      allowedTools: ['career_database', 'stock_quote'],
      scopes: ['tool:career_database', 'capability:job-search', 'auth-group:career', 'tool:stock_quote'],
    });
  });

  it('fails closed when the authoritative grant lookup fails', async () => {
    const failing = { getAutoExecutableTools: vi.fn(async () => { throw new Error('database unavailable'); }) } as unknown as AgentToolRepository;
    const resolver = createBrokeredPromptAuthorizationResolver(failing);

    await expect(resolver?.('career-bot')).resolves.toEqual({
      allowedTools: [], scopes: ['authorization-resolution-failed'],
    });
  });
});
