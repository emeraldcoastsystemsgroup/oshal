/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the 2026-10-01 fault where Jarvis could not plan a multi-step request: every live turn was 37,816 characters against the bot node's 24,000-character untrusted window, and the multi-app plan guidance, the open work and 23 of the 40 catalog entries sat past the cut. A real authenticated /api/jarvis/ask turn is driven at production size (a 40-entry catalog, eight 1,500-character open-work results, six application tool proposals sized like the live ones, a Haven preamble) and the prompt the model was handed is passed through the REAL prompt containment the node applies; the plan guidance, the last catalog entry, the tool guardrails and the question must all be inside the kept window. The application tool proposals spend their full JSON only on the tools the ask is about.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The catalog lists every route (it was capped at 40), so the production-sized turn now asserts all 40 store apps reach the model alongside the curated routes, with the last catalog line still inside the kept window.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { describe, it, expect, vi } from 'vitest';

// Only model execution, the brain-selection reads, the Haven read and persistence are doubles: the
// context assembly and the containment under test are the shipped ones.
const executeBot = vi.hoisted(() => vi.fn());
const HAVEN_PREAMBLE = vi.hoisted(() => `[What you know about this user]\n${'- (preference) a durable fact about the user.\n'.repeat(54)}`);
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null), reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
// Same join as the real withHavenContext, so the preamble spends the window the way it does live.
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => `${HAVEN_PREAMBLE}\n\n---\n${prompt}`),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined), buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { PLAN_DIRECTIVE_GUIDANCE } from '@/app/routes/jarvis-orchestrator';
import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';
import type { JarvisPackageToolDiscovery, JarvisPackageToolService } from '../../src/app/routes/jarvis-package-tool-service';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { wrapUntrustedPromptContent } from '../../src/features/swarm-orchestration/services/prompt-containment';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|plan-window-owner';
const WINDOW = 24_000;
const GUARDRAIL = 'These are your ONLY shell tools';
const QUESTION = 'Look at my newest leads and then draft a post about the best one.';
/** The open-work block's own header; the catalog's FRESHNESS note also says "OPEN WORK". */
const OPEN_WORK = 'OPEN WORK — your recent tasks';

/** A schema with n described string fields: about 75 characters per field once serialized. */
function schema(fields: number): Record<string, unknown> {
  return { type: 'object', properties: Object.fromEntries(Array.from({ length: fields }, (_, i) =>
    [`field${i}`, { type: 'string', description: 'x'.repeat(40) }])) };
}

/** The six proposals offered on the live box, with their real keywords and schema sizes (658-3,139). */
const PROPOSALS: JarvisPackageToolDiscovery[] = [
  { app: 'calling-assistant', name: 'calling_task', label: 'Calling task', mode: 'ask', usage: '',
    description: 'Start, inspect or cancel an owner-configured phone task.', inputSchema: schema(9),
    keywords: ['phone-call', 'insurance-claim', 'ivr', 'human-handoff', 'swarm-app-tool', 'swarm-app:calling-assistant', 'runtime-registered'] },
  { app: 'capture-crm', name: 'capture_crm_read', label: 'Read Capture CRM', mode: 'auto', usage: 'u'.repeat(184),
    description: 'Read the caller\'s authorized government relationship records.', inputSchema: schema(6),
    keywords: ['government', 'capture', 'crm', 'opportunities', 'contracts', 'swarm-app-tool', 'swarm-app:capture-crm', 'runtime-registered'] },
  { app: 'capture-crm', name: 'capture_crm_action', label: 'Update Capture CRM', mode: 'ask', usage: 'u'.repeat(347),
    description: 'Create or update scoped CRM records.', inputSchema: schema(6),
    keywords: ['government', 'capture', 'crm', 'approval', 'option', 'swarm-app-tool', 'swarm-app:capture-crm', 'runtime-registered'] },
  { app: 'capture-crm', name: 'federal_crm_read', label: 'Read Federal CRM', mode: 'auto', usage: 'u'.repeat(293),
    description: 'Read authorized federal leads, opportunities and contacts.', inputSchema: schema(21),
    keywords: ['federal-crm', 'leads', 'contacts', 'government', 'crm', 'swarm-app-tool', 'swarm-app:capture-crm', 'runtime-registered'] },
  { app: 'capture-crm', name: 'federal_crm_action', label: 'Update Federal CRM', mode: 'ask', usage: 'u'.repeat(293),
    description: 'Perform one exact authorized CRM action.', inputSchema: schema(42),
    keywords: ['federal-crm', 'leads', 'contacts', 'government', 'crm', 'swarm-app-tool', 'swarm-app:capture-crm', 'runtime-registered'] },
  { app: 'gov-contracting', name: 'gov_capture_snapshot', label: 'Read existing Capture Board records', mode: 'ask', usage: 'u'.repeat(343),
    description: 'Read bounded existing capture board records.', inputSchema: schema(5),
    keywords: ['federal-capture', 'capture-board', 'government', 'read', 'swarm-app-tool', 'swarm-app:gov-contracting', 'runtime-registered'] },
];

