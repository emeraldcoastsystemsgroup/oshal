/**
 * A2A inbound gateway feature barrel (BACKLOG Plan F items 1+2 + the ticket bridge of 3).
 *
 * External third-party agents discover the swarm via the spec agent card
 * (/.well-known/agent-card.json), authenticate with operator-minted per-agent bearer
 * credentials (a2a_agents, sha256 at rest), and delegate work over JSON-RPC 2.0
 * (message/send | tasks/get | tasks/cancel). Inbound work becomes a REAL ticket on the
 * existing rails (ticketType 'task', ADR-083 call-out routing, ownerSub 'a2a:<id>').
 * The whole surface is a 404 no-op unless A2A_GATEWAY_ENABLED=true. In-swarm bots keep
 * using the Redis mesh — A2A is ONLY for external agents (CLAUDE.md two-paths rule).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the a2a-gateway slice.
 *
 * @module features/a2a-gateway
 */
export {
  A2A_PROTOCOL_VERSION,
  A2A_AGENT_CARD_PATH,
  A2A_SCOPES,
  SCOPE_FOR_METHOD,
  JSON_RPC_ERRORS,
  A2ATaskStateSchema,
  JsonRpcRequestSchema,
  A2AMessageSendParamsSchema,
  A2ATaskIdParamsSchema,
  mapTicketStateToA2A,
  specArtifactsFromMessages,
  type A2ATaskState,
  type A2AScope,
  type A2AAgentIdentity,
  type A2AAgentSkill,
  type A2ASpecAgentCard,
  type A2ASpecArtifact,
  type A2ASpecTask,
  type A2AMessageSendParams,
  type A2ATaskIdParams,
  type JsonRpcRequest,
} from './types';
export { isA2aGatewayEnabled, readMaxInboundPerHour } from './services/a2a-gateway-config';
export {
  buildAgentCard,
  curateAgentSkills,
  type A2ACardBotInput,
  type BuildAgentCardInput,
} from './services/a2a-agent-card-service';
export {
  A2A_TOKEN_PREFIX,
  A2aAuthFailureLimiter,
  A2aCredentialsService,
  ensureA2aAgentSchema,
  generateA2aToken,
  hashA2aToken,
  normalizeScopes,
  type A2aAgentRecord,
  type A2aMintResult,
} from './services/a2a-credentials-service';
export {
  A2aRpcService,
  ownerSubForA2aAgent,
  type A2aMessageReader,
  type A2aRpcOutcome,
  type A2aRpcServiceDeps,
  type A2aTicketRails,
} from './services/a2a-rpc-service';
