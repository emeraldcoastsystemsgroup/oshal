/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial placeholder barrel for agent management feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported extension-layer swarm scaffolds to preserve BaseAgent freeze
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced AgentStatusController (in ./controllers, not covered by the ./services star-export) through the barrel
 */

/**
 * @description Barrel export for the agent-management feature slice.
 * Runtime behavior should be implemented here and not in BaseAgent.
 */

export * from './services';
export { AgentStatusController } from './controllers/agent-status-controller';
