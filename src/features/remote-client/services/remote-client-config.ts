/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added environment loader for the remote-client daemon
 */

import { z } from 'zod';
import { createChildLogger } from '@/shared/logger';
import { RemoteClientPlatformSchema } from '@/shared/types';
import { RemoteClientConfigSchema, type RemoteClientConfig } from '../types';

const logger = createChildLogger({ module: 'remote-client-config' });

/**
 * @description Parses a remote-client runtime configuration from environment variables.
 */
export function loadRemoteClientConfig(env: NodeJS.ProcessEnv = process.env): RemoteClientConfig {
  const parsed = RemoteClientConfigSchema.parse({
    clientId: env.REMOTE_CLIENT_ID || env.REMOTE_CLIENT_NAME || `remote-client-${process.pid}`,
    clientName: env.REMOTE_CLIENT_NAME || 'OSHAL remote client',
    controlPlaneUrl: env.REMOTE_CLIENT_CONTROL_PLANE_URL || 'http://localhost:3456',
    controlPlaneToken: env.REMOTE_CLIENT_CONTROL_PLANE_TOKEN || env.REMOTE_CLIENT_SHARED_SECRET || undefined,
    platform: normalizePlatform(env.REMOTE_CLIENT_PLATFORM || process.platform),
    transport: env.REMOTE_CLIENT_TRANSPORT || 'headscale-http',
    tailnetHostname: env.REMOTE_CLIENT_TAILNET_HOSTNAME || undefined,
    agentId: env.REMOTE_CLIENT_AGENT_ID || undefined,
    mcpCommand: env.REMOTE_CLIENT_MCP_COMMAND || 'mcp-server-macos-use',
    mcpArgs: parseArgs(env.REMOTE_CLIENT_MCP_ARGS),
    mcpCwd: env.REMOTE_CLIENT_MCP_CWD || undefined,
    heartbeatIntervalMs: parseInteger(env.REMOTE_CLIENT_HEARTBEAT_INTERVAL_MS, 10000),
    pollIntervalMs: parseInteger(env.REMOTE_CLIENT_POLL_INTERVAL_MS, 2500),
    disablePolling: parseBoolean(env.REMOTE_CLIENT_DISABLE_POLLING, false),
    authHeaderName: env.REMOTE_CLIENT_AUTH_HEADER || 'x-remote-client-key',
  });

  logger.info(
    {
      clientId: parsed.clientId,
      controlPlaneUrl: parsed.controlPlaneUrl,
      platform: parsed.platform,
      transport: parsed.transport,
      disablePolling: parsed.disablePolling,
    },
    'Loaded remote-client configuration',
  );

  return parsed;
}

/**
 * @description Normalizes host platform values into the supported schema.
 */
function normalizePlatform(value: string): z.infer<typeof RemoteClientPlatformSchema> {
  const lower = value.toLowerCase().trim();
  if (lower === 'darwin' || lower === 'mac' || lower === 'macos') {
    return 'macos';
  }
  if (lower === 'win32' || lower === 'windows') {
    return 'windows';
  }
  if (lower === 'linux') {
    return 'linux';
  }
  return 'unknown';
}

/**
 * @description Parses comma-separated or JSON array string arguments.
 */
function parseArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse remote-client MCP args JSON');
    }
  }

  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * @description Parses an integer environment variable with a fallback.
 */
function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description Parses a boolean environment variable with a fallback.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}
