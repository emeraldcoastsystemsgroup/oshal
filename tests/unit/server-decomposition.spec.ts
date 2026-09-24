/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Server bootstrap decomposition guard (BACKLOG #1788): ensures server.ts, server-auxiliary-routes.ts, and server-bootstrap-tasks.ts remain under the 800 code-line decomposition threshold and 1000-line hard cap using ESLint max-lines semantics.
 * -----------------------------------------------------------------------------
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const ROOT = path.resolve(__dirname, '../..');
const SERVER_ENTRY = 'src/app/server.ts';
const AUXILIARY_ROUTES = 'src/app/server-auxiliary-routes.ts';
const BOOTSTRAP_TASKS = 'src/app/composition/server-bootstrap-tasks.ts';

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

function eslintCodeLines(rel: string): number {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(read(rel), [{
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser as never, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    rules: { 'max-lines': ['error', { max: 0, skipComments: true, skipBlankLines: true }] },
  }], { filename: path.join(ROOT, rel) });
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${rel}: ${fatal.message}`);
  const hit = messages.find((m) => m.ruleId === 'max-lines');
  const n = hit ? Number((/\((\d+)\)/.exec(hit.message) ?? [])[1]) : 0;
  if (!Number.isFinite(n)) throw new Error(`${rel}: could not read the max-lines count from "${hit?.message}"`);
  return n;
}

describe('Server bootstrap and route decomposition (BACKLOG #1788)', () => {
  it.each([SERVER_ENTRY, AUXILIARY_ROUTES, BOOTSTRAP_TASKS])(
    '%s stays under the 800-line decomposition threshold',
    (rel) => {
      expect(eslintCodeLines(rel)).toBeLessThan(800);
    },
  );

  it.each([SERVER_ENTRY, AUXILIARY_ROUTES, BOOTSTRAP_TASKS])(
    '%s stays under the 1000-line hard cap',
    (rel) => {
      expect(eslintCodeLines(rel)).toBeLessThan(1000);
    },
  );

  it('delegates extracted background tasks and route groups to auxiliary modules', () => {
    const serverSource = read(SERVER_ENTRY);
    expect(serverSource).toContain('runServerBootstrapTasks');
    expect(serverSource).toContain('mountPublicAndLegacyAuthRoutes');
    expect(serverSource).toContain('mountMainUiDocumentRoutes');
    expect(serverSource).toContain('mountProvidersAndConnectorsRoutes');
    expect(serverSource).toContain('mountDevopsAndJudgeRoutes');
    expect(serverSource).toContain('mountBudgetAndQueueRoutes');
    expect(serverSource).toContain('mountContentAndAssistantRoutes');
    expect(serverSource).toContain('mountCoreObservabilityAndVoiceRoutes');
    expect(serverSource).toContain('mountAgentDirectoryRoutes');
    expect(serverSource).toContain('mountGovernanceRoutes');
    expect(serverSource).toContain('mountWorkflowStudioRoutes');
    expect(serverSource).toContain('mountCoreTicketingRoutes');
    expect(serverSource).toContain('mountOpsTelemetryRoutes');
    expect(serverSource).toContain('mountSystemAuxiliaryRoutes');
  });
});
