/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: genericized hardcoded GITLAB_USER fallback to a neutral example address
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 */

/**
 * GitLab Service
 * Handles automatic GitLab project creation and management for tasks
 */

const { exec } = require('child_process');
const util = require('util');
const logger = require('../utils/logger');

const execAsync = util.promisify(exec);

/**
 * @description Encapsulates GitLab integration so each agent task gets a backing
 * private repository for its workspace. Centralizing project creation, git
 * bootstrapping, and pushing here keeps task orchestration decoupled from the
 * specifics of the GitLab API and credential handling, and makes failures
 * non-fatal so a GitLab outage cannot block task creation.
 */
class GitLabService {
  constructor() {
    this.gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.example.com';
    this.gitlabToken = process.env.GITLAB_TOKEN || '';
    this.gitlabUser = process.env.GITLAB_USER || 'oshal-bot@example.com';
    this.namespace = 'oshal/agent-workspaces';
  }

  /**
   * Create GitLab project for a task
   */
  async createTaskProject(taskId, taskDescription, workspaceDir) {
    try {
      if (!this.gitlabToken) {
        throw new Error('GITLAB_TOKEN must be set before creating GitLab task projects');
      }

      logger.info(`Creating GitLab project for task: ${taskId}`);
      
      // Project name is the task ID
      const projectName = taskId;
      const projectPath = `${this.namespace}/${projectName}`;
      const projectUrl = `${this.gitlabUrl}/${projectPath}`;
      const gitRemoteUrl = `${this.gitlabUrl}/${projectPath}.git`;

      // Step 1: Create project in GitLab via API
      const namespaceId = '1'; // ailab group ID - update if different
      const axios = require('axios');
      
      try {
        const createResponse = await axios.post(
          `${this.gitlabUrl}/api/v4/projects`,
          {
            name: projectName,
            path: projectName,
            namespace_id: namespaceId,
            description: taskDescription,
            visibility: 'private',
            initialize_with_readme: false,
          },
          {
            headers: {
              'PRIVATE-TOKEN': this.gitlabToken,
            },
          }
        );
        logger.info(`GitLab project created via API: ${projectUrl}`);
      } catch (apiError) {
        // Project might already exist, continue
        if (apiError.response?.status === 400 && apiError.response?.data?.message?.includes('has already been taken')) {
          logger.info(`GitLab project already exists: ${projectUrl}`);
        } else {
          logger.warn(`GitLab API error (continuing): ${apiError.message}`);
        }
      }

      // Step 2: Initialize git repository in workspace
      await execAsync('git init', { cwd: workspaceDir });
      logger.info(`Git initialized in ${workspaceDir}`);

      // Set default branch to main (git init creates master by default)
      await execAsync('git branch -M main', { cwd: workspaceDir });
      logger.info(`Default branch set to main`);

      // Configure git user
      await execAsync(`git config user.name "OSHAL Agent"`, { cwd: workspaceDir });
      await execAsync(`git config user.email "${this.gitlabUser}"`, { cwd: workspaceDir });

      // Create initial README
      const readme = `# ${taskId}

## Task Description
${taskDescription}

## Created
${new Date().toISOString()}

## Workspace
This is the GitLab repository for task ${taskId}.
All task artifacts and outputs are stored here.

## GitLab Project
${projectUrl}
`;

      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(workspaceDir, 'README.md'), readme);

      // Add and commit
      await execAsync('git add .', { cwd: workspaceDir });
      await execAsync(`git commit -m "Initial commit for task ${taskId}"`, { cwd: workspaceDir });
      logger.info(`Initial commit created for ${taskId}`);

      // Add remote with authentication token in URL
      const authenticatedRemote = gitRemoteUrl.replace('https://', `https://oauth2:${this.gitlabToken}@`);
      await execAsync(`git remote add origin ${authenticatedRemote}`, { cwd: workspaceDir });
      logger.info(`Git remote added: ${gitRemoteUrl}`);

      // Push initial commit to GitLab
      await execAsync(`git push -u origin main`, { cwd: workspaceDir });
      logger.info(`Initial commit pushed to GitLab: ${projectUrl}`);

      return {
        success: true,
        projectUrl,
        gitRemoteUrl,
        projectName,
        namespace: this.namespace,
      };

    } catch (error) {
      logger.error(`Failed to create GitLab project for ${taskId}: ${error.message}`);
      
      // Return error but don't fail task creation
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Push workspace to GitLab
   */
  async pushWorkspace(workspaceDir, branch = 'main') {
    try {
      logger.info(`Pushing workspace to GitLab: ${workspaceDir}`);

      // Push to GitLab
      await execAsync(`git push -u origin ${branch}`, { cwd: workspaceDir });
      
      logger.info(`Workspace pushed successfully`);
      
      return {
        success: true,
        message: `Pushed to ${branch}`,
      };

    } catch (error) {
      logger.error(`Failed to push workspace: ${error.message}`);
      throw error;
    }
  }
}

module.exports = GitLabService;
