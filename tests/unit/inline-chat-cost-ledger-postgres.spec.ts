/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for "Inline chat spend is invisible to windowed budget enforcement". The boundary that failed: the FORCE-RLS'd oshal_cost_events ledger (migrations 078/090/112) that BudgetService's trailing-window caps sum, which no inline chat turn ever wrote. Nothing on that boundary is doubled here — a disposable postgres:16-alpine, the real migrations, a NOSUPERUSER NOBYPASSRLS runtime role behind the production GUC wrapper, the REAL TaskOrchestrator, the REAL app-layer ledger binding (createInlineTurnCostLedger -> CostTrackingService) and the REAL BudgetService read. Doubled, outside the boundary: the LLM provider (a metered stub with an explicit price), the message store and the stream manager. Self-validated: an insert whose owner disagrees with the connection identity is refused with SQLSTATE 42501, so the fixture is enforcing rather than agreeing with itself. Docker is REQUIRED — a missing engine fails, never skips.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { LLMService, type LLMResponse, type SendRequestOptions, type TokenUsage, type CostResult } from '../../src/features/llm-provider/services/llm-service';
import { TaskOrchestrator, type TaskOrchestratorDeps } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { createInlineTurnCostLedger } from '../../src/app/composition/inline-turn-cost-ledger';
import { BudgetService } from '../../src/features/cost-governance/services/budget-service';
import { classifyCostUnit } from '../../src/features/cost-governance/services/cost-unit';

const OWNER = 'inline-owner-sub';
const OTHER = 'someone-else-sub';
const RUNTIME_ROLE = 'inline_ledger_runtime';
const RUNTIME_PASS = 'fixture-only';

/** Bot ids the fixture's getProvider maps to a provider; the id is what lands in agent_id. */
const METERED_BOT = 'bot-metered';
const CLI_BOT = 'bot-cli';
const BYO_BOT = 'bot-byo';

const METERED_TURN_USD = 0.25;
const CLI_TURN_USD = 0.079;

/**
 * A provider double with an EXPLICIT price. Outside the guarded boundary on purpose: the claim
 * is about where a turn's cost lands, not how a vendor prices it.
 */
class PricedStubProvider extends LLMService {
  constructor(name: string, private readonly turnUsd: number, private readonly modelName: string) {
    super(name, {});
  }

  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: `${this.provider} reply` }],
      usage: { inputTokens: 120, outputTokens: 30 },
      model: this.modelName,
    };
  }

  override calculateCost(_usage: TokenUsage): CostResult {
    return { inputCost: this.turnUsd * 0.8, outputCost: this.turnUsd * 0.2, totalCost: this.turnUsd, currency: 'USD' };
  }
}

const providers: Record<string, LLMService> = {
  [METERED_BOT]: new PricedStubProvider('metered-stub', METERED_TURN_USD, 'metered-model'),
  // The ids the CLI and BYO providers stamp in production (observed on the running box).
  [CLI_BOT]: new PricedStubProvider('claude-code', CLI_TURN_USD, 'claude-cli-model'),
  [BYO_BOT]: new PricedStubProvider('byo-hosted:user-model', 0, 'user-model'),
};

const fixture = new DisposablePostgres({
  purpose: 'inline-chat-cost-ledger',
  migrations: ['078-cost-governance.sql', '090-cost-event-tokens-duration.sql', '112-owner-column-rls.sql'],
});
let owner: Pool;
let runtime: Pool;
let orchestrator: TaskOrchestrator;
let budgets: BudgetService;

/** The REAL orchestrator over the REAL ledger binding; message store + stream manager are doubles. */
function buildOrchestrator(pool: Pool): TaskOrchestrator {
  const saved: Array<Record<string, unknown>> = [];
  const deps = {
    taskStore: createMemoryOnlyTaskStore(),
    messageStore: {
      save: async (input: Record<string, unknown>) => {
        saved.push(input);
        return { ...input, messageId: `m-${saved.length}`, createdAt: new Date().toISOString() };
      },
      getRecent: async () => [],
    },
    streamManager: {
      associateTaskWithSession: () => undefined,
      broadcastTaskUpdate: () => undefined,
      broadcastMessage: () => undefined,
      broadcastError: () => undefined,
    },
    getProvider: (agentId?: string) => {
      const provider = agentId ? providers[agentId] : undefined;
      if (!provider) throw new Error(`fixture has no provider for agent ${agentId}`);
      return provider;
    },
    getTools: async () => [],
    executeTool: async () => 'ok',
    getSystemPrompt: async () => 'SYSTEM',
    costLedger: createInlineTurnCostLedger(pool),
  } as unknown as TaskOrchestratorDeps;
  return new TaskOrchestrator(deps);
}

