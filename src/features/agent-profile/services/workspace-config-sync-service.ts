/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — syncs agent profile model/provider changes to workspace globalState.json files
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workspace-config-sync' });

/**
 * @description Maps agent profile fields to Cline runtime globalState.json fields.
 */
interface WorkspaceConfigPatch {
  providerId?: string;
  modelId?: string;
}

/**
 * @description Provider ID to Cline runtime provider name mapping.
 */
const PROVIDER_ID_TO_RUNTIME: Record<string, string> = {
  'anthropic': 'anthropic',
  'claude-code': 'claude-code',
  'openai-codex': 'openai',
  'bedrock': 'bedrock',
};

/**
 * @description Service that propagates agent profile model/provider changes
 * to the workspace-level globalState.json files that the Cline runtime actually reads.
 *
 * This bridges the gap between the Postgres-backed agent profile (what the UI edits)
 * and the filesystem-backed runtime config (what the LLM provider actually uses).
 */
export class WorkspaceConfigSyncService {
  private readonly workspaceRoot: string;

  /**
   * @description Creates the workspace config sync service.
   * @param workspaceRoot - Absolute path to the workspace directory containing swarm workspace folders.
   */
  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot || path.resolve(process.cwd(), 'workspace');
  }

  /**
   * @description Syncs model and provider changes from an agent profile update to all
   * matching workspace globalState.json files for that agent.
   *
   * Workspace directories follow the naming pattern: `swarm-{swarmRunId}_{agentId}`
   * The globalState.json is located at: `{workspace}/.oshal/cline-runtime/data/globalState.json`
   *
   * @param agentId - The agent whose workspaces should be updated.
   * @param patch - The model/provider fields to sync.
   * @returns Count of workspace files updated.
   */
  async syncAgentWorkspaceConfig(agentId: string, patch: WorkspaceConfigPatch): Promise<number> {
    if (!agentId || (!patch.providerId && !patch.modelId)) {
      return 0;
    }

    const startedAt = Date.now();
    logger.info({ agentId, patch }, 'Syncing agent profile to workspace runtime configs');

    try {
      const workspaceDirs = this.findAgentWorkspaces(agentId);
      if (workspaceDirs.length === 0) {
        logger.info({ agentId }, 'No workspace directories found for agent — skipping sync');
        return 0;
      }

      let updatedCount = 0;
      for (const workspaceDir of workspaceDirs) {
        const updated = this.patchGlobalState(workspaceDir, patch);
        if (updated) {
          updatedCount++;
        }
      }

      logger.info(
        { agentId, workspaceCount: workspaceDirs.length, updatedCount, durationMs: Date.now() - startedAt },
        'Workspace runtime config sync complete',
      );
      return updatedCount;
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to sync workspace runtime configs');
      return 0;
    }
  }

  /**
   * @description Finds all workspace directories that belong to a given agent.
   * @param agentId - Agent identifier to match against workspace directory names.
   * @returns Array of absolute workspace directory paths.
   */
  private findAgentWorkspaces(agentId: string): string[] {
    try {
      if (!fs.existsSync(this.workspaceRoot)) {
        return [];
      }

      const entries = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.includes(`_${agentId}`))
        .map((entry) => path.join(this.workspaceRoot, entry.name));
    } catch (error) {
      logger.warn({ err: error, workspaceRoot: this.workspaceRoot }, 'Failed to scan workspace directory');
      return [];
    }
  }

  /**
   * @description Patches a single workspace's globalState.json with updated model/provider fields.
   * @param workspaceDir - Absolute path to the workspace directory.
   * @param patch - Fields to update.
   * @returns True when the file was successfully updated.
   */
  private patchGlobalState(workspaceDir: string, patch: WorkspaceConfigPatch): boolean {
    const globalStatePath = path.join(workspaceDir, '.oshal', 'cline-runtime', 'data', 'globalState.json');

    try {
      if (!fs.existsSync(globalStatePath)) {
        logger.debug({ globalStatePath }, 'globalState.json not found — skipping workspace');
        return false;
      }

      const raw = fs.readFileSync(globalStatePath, 'utf-8');
      const state = JSON.parse(raw);
      let changed = false;

      if (patch.modelId) {
        if (state.planModeApiModelId !== patch.modelId) {
          state.planModeApiModelId = patch.modelId;
          changed = true;
        }
        if (state.actModeApiModelId !== patch.modelId) {
          state.actModeApiModelId = patch.modelId;
          changed = true;
        }
      }

      if (patch.providerId) {
        const runtimeProvider = PROVIDER_ID_TO_RUNTIME[patch.providerId] || patch.providerId;
        if (state.planModeApiProvider !== runtimeProvider) {
          state.planModeApiProvider = runtimeProvider;
          changed = true;
        }
        if (state.actModeApiProvider !== runtimeProvider) {
          state.actModeApiProvider = runtimeProvider;
          changed = true;
        }
      }

      if (!changed) {
        logger.debug({ globalStatePath }, 'globalState.json already matches — no update needed');
        return false;
      }

      fs.writeFileSync(globalStatePath, JSON.stringify(state, null, 2), 'utf-8');
      logger.info({ globalStatePath, patch }, 'Updated workspace globalState.json');
      return true;
    } catch (error) {
      logger.warn({ err: error, globalStatePath }, 'Failed to patch workspace globalState.json');
      return false;
    }
  }
}