/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for message entity
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added InMemoryMessageStore export
 */

export type { IMessageStore } from './types';
export { InMemoryMessageStore } from './services/in-memory-message-store';