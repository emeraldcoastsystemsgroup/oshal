/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CLI Tools - DevOps CLI tool integrations
 * Provides access to 15 DevOps CLI tools installed in the container
 *
 * PHASE_17: Three-mode tool authorization framework
 *   TOOL_AUTH_<TOOL>=auto  → Execute immediately (bot is authorized)
 *   TOOL_AUTH_<TOOL>=ask   → Return needsApproval:true (human must approve via Plane)
 *   TOOL_AUTH_<TOOL>=off   → Block with descriptive error (default for all bots)
 *
 * Environment variables checked:
 *   TOOL_AUTH_AWS_CLI, TOOL_AUTH_KUBECTL, TOOL_AUTH_GCLOUD,
 *   TOOL_AUTH_DOCKER_SOCKET, TOOL_AUTH_GOOGLE_SEARCH,
 *   TOOL_AUTH_CHROMA_MCP, TOOL_AUTH_PLANE_MCP
 */

const { exec } = require('child_process');
const logger = require('../../utils/logger');
const config = require('../../utils/config');

// ============================================================
// PHASE_17: Tool Authorization Framework
// ============================================================

/**
 * Map from tool name → environment variable name for authorization mode.
 * Mode values: "auto" | "ask" | "off"  (default: "off")
 */
const TOOL_AUTH_ENV_MAP = {
  aws:     'TOOL_AUTH_AWS_CLI',
  kubectl: 'TOOL_AUTH_KUBECTL',
  helm:    'TOOL_AUTH_KUBECTL',      // helm uses same cluster access as kubectl
  gcloud:  'TOOL_AUTH_GCLOUD',
  docker:  'TOOL_AUTH_DOCKER_SOCKET',
  terraform: 'TOOL_AUTH_AWS_CLI',   // terraform typically needs cloud credentials
  ansible:   'TOOL_AUTH_KUBECTL',   // ansible often targets infra
  argocd:    'TOOL_AUTH_KUBECTL',   // argocd manages k8s
  vault:     'TOOL_AUTH_AWS_CLI',   // vault is infra-adjacent
  // Safe tools — always auto (no env var needed)
  git:  null,
  jq:   null,
  yq:   null,
  fzf:  null,
  node: null,
  npm:  null,
  cline: null,
};

/**
 * Check whether a tool is authorized for this bot instance.
 *
 * @param {string} toolName - Short tool name (e.g. "kubectl", "aws")
 * @param {string} command  - Full command string (for logging/approval context)
 * @param {string} [ticketId] - Plane ticket ID (for approval tracking)
 * @returns {{ authorized: boolean, mode: string, needsApproval?: boolean, approvalRequest?: object, error?: string }}
 */
function checkToolAuthorization(toolName, command, ticketId) {
  const envVar = TOOL_AUTH_ENV_MAP[toolName];

  // Tools with no env var mapping are always safe to run
  if (envVar === null || envVar === undefined) {
    return { authorized: true, mode: 'auto' };
  }

  const mode = (process.env[envVar] || 'off').toLowerCase().trim();

  logger.info(`[ToolAuth] ${toolName} authorization check: mode=${mode} (${envVar}=${mode})${ticketId ? ` ticket=${ticketId}` : ''}`);

  if (mode === 'auto') {
    // Fully authorized — execute immediately
    return { authorized: true, mode: 'auto' };
  }

  if (mode === 'ask') {
    // Needs human approval — return structured approval request
    const approvalRequest = {
      tool: toolName,
      command,
      ticketId,
      requestedAt: new Date().toISOString(),
      riskLevel: _getRiskLevel(toolName),
      reason: `Bot requested to run \`${command}\`. This tool requires human approval (${envVar}=ask).`,
    };
    logger.info(`[ToolAuth] ${toolName} requires approval for command: ${command}`);
    return {
      authorized: false,
      mode: 'ask',
      needsApproval: true,
      approvalRequest,
    };
  }

  // mode === 'off' (or any unrecognized value) — blocked
  const envVarDisplay = envVar.replace('TOOL_AUTH_', '');
  return {
    authorized: false,
    mode: 'off',
    error: `Tool '${toolName}' is disabled for this agent. Set ${envVar}=auto to enable, or ${envVar}=ask to require human approval. Current value: "${mode}". Contact your administrator to grant access.`,
  };
}