/** One direct-mode chat turn as the message route issues it: inside the caller's request identity. */
async function chatTurn(sub: string, agentId: string, taskId: string): Promise<void> {
  const result = await runWithRequestIdentity({ sub, isOperator: false }, () =>
    orchestrator.processMessage(taskId, 'hello', {
      agenticMode: false, autoApprove: false, source: 'dashboard', agentId, userSub: sub, interactionMode: 'chat',
    } as never));
  expect(result.success).toBe(true);
}

const asOwner = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub, isOperator: false }, fn);

beforeAll(async () => {
  owner = await fixture.start();
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  const { host, port, database } = fixture.connection;
  runtime = wrapPoolWithGuc(new Pool({ host, port, database, user: RUNTIME_ROLE, password: RUNTIME_PASS, max: 4 }));
  orchestrator = buildOrchestrator(runtime);
  budgets = new BudgetService(runtime, { notify: async () => undefined });
}, 120_000);

afterAll(async () => {
  if (runtime) await runtime.end();
  await fixture.stop();
}, 60_000);

describe('inline chat spend reaches the windowed budget ledger (real Postgres, forced RLS)', () => {
  it('the fixture enforces: a ledger row whose owner disagrees with the connection identity is refused (42501)', async () => {
    const forced = await owner.query(
      "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'oshal_cost_events'",
    );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
    await expect(asOwner(OTHER, () => runtime.query(
      "INSERT INTO oshal_cost_events (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd) VALUES ('t-forged', $1, 'x', 'x', 'x', 1)",
      [OWNER],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('an inline turn appends a ledger row under the owner and the trailing-window user spend moves', async () => {
    expect(await asOwner(OWNER, () => budgets.computeSpend('user', OWNER, 24))).toBe(0);

    await chatTurn(OWNER, METERED_BOT, 'thread-metered');

    expect(await asOwner(OWNER, () => budgets.computeSpend('user', OWNER, 24))).toBeCloseTo(METERED_TURN_USD, 6);
    const rows = await owner.query(
      'SELECT task_id, owner_sub, agent_id, provider_id, model_id, cost_usd::float8 AS cost_usd, input_tokens, output_tokens, duration_ms FROM oshal_cost_events',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      task_id: 'thread-metered', owner_sub: OWNER, agent_id: METERED_BOT, provider_id: 'metered-stub',
      model_id: 'metered-model', cost_usd: METERED_TURN_USD, input_tokens: '120', output_tokens: '30',
    });
    expect(rows.rows[0].duration_ms).not.toBeNull();
  }, 30_000);

  it("a HARD daily cap now blocks the owner's next turn on inline spend alone; another owner is untouched", async () => {
    const set = await budgets.setBudget({ sub: 'fixture-operator', operator: true }, {
      scopeType: 'user', scopeKey: OWNER, dailyUsd: 0.1, hard: true, enabled: true,
    });
    expect(set.ok).toBe(true);

    const blocked = await asOwner(OWNER, () => budgets.checkBudget(OWNER));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('hard-cap-exceeded');
    expect(blocked.spend).toBeCloseTo(METERED_TURN_USD, 6);

    const other = await asOwner(OTHER, () => budgets.checkBudget(OTHER));
    expect(other.allowed).toBe(true);
  }, 30_000);

  it('the ledger stays walled: the same window read as another owner sees no inline spend', async () => {
    expect(await asOwner(OTHER, () => budgets.computeSpend('user', OWNER, 24))).toBe(0);
  });

  it('a CLI price-equivalent turn and a BYO tokens-only turn land labelled apart from metered spend', async () => {
    await chatTurn(OWNER, CLI_BOT, 'thread-cli');
    await chatTurn(OWNER, BYO_BOT, 'thread-byo');

    const rows = await owner.query(
      'SELECT task_id, provider_id, cost_usd::float8 AS cost_usd, input_tokens FROM oshal_cost_events ORDER BY id',
    );
    expect(rows.rows.map((r) => [r.task_id, r.provider_id, classifyCostUnit(r.provider_id as string)])).toEqual([
      ['thread-metered', 'metered-stub', 'billed'],
      ['thread-cli', 'claude-code', 'price-equivalent'],
      ['thread-byo', 'byo-hosted:user-model', 'byo'],
    ]);
    // BYO: $0 by design, but the call is on record with its tokens.
    expect(rows.rows[2]).toMatchObject({ cost_usd: 0, input_tokens: '120' });

    const split = await asOwner(OWNER, () => budgets.computeSpendByUnit('user', OWNER, 24));
    expect(split).not.toBeNull();
    expect(split!.billed).toBeCloseTo(METERED_TURN_USD, 6);
    expect(split!.priceEquivalent).toBeCloseTo(CLI_TURN_USD, 6);
    expect(split!.byo).toBe(0);
    expect(split!.total).toBeCloseTo(METERED_TURN_USD + CLI_TURN_USD, 6);
    // The enforcement sum is the plain ledger sum — the split never changes what a cap compares against.
    expect(await asOwner(OWNER, () => budgets.computeSpend('user', OWNER, 24))).toBeCloseTo(split!.total, 6);
  }, 30_000);
});
