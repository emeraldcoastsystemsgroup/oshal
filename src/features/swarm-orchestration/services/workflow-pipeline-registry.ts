/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial WorkflowPipelineRegistry — merges built-in pipelines with app-contributed workflows (ADR 2026-04-20 Phase 1 close)
 */

import { createChildLogger } from '@/shared/logger';
import { WORKFLOW_PIPELINES, type WorkflowDefinition } from './queue-manager-service';

const logger = createChildLogger({ module: 'workflow-pipeline-registry' });

/**
 * @description Registry that merges the framework's built-in workflow
 * pipelines with pipelines contributed by loaded swarm applications. This
 * is the authoritative lookup used by QueueManagerService.dispatchBatch.
 *
 * Built-in pipelines (`incident`, `build`) cannot be overridden — if an
 * app tries to register the same ticketType, the built-in wins and a
 * warning is logged. This prevents an app from hijacking the framework's
 * core pipelines.
 */
export class WorkflowPipelineRegistry {
  private static instance: WorkflowPipelineRegistry | null = null;

  /** App-contributed workflows, keyed by ticketType. */
  private readonly appWorkflows: Map<string, { appName: string; workflow: WorkflowDefinition }> = new Map();

  /** Built-in ticketTypes the app layer cannot override. */
  private readonly builtInTicketTypes: Set<string>;

  private constructor() {
    this.builtInTicketTypes = new Set(WORKFLOW_PIPELINES.map(w => w.ticketType));
    logger.info({ builtIns: Array.from(this.builtInTicketTypes) }, 'WorkflowPipelineRegistry initialised');
  }

  /** Process-global singleton. QueueManagerService and SwarmAppService both use this instance. */
  static getInstance(): WorkflowPipelineRegistry {
    if (!this.instance) this.instance = new WorkflowPipelineRegistry();
    return this.instance;
  }

  /**
   * @description Resolves a ticketType to its WorkflowDefinition. Built-ins
   * take priority; app-contributed workflows fill in gaps.
   * @param ticketType - ticket.ticketType
   * @returns workflow definition, or undefined if none matches
   */
  resolve(ticketType: string): WorkflowDefinition | undefined {
    const builtIn = WORKFLOW_PIPELINES.find(w => w.ticketType === ticketType);
    if (builtIn) return builtIn;
    return this.appWorkflows.get(ticketType)?.workflow;
  }

  /**
   * @description Registers an app-contributed workflow. Rejects overlap
   * with built-ins so apps cannot override framework behavior.
   * @param appName - manifest.name (used for unregister)
   * @param workflow - workflow definition from manifest
   * @returns true if registered, false if blocked (built-in collision)
   */
  registerFromApp(appName: string, workflow: WorkflowDefinition): boolean {
    if (this.builtInTicketTypes.has(workflow.ticketType)) {
      logger.warn(
        { appName, ticketType: workflow.ticketType },
        'App cannot override built-in workflow — registration rejected',
      );
      return false;
    }
    this.appWorkflows.set(workflow.ticketType, { appName, workflow });
    logger.info({ appName, ticketType: workflow.ticketType, pipeline: workflow.pipeline }, 'App workflow registered');
    return true;
  }

  /**
   * @description Removes every workflow contributed by an app. Called on
   * app deactivation or unload.
   */
  unregisterApp(appName: string): number {
    let removed = 0;
    for (const [ticketType, entry] of this.appWorkflows) {
      if (entry.appName === appName) {
        this.appWorkflows.delete(ticketType);
        removed++;
      }
    }
    if (removed > 0) logger.info({ appName, removed }, 'App workflows unregistered');
    return removed;
  }

  /** Introspection — used by tests and diagnostic routes. */
  listAll(): Array<{ source: 'built-in' | 'app'; appName?: string; workflow: WorkflowDefinition }> {
    const built = WORKFLOW_PIPELINES.map(w => ({ source: 'built-in' as const, workflow: w }));
    const app = Array.from(this.appWorkflows.values()).map(e => ({
      source: 'app' as const,
      appName: e.appName,
      workflow: e.workflow,
    }));
    return [...built, ...app];
  }
}
