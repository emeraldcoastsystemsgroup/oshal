/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provisioning script for imported google-bot and personal-finance-bot runtime backing
 */

import { Pool } from 'pg';
import pino from 'pino';
import { AgentConfigService } from '../src/features/agent-management/services/agent-config-service';
import { AgentToolRepository } from '../src/entities/tool/repositories/agent-tool-repository';
import { AuthMode, ToolAuthType } from '../src/shared/types/tool';
import type { ConfigField } from '../src/features/agent-management/services/capability-expansion-service';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'oshal',
  user: process.env.POSTGRES_USER || 'oshal',
  password: process.env.POSTGRES_PASSWORD || 'oshalpass',
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function main(): Promise<void> {
  const agentConfigService = new AgentConfigService(pool);
  const agentToolRepo = new AgentToolRepository(pool);

  const googleBotId = await resolveAgentId('google-bot');
  const financeBotId = await resolveAgentId('personal-finance-bot');

  const toolIds = await resolveToolIds([
    'gogcli',
    'google-search',
    'finance-import',
    'finance-report',
    'analyze-spending',
    'check-budget',
  ]);

  await agentConfigService.setConfigSchema(googleBotId, googleBotConfigSchema());
  await agentConfigService.setConfigSchema(financeBotId, financeBotConfigSchema());
  await agentConfigService.setConfigValues(financeBotId, {
    REPORT_FREQUENCY: 'monthly',
    ALERT_THRESHOLD: 500,
    LOOKBACK_DAYS: 90,
    ENABLE_FRAUD_DETECTION: true,
    SAVINGS_GOAL: 1000,
    BUDGET_TARGETS: {
      housing: 2000,
      food_dining: 800,
      shopping: 500,
      transportation: 400,
      entertainment: 200,
      healthcare: 300,
      financial: 500,
    },
  });

  await assignTool(agentToolRepo, googleBotId, toolIds.gogcli, AuthMode.ASK, {
    auth: {
      type: ToolAuthType.OAUTH2,
      enabled: true,
      oauth2: {
        flow: 'authorization_code',
        scopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/presentations',
          'https://www.googleapis.com/auth/calendar',
        ],
      },
    },
    metadata: {
      runtime: 'gogcli',
      botName: 'google-bot',
    },
  });
  await assignTool(agentToolRepo, googleBotId, toolIds['google-search'], AuthMode.AUTO);

  await assignTool(agentToolRepo, financeBotId, toolIds['finance-import'], AuthMode.ASK);
  await assignTool(agentToolRepo, financeBotId, toolIds['finance-report'], AuthMode.AUTO);
  await assignTool(agentToolRepo, financeBotId, toolIds['analyze-spending'], AuthMode.AUTO);
  await assignTool(agentToolRepo, financeBotId, toolIds['check-budget'], AuthMode.AUTO);

  logger.info({
    googleBotId,
    financeBotId,
    assignedTools: Object.keys(toolIds),
  }, 'Imported bot runtime provisioning complete');
}

async function resolveAgentId(agentName: string): Promise<string> {
  const result = await pool.query<{ agent_id: string }>(
    'SELECT agent_id FROM agents WHERE name = $1 LIMIT 1',
    [agentName],
  );
  const agentId = result.rows[0]?.agent_id;
  if (!agentId) {
    throw new Error(`Agent "${agentName}" was not found in the OSHAL registry.`);
  }
  return agentId;
}

async function resolveToolIds(toolNames: string[]): Promise<Record<string, string>> {
  const result = await pool.query<{ tool_id: string; name: string }>(
    'SELECT tool_id, name FROM tools WHERE name = ANY($1::text[])',
    [toolNames],
  );
  const byName = new Map(result.rows.map((row) => [row.name, row.tool_id]));

  for (const toolName of toolNames) {
    if (!byName.has(toolName)) {
      throw new Error(`Tool "${toolName}" is missing from the registry. Seed baseline tools first.`);
    }
  }

  return Object.fromEntries(toolNames.map((toolName) => [toolName, byName.get(toolName) as string]));
}

