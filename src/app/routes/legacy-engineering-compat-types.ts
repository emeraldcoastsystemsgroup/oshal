/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A4/TD-15: Extracted shared interfaces from legacy-engineering-compat-routes.ts (1082 → <1000 decomposition)
 */
import type express from 'express';
import type { AppContext } from '@/app/composition/app-context';
import type { ModelUsageStats, StoredTask } from '@/shared/types';
import type { InternalTicket } from '@/entities/ticket';
import type { RoutingAuditEntry, BreakoutChannel } from '@/features/operational-intelligence';
import type { SwarmRunRecord } from '@/features/swarm-orchestration';
import type { ScheduleRecord } from '@/features/scheduling';

/**
 * @description Row shape emitted by the legacy agent registry compatibility endpoint.
 */
export interface LegacyAgentRegistryRow {
  agent_id: string;
  agent_name?: string;
  status: 'idle' | 'busy' | 'processing' | 'offline';
  enabled: boolean;
  capabilities: string[];
  current_load: number;
  max_concurrent: number;
  port?: number;
  workspaces: string[];
  last_heartbeat?: string;
  lastHeartbeat?: string;
  ttl_seconds: number;
  ttl?: number;
  total_tokens?: number;
  total_cost?: number;
  total_requests?: number;
  latest_model?: string | null;
  usage_by_model?: Record<string, ModelUsageStats>;
}

/**
 * @description Aggregated runtime state collected from all OSHAL subsystems
 * for legacy engineering screen compatibility payloads.
 */
export interface RuntimeSnapshot {
  tasks: StoredTask[];
  tickets: InternalTicket[];
  runs: SwarmRunRecord[];
  workItems: Array<Record<string, unknown>>;
  routingDecisions: RoutingAuditEntry[];
  channels: BreakoutChannel[];
  schedules: ScheduleRecord[];
}

/**
 * @description Node shape emitted by the legacy health dashboard compatibility endpoint.
 */
export interface LegacyHealthDashboardNode {
  name: string;
  port?: number | null;
  emoji: string;
  type: string;
  category: 'agent' | 'service' | 'plane';
  links: Array<{ label: string; url: string }>;
  source: string;
  status?: string;
  capabilities?: string[];
  healthPath?: string;
  htmlHealthCheck?: boolean;
  noHttp?: boolean;
}

/**
 * @description Options for registering legacy engineering compatibility routes.
 */
export interface LegacyEngineeringCompatRoutesOptions {
  app: Pick<express.Application, 'get' | 'post' | 'use'>;
  requiresAuth: express.RequestHandler;
  ctx: Pick<AppContext, 'taskStore' | 'ticketService' | 'swarm'>;
}