/**
 * Get a risk level label for a tool (used in approval requests)
 * @param {string} toolName
 * @returns {string}
 */
function _getRiskLevel(toolName) {
  const HIGH_RISK = ['kubectl', 'helm', 'argocd', 'terraform', 'ansible'];
  const MEDIUM_RISK = ['aws', 'gcloud', 'vault', 'docker'];
  if (HIGH_RISK.includes(toolName)) return 'high';
  if (MEDIUM_RISK.includes(toolName)) return 'medium';
  return 'low';
}

/**
 * Build a standardized "needs approval" response object that cliTools handlers return
 * when a tool is in "ask" mode. QueueManagerService detects this and triggers the
 * approval workflow (post comment → move ticket to "Approval Required" state).
 *
 * @param {object} authResult - Result from checkToolAuthorization()
 * @returns {object} Structured approval response
 */
function buildApprovalResponse(authResult) {
  return {
    needsApproval: true,
    approvalRequest: authResult.approvalRequest,
    tool: authResult.approvalRequest.tool,
    command: authResult.approvalRequest.command,
    riskLevel: authResult.approvalRequest.riskLevel,
    reason: authResult.approvalRequest.reason,
    message: `⏸️ **Approval Required**: \`${authResult.approvalRequest.command}\` needs human authorization before execution. A request has been posted to the ticket.`,
  };
}

/**
 * Execute a CLI command with proper error handling and timeout
 * @param {string} command - Command to execute
 * @param {object} options - Execution options
 * @param {string} options.cwd - Working directory (defaults to global workspace or task workspace)
 * @param {number} options.timeout - Execution timeout in ms
 * @param {number} options.maxBuffer - Max output buffer size
 */
