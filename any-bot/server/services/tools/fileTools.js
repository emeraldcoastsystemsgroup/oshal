/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * File Operation Tools
 * Core tools for file system operations
 */

const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const logger = require('../../utils/logger');
const config = require('../../utils/config');

function isPathInside(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Read File Tool
 * Reads the contents of a file
 */
async function readFile(input) {
  const { path: filePath, taskWorkspace } = input;

  if (!filePath) {
    throw new Error('File path is required');
  }

  // Use task-specific workspace if provided, otherwise fall back to global
  const workspaceDir = taskWorkspace || config.filesystem.workspaceDir;

  // Resolve path relative to workspace
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(workspaceDir, filePath);

  // Security: Ensure file is within workspace
  const resolvedPath = path.resolve(fullPath);
  const workspaceResolved = path.resolve(workspaceDir);
  
  if (!isPathInside(workspaceResolved, resolvedPath)) {
    throw new Error('Access denied: File is outside workspace directory');
  }

  try {
    // Check file size
    const stats = await fs.stat(resolvedPath);
    if (stats.size > config.filesystem.maxFileSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${config.filesystem.maxFileSize})`);
    }

    // Read file
    const content = await fs.readFile(resolvedPath, 'utf-8');
    
    logger.debug(`Read file: ${filePath} (${stats.size} bytes)`);
    
    return {
      path: filePath,
      content,
      size: stats.size,
      encoding: 'utf-8',
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (err.code === 'EACCES') {
      throw new Error(`Permission denied: ${filePath}`);
    }
    throw err;
  }
}

/**
 * Write File Tool
 * Writes content to a file (creates if not exists)
 */
async function writeFile(input) {
  const { path: filePath, content, taskWorkspace } = input;

  if (!filePath) {
    throw new Error('File path is required');
  }
  if (content === undefined) {
    throw new Error('Content is required');
  }

  // Use task-specific workspace if provided, otherwise fall back to global
  const workspaceDir = taskWorkspace || config.filesystem.workspaceDir;

  // Resolve path relative to workspace
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(workspaceDir, filePath);

  // Security: Ensure file is within workspace
  const resolvedPath = path.resolve(fullPath);
  const workspaceResolved = path.resolve(workspaceDir);
  
  if (!isPathInside(workspaceResolved, resolvedPath)) {
    throw new Error('Access denied: File is outside workspace directory');
  }

  try {
    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(resolvedPath, content, 'utf-8');
    
    // Get file stats
    const stats = await fs.stat(resolvedPath);
    
    logger.info(`Wrote file: ${filePath} (${stats.size} bytes)`);
    
    return {
      path: filePath,
      size: stats.size,
      created: true,
    };
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new Error(`Permission denied: ${filePath}`);
    }
    throw err;
  }
}

/**
 * List Files Tool
 * Lists files and directories in a path
 */
async function listFiles(input) {
  const { path: dirPath, recursive = false, taskWorkspace } = input;

  if (!dirPath) {
    throw new Error('Directory path is required');
  }

  // Use task-specific workspace if provided, otherwise fall back to global
  const workspaceDir = taskWorkspace || config.filesystem.workspaceDir;

  // Resolve path relative to workspace
  const fullPath = path.isAbsolute(dirPath)
    ? dirPath
    : path.join(workspaceDir, dirPath);

  // Security: Ensure path is within workspace
  const resolvedPath = path.resolve(fullPath);
  const workspaceResolved = path.resolve(workspaceDir);
  
  if (!isPathInside(workspaceResolved, resolvedPath)) {
    throw new Error('Access denied: Path is outside workspace directory');
  }

  try {
    if (recursive) {
      return await listFilesRecursive(resolvedPath, dirPath);
    } else {
      return await listFilesFlat(resolvedPath, dirPath);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    if (err.code === 'EACCES') {
      throw new Error(`Permission denied: ${dirPath}`);
    }
    throw err;
  }
}

/**
 * List files flat (non-recursive)
 */
async function listFilesFlat(fullPath, relativePath) {
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  
  const files = [];
  for (const entry of entries) {
    const stats = await fs.stat(path.join(fullPath, entry.name));
    files.push({
      name: entry.name,
      path: path.join(relativePath, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modified: stats.mtime,
    });
  }

  logger.debug(`Listed ${files.length} items in: ${relativePath}`);
  
  return {
    path: relativePath,
    files,
    count: files.length,
  };
}

/**
 * List files recursively
 */
async function listFilesRecursive(fullPath, relativePath) {
  const allFiles = [];

  async function scan(currentPath, currentRelative) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const entryRelative = path.join(currentRelative, entry.name);
      const stats = await fs.stat(entryPath);
      
      const fileEntry = {
        name: entry.name,
        path: entryRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtime,
      };
      
      allFiles.push(fileEntry);
      
      // Recurse into directories
      if (entry.isDirectory()) {
        await scan(entryPath, entryRelative);
      }
    }
  }

  await scan(fullPath, relativePath);
  
  logger.debug(`Listed ${allFiles.length} items recursively in: ${relativePath}`);
  
  return {
    path: relativePath,
    files: allFiles,
    count: allFiles.length,
  };
}

/**
 * Register all file tools with the registry
 */
function registerFileTools(registry) {
  // Read File tool
  registry.register({
    name: 'read_file',
    description: 'Read the contents of a file',
    category: 'file_operations',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read (relative to workspace)',
        },
      },
    },
    handler: readFile,
    requiresApproval: false, // Reading is safe
    timeout: 30000,
  });

  // Write File tool
  registry.register({
    name: 'write_to_file',
    description: 'Write content to a file (creates if not exists)',
    category: 'file_operations',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write (relative to workspace)',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
    },
    handler: writeFile,
    requiresApproval: true, // Writing requires approval
    timeout: 30000,
  });

  // List Files tool
  registry.register({
    name: 'list_files',
    description: 'List files and directories in a path',
    category: 'file_operations',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (relative to workspace)',
        },
        recursive: {
          type: 'boolean',
          description: 'List files recursively',
          default: false,
        },
      },
    },
    handler: listFiles,
    requiresApproval: false, // Listing is safe
    timeout: 30000,
  });

  // Execute Command tool
  registry.register({
    name: 'execute_command',
    description: 'Executes a shell command',
    category: 'system',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
      },
    },
    handler: executeCommand,
    requiresApproval: true, // Executing commands requires approval
    timeout: 60000,
  });

  logger.info('File operation tools registered');
}
/**
 * Execute Command Tool
 * Executes a shell command
 */
async function executeCommand(input) {
  const { command, taskWorkspace } = input;

  if (!command) {
    throw new Error('Command is required');
  }

  // Use task-specific workspace if provided, otherwise fall back to global
  const workspaceDir = taskWorkspace || config.filesystem.workspaceDir;

  return new Promise((resolve, reject) => {
    exec(command, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
      cwd: workspaceDir,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Execution failed: ${error.message}`));
        return;
      }
      if (stderr) {
        logger.warn(`Command stderr: ${stderr}`);
      }
      resolve({
        stdout,
        stderr,
      });
    });
  });
}
module.exports = {
  readFile,
  writeFile,
  listFiles,
  registerFileTools,
  executeCommand,
};
