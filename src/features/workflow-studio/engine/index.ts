/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the file-header change log this barrel was missing, and dropped the './system-default-process-definition' re-export: that module was deleted as verified-orphaned (this barrel line was its ONLY repo-wide reference, and every real consumer — including the feature's own top-level index.ts — deep-imports the concrete engine modules instead of routing through here).
 */

/**
 * @description Barrel for the workflow-studio process-definition execution engine.
 *
 * WHY the caveat: nothing currently imports this barrel. `src/features/workflow-studio/index.ts`
 * deep-imports `./engine/process-definition-execution-engine` and `./engine/engine-state`
 * directly, so a symbol re-exported here is NOT automatically reachable by any consumer — that
 * is exactly how `system-default-process-definition` sat referenced-but-dead. Wire new engine
 * exports through the slice's top-level barrel too, or they are invisible.
 */
export * from './engine-state';
export * from './engine-services';
export * from './expression-evaluator';
export * from './process-definition-execution-engine';