async function assignTool(
  repo: AgentToolRepository,
  agentId: string,
  toolId: string,
  authMode: AuthMode,
  toolConfig?: Record<string, unknown>,
): Promise<void> {
  await repo.setAuthMode(agentId, toolId, authMode);
  await repo.markInstalled(agentId, toolId);
  if (toolConfig) {
    await repo.setToolConfig(agentId, toolId, toolConfig);
  }
}

function googleBotConfigSchema(): ConfigField[] {
  return [
    {
      name: 'GOOGLE_CLIENT_ID',
      type: 'password',
      label: 'Google OAuth Client ID',
      required: true,
      placeholder: 'Paste the Google Cloud OAuth client ID',
    },
    {
      name: 'GOOGLE_CLIENT_SECRET',
      type: 'password',
      label: 'Google OAuth Client Secret',
      required: true,
      placeholder: 'Paste the Google Cloud OAuth client secret',
    },
    {
      name: 'GOOGLE_ACCOUNT_EMAIL',
      type: 'string',
      label: 'Google Account Email',
      required: false,
      placeholder: 'user@company.com',
    },
    {
      name: 'GOG_ACCOUNT',
      type: 'string',
      label: 'Default Google Profile Alias',
      required: false,
      placeholder: 'work',
    },
    {
      name: 'GOOGLE_SERVICE_ACCOUNT_JSON',
      type: 'textarea',
      label: 'Service Account JSON',
      required: false,
      placeholder: 'Optional Google Workspace service account JSON',
    },
    {
      name: 'GOOGLE_SERVICE_ACCOUNT_SUBJECT',
      type: 'string',
      label: 'Service Account Subject',
      required: false,
      placeholder: 'user@company.com for domain-wide delegation',
    },
    {
      name: 'GOOGLE_REDIRECT_PORT',
      type: 'number',
      label: 'OAuth Redirect Port',
      required: false,
      defaultValue: '8123',
      placeholder: '8123',
    },
    {
      name: 'GOOGLE_SCOPES',
      type: 'textarea',
      label: 'Override Google Scopes',
      required: false,
      placeholder: 'Space or comma separated OAuth scopes',
    },
  ];
}

function financeBotConfigSchema(): ConfigField[] {
  return [
    {
      name: 'FINANCE_CREDENTIALS',
      type: 'textarea',
      label: 'Finance Credentials JSON',
      required: false,
      placeholder: '{"institution":"...","username":"..."}',
    },
    {
      name: 'BUDGET_TARGETS',
      type: 'textarea',
      label: 'Budget Targets JSON',
      required: false,
      placeholder: '{"housing":2000,"food_dining":800}',
      defaultValue: '{"housing":2000,"food_dining":800,"shopping":500,"transportation":400,"entertainment":200,"healthcare":300,"financial":500}',
    },
    {
      name: 'REPORT_FREQUENCY',
      type: 'select',
      label: 'Report Frequency',
      required: false,
      defaultValue: 'monthly',
      options: ['weekly', 'monthly', 'both'],
    },
    {
      name: 'ALERT_THRESHOLD',
      type: 'number',
      label: 'Alert Threshold',
      required: false,
      defaultValue: '500',
      placeholder: '500',
    },
    {
      name: 'LOOKBACK_DAYS',
      type: 'number',
      label: 'Lookback Days',
      required: false,
      defaultValue: '90',
      placeholder: '90',
    },
    {
      name: 'ENABLE_FRAUD_DETECTION',
      type: 'boolean',
      label: 'Enable Fraud Detection',
      required: false,
      defaultValue: 'true',
    },
    {
      name: 'SAVINGS_GOAL',
      type: 'number',
      label: 'Savings Goal',
      required: false,
      defaultValue: '1000',
      placeholder: '1000',
    },
  ];
}

void main()
  .catch((error) => {
    logger.error({ err: error }, 'Imported bot runtime provisioning failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