/** The content the node would hand the model out of the contained record. */
function containedContent(text: string): string {
  const wrapped = wrapUntrustedPromptContent('direct-request', text);
  const json = wrapped.replace('<UNTRUSTED_CONTENT>', '').replace('</UNTRUSTED_CONTENT>', '');
  return String((JSON.parse(json) as { content: string }).content);
}

/** Rows for the catalog query (store apps) and the open-work query; nothing else is answered. */
function productionSizedQuery() {
  const apps = Array.from({ length: 40 }, (_, i) => ({
    name: `store-app-${String(i).padStart(2, '0')}`, display_name: `Store App ${i}`, jarvis_mode: null,
    agent_id: '15000000-0000-0000-0000-000000000001', selector: `Select for store app ${i} ONLY: ${'routing detail '.repeat(11)}`,
  }));
  const work = Array.from({ length: 8 }, (_, i) => ({
    id: `work-${i}`, user_sub: OWNER, session_id: null, ticket_id: null, briefing_source_id: null, principal_issuer: null,
    title: `Finished task ${i}`, status: 'done', kind: 'complex', result: 'r'.repeat(1_500), created_at: new Date().toISOString(),
  }));
  return vi.fn(async (sql: string) => {
    if (/FROM swarm_applications/i.test(sql)) return { rows: apps, rowCount: apps.length };
    if (/FROM jarvis_tasks WHERE user_sub/i.test(sql)) return { rows: work, rowCount: work.length };
    return { rows: [], rowCount: 0 };
  });
}

/** Run one real authenticated /ask turn and return the text the model was handed. */
async function promptForTurn(message: string): Promise<string> {
  const ctx = {
    pool: { query: productionSizedQuery() }, orchestrator: { processMessage: vi.fn() }, taskStore: createMemoryOnlyTaskStore(),
    messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]), createTicket: vi.fn(), updateStatus: vi.fn(),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'plan-window-chat' }),
    },
  };
  const packageTools = { discover: vi.fn().mockResolvedValue(PROPOSALS), readProposal: vi.fn() } as unknown as JarvisPackageToolService;
  const actor = { sub: OWNER, issuer: 'https://issuer.test', isActive: true, isSwarmAdmin: false };
  const auth: RequestHandler = (request, _response, next) => {
    (request as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OWNER } };
    runWithApplicationAuthorizationActor(actor, () => next());
  };
  executeBot.mockReset();
  executeBot.mockResolvedValue({ response: 'Hello.' });
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', auth, createJarvisRoutes(ctx as never, process.cwd(), undefined, packageTools));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`;
  try {
    const response = await fetch(base + '/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: 'plan-window-session' }),
    });
    expect(response.status).toBe(202);
    for (let attempt = 0; attempt < 400 && executeBot.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executeBot).toHaveBeenCalledTimes(1);
    return executeBot.mock.calls[0][3].text as string;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    purgeJarvisAskJobsForOwner(OWNER);
  }
}

