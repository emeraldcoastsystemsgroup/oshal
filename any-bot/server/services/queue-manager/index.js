/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Queue Manager Service Exports
 * Central multi-agent coordination system for Plane ticket routing
 *
 * Updated: 2026-02-24 — Swarm Improvement Sprint
 * Added: StuckAgentWatchdog, LoggingStandard, AgentMetricsService
 */

const QueueManagerService = require('./QueueManagerService');
const AgentRegistry = require('./AgentRegistry');
const CapabilityMatcher = require('./CapabilityMatcher');
const AgentInstructions = require('./AgentInstructions');
const MeshBroadcastNetwork = require('./MeshBroadcastNetwork');
// ⭐ PHASE_24 Issue #018: Private Mesh Protocol
const PrivateMeshManager = require('./PrivateMeshManager');
const MeshProtocol = require('./MeshProtocol');
const MeshChannelStore = require('./MeshChannelStore');
// ⭐ Routing Decision Log — transparent audit trail for every routing decision
const RoutingDecisionLog = require('./RoutingDecisionLog');
// ⭐ Issue #001: Stuck agent watchdog — detects and recovers stuck agents
const StuckAgentWatchdog = require('./StuckAgentWatchdog');
// ⭐ Issue #006: Structured logging standard
const LoggingStandard = require('./LoggingStandard');
// ⭐ Issue #008/#009: Agent metrics with cost tracking and pre-population
const AgentMetricsService = require('./AgentMetricsService');

/**
 * @description Public surface (barrel) for the queue-manager subsystem. Re-exports
 * every coordination component as named members so consumers can import the whole
 * multi-agent routing toolkit from a single entry point instead of reaching into
 * individual module files, keeping internal file layout free to change.
 */
module.exports = {
  QueueManagerService,
  AgentRegistry,
  CapabilityMatcher,
  AgentInstructions,
  MeshBroadcastNetwork,
  PrivateMeshManager,
  MeshProtocol,
  MeshChannelStore,
  RoutingDecisionLog,
  StuckAgentWatchdog,
  LoggingStandard,
  AgentMetricsService,
};
