/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for entities layer
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added task and message store interfaces
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log header to governance-compliant timestamp and author format
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported canonical ticket entity contracts for swarm and Plane alignment
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported work-item entity for internal swarm work unit persistence
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported workspace entity for named persistent workspaces
 */

export * from './agent';
export * from './config';
export * from './message';
export * from './task';
export * from './ticket';
export * from './tool';
export * from './work-item';
export * from './workspace';