describe('the multi-app plan guidance reaches the model on a production-sized Jarvis turn', () => {
  it('keeps the plan guidance, the whole catalog, the guardrails and the question inside the node window', async () => {
    const prompt = await promptForTurn(QUESTION);
    // The turn really is larger than the window, so the containment really truncates it here.
    expect(prompt.length).toBeGreaterThan(WINDOW);
    expect(prompt).toContain(OPEN_WORK);
    const catalogLines = prompt.slice(prompt.indexOf('ASSISTANT CATALOG'), prompt.indexOf(PLAN_DIRECTIVE_GUIDANCE))
      .split('\n').filter((line) => line.startsWith('- '));
    // Every route is listed now (the catalog was capped at 40); all 40 store apps must be there.
    expect(catalogLines.length).toBeGreaterThan(40);
    for (let i = 0; i < 40; i++) expect(prompt).toContain(`- store-app-${String(i).padStart(2, '0')}: `);
    const kept = containedContent(prompt);
    expect(kept).toContain(QUESTION);
    expect(kept).toContain(PLAN_DIRECTIVE_GUIDANCE);
    expect(kept).toContain(catalogLines[catalogLines.length - 1]);
    expect(kept).toContain(GUARDRAIL);
  });

  it('puts the plan guidance right after the catalog it refers to, and open work last', async () => {
    const prompt = await promptForTurn(QUESTION);
    const at = (text: string): number => prompt.indexOf(text);
    expect(at('ASSISTANT CATALOG')).toBeLessThan(at(PLAN_DIRECTIVE_GUIDANCE));
    expect(at(PLAN_DIRECTIVE_GUIDANCE)).toBeLessThan(at('YOUR TOOLS'));
    expect(at('YOUR TOOLS')).toBeLessThan(at(OPEN_WORK));
  });

  it('would have lost the plan guidance in the old order: tools, catalog, open work, then the plan', async () => {
    const prompt = await promptForTurn(QUESTION);
    const section = (from: string, to: number): string => prompt.slice(prompt.indexOf(from), to);
    const oldOrder = [section('YOUR TOOLS', prompt.indexOf(OPEN_WORK)),
      section('ASSISTANT CATALOG', prompt.indexOf(PLAN_DIRECTIVE_GUIDANCE)),
      section('OPEN WORK', prompt.lastIndexOf('\n\n---\n\n')), PLAN_DIRECTIVE_GUIDANCE].join('\n\n');
    expect(containedContent(`${HAVEN_PREAMBLE}\n\n---\n${QUESTION}\n\n---\n\n${oldOrder}`)).not.toContain(PLAN_DIRECTIVE_GUIDANCE);
  });
});

describe('application tool proposals spend their schema only on the tools the ask is about', () => {
  const proposalLines = (block: string): string[] => block.split('\n').filter((line) => /^- (\{|[a-z-]+\/)/.test(line));

  it('names every proposal in one line when the ask is about none of them', () => {
    const block = buildToolsBlock({ message: 'where am i', surface: 'jarvis', packageTools: PROPOSALS });
    expect(block).not.toContain('"inputSchema"');
    const lines = proposalLines(block);
    expect(lines).toHaveLength(PROPOSALS.length);
    for (const tool of PROPOSALS) expect(block).toContain(`- ${tool.app}/${tool.name} (${tool.label}, mode ${tool.mode})`);
    expect(lines.join('\n').length).toBeLessThan(2_000);
  });

  it('gives the full JSON of the tool the ask names, ranking the action ahead of the read', () => {
    const block = buildToolsBlock({ message: 'update the federal crm lead for acme', surface: 'jarvis', packageTools: PROPOSALS });
    const detailed = proposalLines(block).filter((line) => line.startsWith('- {'));
    expect(detailed.some((line) => line.includes('"name":"federal_crm_action"'))).toBe(true);
    // Both federal tools match; the two schemas together exceed the budget, so "update" decides.
    expect(block).toContain('- capture-crm/federal_crm_read (Read Federal CRM, mode auto)');
    expect(detailed.join('\n').length).toBeLessThanOrEqual(6_000 + detailed.length * 3);
    expect(block).toContain('- calling-assistant/calling_task (Calling task, mode ask)');
  });

  it('never treats the registry tags every package tool carries as relevance', () => {
    const block = buildToolsBlock({ message: 'swarm app tool runtime registered', surface: 'jarvis', packageTools: PROPOSALS });
    expect(block).not.toContain('"inputSchema"');
  });

  it('keeps every schema on a bare render, where relevance cannot be judged', () => {
    const block = buildToolsBlock({ packageTools: PROPOSALS });
    expect(proposalLines(block).filter((line) => line.startsWith('- {'))).toHaveLength(PROPOSALS.length);
  });
});