async function executeCLI(command, options = {}) {
  const {
    timeout = 60000,
    maxBuffer = 50 * 1024 * 1024, // 50MB
    cwd = options.taskWorkspace || config.filesystem.workspaceDir,
  } = options;

  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer, cwd, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${error.message}\nStderr: ${stderr}`));
        return;
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      });
    });
  });
}

/**
 * Git Tool - Version control operations
 */
async function gitCommand(input) {
  const { args, taskWorkspace } = input;
  if (!args) {
    throw new Error('Git arguments are required');
  }

  logger.info(`Executing git command: git ${args}` + (taskWorkspace ? ` (workspace: ${taskWorkspace})` : ''));
  const result = await executeCLI(`git ${args}`, { taskWorkspace });
  
  return {
    tool: 'git',
    command: `git ${args}`,
    output: result.stdout || result.stderr,
    workspace: taskWorkspace,
    success: true,
  };
}

/**
 * Kubectl Tool - Kubernetes cluster management
 * PHASE_17: Checks TOOL_AUTH_KUBECTL before executing
 */
async function kubectlCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('Kubectl arguments are required');
  }

  const command = `kubectl ${args}`;
  const auth = checkToolAuthorization('kubectl', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing kubectl command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'kubectl',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Helm Tool - Kubernetes package manager
 * PHASE_17: Checks TOOL_AUTH_KUBECTL before executing
 */
async function helmCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('Helm arguments are required');
  }

  const command = `helm ${args}`;
  const auth = checkToolAuthorization('helm', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing helm command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'helm',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Terraform Tool - Infrastructure as Code
 * PHASE_17: Checks TOOL_AUTH_AWS_CLI before executing
 */
async function terraformCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('Terraform arguments are required');
  }

  const command = `terraform ${args}`;
  const auth = checkToolAuthorization('terraform', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing terraform command: ${command}`);
  const result = await executeCLI(command, { timeout: 300000 }); // 5 min timeout
  
  return {
    tool: 'terraform',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Ansible Tool - Configuration management and automation
 * PHASE_17: Checks TOOL_AUTH_KUBECTL before executing
 */
async function ansibleCommand(input) {
  const { args, playbook = false, ticketId } = input;
  if (!args) {
    throw new Error('Ansible arguments are required');
  }

  const command = playbook ? `ansible-playbook ${args}` : `ansible ${args}`;
  const auth = checkToolAuthorization('ansible', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing ansible command: ${command}`);
  const result = await executeCLI(command, { timeout: 300000 }); // 5 min timeout
  
  return {
    tool: 'ansible',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * AWS CLI Tool - Amazon Web Services management
 * PHASE_17: Checks TOOL_AUTH_AWS_CLI before executing
 */
async function awsCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('AWS CLI arguments are required');
  }

  const command = `aws ${args}`;
  const auth = checkToolAuthorization('aws', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing aws command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'aws',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Azure CLI Tool - Microsoft Azure management
 * (No TOOL_AUTH flag — Azure not in current authorization matrix)
 */
async function azureCommand(input) {
  const { args } = input;
  if (!args) {
    throw new Error('Azure CLI arguments are required');
  }

  logger.info(`Executing az command: az ${args}`);
  const result = await executeCLI(`az ${args}`, { timeout: 120000 });
  
  return {
    tool: 'azure',
    command: `az ${args}`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Google Cloud CLI Tool - Google Cloud Platform management
 * PHASE_17: Checks TOOL_AUTH_GCLOUD before executing
 */
async function gcloudCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('Gcloud arguments are required');
  }

  const command = `gcloud ${args}`;
  const auth = checkToolAuthorization('gcloud', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing gcloud command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'gcloud',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * ArgoCD Tool - GitOps continuous delivery
 * PHASE_17: Checks TOOL_AUTH_KUBECTL before executing
 */
async function argocdCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('ArgoCD arguments are required');
  }

  const command = `argocd ${args}`;
  const auth = checkToolAuthorization('argocd', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing argocd command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'argocd',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Cline CLI Tool - Cline agent operations
 */
async function clineCommand(input) {
  const { args } = input;
  if (!args) {
    throw new Error('Cline CLI arguments are required');
  }

  logger.info(`Executing cline command: cline ${args}`);
  const result = await executeCLI(`cline ${args}`, { timeout: 180000 });
  
  return {
    tool: 'cline',
    command: `cline ${args}`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * JQ Tool - JSON processor
 */
async function jqCommand(input) {
  const { filter, input: jsonInput } = input;
  if (!filter) {
    throw new Error('JQ filter is required');
  }

  logger.info(`Executing jq command: jq '${filter}'`);
  
  // If input is provided, pipe it to jq
  const cmd = jsonInput 
    ? `echo '${jsonInput.replace(/'/g, "'\\''")}' | jq '${filter}'`
    : `jq '${filter}'`;
  
  const result = await executeCLI(cmd);
  
  return {
    tool: 'jq',
    command: `jq '${filter}'`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * YQ Tool - YAML processor
 */
async function yqCommand(input) {
  const { args, input: yamlInput } = input;
  if (!args) {
    throw new Error('YQ arguments are required');
  }

  logger.info(`Executing yq command: yq ${args}`);
  
  // If input is provided, pipe it to yq
  const cmd = yamlInput 
    ? `echo '${yamlInput.replace(/'/g, "'\\''")}' | yq ${args}`
    : `yq ${args}`;
  
  const result = await executeCLI(cmd);
  
  return {
    tool: 'yq',
    command: `yq ${args}`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * FZF Tool - Fuzzy finder
 */
async function fzfCommand(input) {
  const { input: fzfInput, args = '' } = input;
  if (!fzfInput) {
    throw new Error('FZF input is required');
  }

  logger.info(`Executing fzf command`);
  const cmd = `echo '${fzfInput.replace(/'/g, "'\\''")}' | fzf ${args}`;
  const result = await executeCLI(cmd);
  
  return {
    tool: 'fzf',
    command: `fzf ${args}`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Node.js Tool - Node runtime operations
 */
async function nodeCommand(input) {
  const { args, script } = input;
  
  if (script) {
    logger.info(`Executing node script`);
    const cmd = `node -e '${script.replace(/'/g, "'\\''")}' ${args || ''}`;
    const result = await executeCLI(cmd);
    
    return {
      tool: 'node',
      command: 'node -e [script]',
      output: result.stdout || result.stderr,
      success: true,
    };
  } else if (args) {
    logger.info(`Executing node command: node ${args}`);
    const result = await executeCLI(`node ${args}`);
    
    return {
      tool: 'node',
      command: `node ${args}`,
      output: result.stdout || result.stderr,
      success: true,
    };
  } else {
    throw new Error('Either script or args is required for node command');
  }
}

/**
 * NPM Tool - Node package manager
 */
async function npmCommand(input) {
  const { args } = input;
  if (!args) {
    throw new Error('NPM arguments are required');
  }

  logger.info(`Executing npm command: npm ${args}`);
  const result = await executeCLI(`npm ${args}`, { timeout: 300000 }); // 5 min for installs
  
  return {
    tool: 'npm',
    command: `npm ${args}`,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * HashiCorp Vault Tool - Secrets management
 * PHASE_17: Checks TOOL_AUTH_AWS_CLI before executing
 */
async function vaultCommand(input) {
  const { args, ticketId } = input;
  if (!args) {
    throw new Error('Vault arguments are required');
  }

  const command = `vault ${args}`;
  const auth = checkToolAuthorization('vault', command, ticketId);
  if (!auth.authorized) {
    if (auth.needsApproval) return buildApprovalResponse(auth);
    throw new Error(auth.error);
  }

  logger.info(`Executing vault command: ${command}`);
  const result = await executeCLI(command, { timeout: 120000 });
  
  return {
    tool: 'vault',
    command,
    output: result.stdout || result.stderr,
    success: true,
  };
}

/**
 * Register all CLI tools with the registry
 */
function registerCLITools(registry) {
  // Git
  registry.register({
    name: 'cli_git',
    description: 'Execute git version control commands. Examples: status, log, diff, branch, checkout, commit, push, pull',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Git command arguments (e.g., "status", "log --oneline", "diff HEAD~1")',
        },
      },
    },
    handler: gitCommand,
    requiresApproval: true,
    timeout: 60000,
  });

  // Kubectl
  registry.register({
    name: 'cli_kubectl',
    description: 'Execute kubectl commands for Kubernetes cluster management. Examples: get pods, describe service, apply -f, logs, exec',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Kubectl command arguments (e.g., "get pods", "describe node", "apply -f deployment.yaml")',
        },
      },
    },
    handler: kubectlCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // Helm
  registry.register({
    name: 'cli_helm',
    description: 'Execute helm commands for Kubernetes package management. Examples: list, install, upgrade, rollback, uninstall',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Helm command arguments (e.g., "list", "install myapp ./chart", "upgrade myapp ./chart")',
        },
      },
    },
    handler: helmCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // Terraform
  registry.register({
    name: 'cli_terraform',
    description: 'Execute terraform Infrastructure as Code commands. Examples: init, plan, apply, destroy, show, state list',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Terraform command arguments (e.g., "plan", "apply -auto-approve", "destroy")',
        },
      },
    },
    handler: terraformCommand,
    requiresApproval: true,
    timeout: 300000,
  });

  // Ansible
  registry.register({
    name: 'cli_ansible',
    description: 'Execute ansible configuration management commands. Use playbook=true for ansible-playbook commands',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Ansible command arguments (e.g., "all -m ping", "playbook.yml" with playbook=true)',
        },
        playbook: {
          type: 'boolean',
          description: 'Use ansible-playbook instead of ansible command',
          default: false,
        },
      },
    },
    handler: ansibleCommand,
    requiresApproval: true,
    timeout: 300000,
  });

  // AWS CLI
  registry.register({
    name: 'cli_aws',
    description: 'Execute AWS CLI commands for Amazon Web Services management. Examples: s3 ls, ec2 describe-instances, lambda list-functions',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'AWS CLI arguments (e.g., "s3 ls", "ec2 describe-instances", "sts get-caller-identity")',
        },
      },
    },
    handler: awsCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // Azure CLI
  registry.register({
    name: 'cli_azure',
    description: 'Execute Azure CLI commands for Microsoft Azure management. Examples: vm list, group list, account show',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Azure CLI arguments (e.g., "vm list", "group list", "account show")',
        },
      },
    },
    handler: azureCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // Google Cloud CLI
  registry.register({
    name: 'cli_gcloud',
    description: 'Execute gcloud commands for Google Cloud Platform management. Examples: compute instances list, projects list, config list',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Gcloud command arguments (e.g., "compute instances list", "projects list")',
        },
      },
    },
    handler: gcloudCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // ArgoCD
  registry.register({
    name: 'cli_argocd',
    description: 'Execute argocd commands for GitOps continuous delivery. Examples: app list, app sync, app get, app delete',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'ArgoCD command arguments (e.g., "app list", "app sync myapp", "version")',
        },
      },
    },
    handler: argocdCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  // Cline CLI
  registry.register({
    name: 'cli_cline',
    description: 'Execute cline CLI commands for AI agent operations. Examples: version, task list, logs show',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Cline CLI arguments (e.g., "version", "task list", "logs show")',
        },
      },
    },
    handler: clineCommand,
    requiresApproval: false, // Cline operations are safe
    timeout: 180000,
  });

  // JQ
  registry.register({
    name: 'cli_jq',
    description: 'Process JSON data with jq. Provide filter and optionally input JSON string',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: {
          type: 'string',
          description: 'JQ filter expression (e.g., ".", ".name", ".items[] | select(.active)")',
        },
        input: {
          type: 'string',
          description: 'JSON input string to process (optional if using file)',
        },
      },
    },
    handler: jqCommand,
    requiresApproval: false,
    timeout: 30000,
  });

  // YQ
  registry.register({
    name: 'cli_yq',
    description: 'Process YAML data with yq. Provide yq arguments and optionally input YAML string',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'YQ arguments (e.g., ".name", ".spec.replicas", "eval .metadata")',
        },
        input: {
          type: 'string',
          description: 'YAML input string to process (optional if using file)',
        },
      },
    },
    handler: yqCommand,
    requiresApproval: false,
    timeout: 30000,
  });

  // FZF
  registry.register({
    name: 'cli_fzf',
    description: 'Interactive fuzzy finder for filtering lists. Provide input list and optional fzf arguments',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: {
        input: {
          type: 'string',
          description: 'Input list to filter (newline-separated items)',
        },
        args: {
          type: 'string',
          description: 'FZF arguments (e.g., "--multi", "--reverse", "--height=40%")',
        },
      },
    },
    handler: fzfCommand,
    requiresApproval: false,
    timeout: 30000,
  });

  // Node.js
  registry.register({
    name: 'cli_node',
    description: 'Execute Node.js runtime commands. Can run scripts or files',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Node arguments for running files (e.g., "script.js", "--version")',
        },
        script: {
          type: 'string',
          description: 'JavaScript code to execute with node -e',
        },
      },
    },
    handler: nodeCommand,
    requiresApproval: true,
    timeout: 60000,
  });

  // NPM
  registry.register({
    name: 'cli_npm',
    description: 'Execute npm package manager commands. Examples: install, update, list, run, test',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'NPM command arguments (e.g., "install express", "run build", "list")',
        },
      },
    },
    handler: npmCommand,
    requiresApproval: true,
    timeout: 300000,
  });

  // Vault
  registry.register({
    name: 'cli_vault',
    description: 'Execute HashiCorp Vault commands for secrets management. Examples: kv get, kv put, kv list, status, login, token lookup',
    category: 'devops_cli',
    inputSchema: {
      type: 'object',
      required: ['args'],
      properties: {
        args: {
          type: 'string',
          description: 'Vault command arguments (e.g., "status", "kv get secret/myapp", "token lookup")',
        },
      },
    },
    handler: vaultCommand,
    requiresApproval: true,
    timeout: 120000,
  });

  logger.info('CLI tools registered: 16 DevOps CLI tools available');
}

module.exports = {
  gitCommand,
  kubectlCommand,
  helmCommand,
  terraformCommand,
  ansibleCommand,
  awsCommand,
  azureCommand,
  gcloudCommand,
  argocdCommand,
  clineCommand,
  jqCommand,
  yqCommand,
  fzfCommand,
  nodeCommand,
  npmCommand,
  vaultCommand,
  registerCLITools,
};
