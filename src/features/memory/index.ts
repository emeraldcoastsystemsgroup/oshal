/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added barrel export for non-swarm memory layer service
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the knowledge-scope classifier + permission-scope types so the RAG routes can classify + scope the Settings visibility surface
 */

export { MemoryLayerService } from './services/memory-layer-service';
export {
  classifyKnowledgeScope,
  knowledgeDocumentVisible,
  type KnowledgeScope,
  type KnowledgeListOptions,
  type KnowledgePermissionScope,
} from './services/memory-layer-utils';
