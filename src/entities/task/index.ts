/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for task entity
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added InMemoryTaskStore export
 */

export type { ITaskStore } from './types';
export { InMemoryTaskStore } from './services/in-memory-task-store';