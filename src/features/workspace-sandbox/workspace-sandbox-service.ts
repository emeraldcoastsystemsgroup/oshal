/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | C2: Workspace boundary enforcement — validates file paths against workspace root, blocks traversal and symlink escape
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workspace-sandbox-service' });

/**
 * @description Result of a path validation check against a workspace boundary.
 */
export interface PathValidationResult {
  /** Whether the resolved path falls within the workspace root */
  allowed: boolean;
  /** The fully resolved absolute path after normalization */
  resolvedPath: string;
  /** Human-readable reason when access is blocked */
  reason?: string;
}

/**
 * @description Restricted filesystem interface scoped to a single workspace root.
 * All operations resolve paths relative to the sandbox root and reject escapes.
 */
export interface SandboxedFs {
  /** Read a file relative to the workspace root */
  readFile(relativePath: string, encoding?: BufferEncoding): string;
  /** Write a file relative to the workspace root */
  writeFile(relativePath: string, content: string): void;
  /** Check if a path exists within the workspace */
  exists(relativePath: string): boolean;
  /** Create a directory within the workspace */
  mkdir(relativePath: string, options?: { recursive?: boolean }): void;
  /** List entries in a directory within the workspace */
  readdir(relativePath: string): string[];
  /** Get file stats within the workspace */
  stat(relativePath: string): fs.Stats;
  /** The absolute workspace root this sandbox is bound to */
  readonly workspaceRoot: string;
}

/**
 * @description Workspace boundary enforcement service.
 *
 * Validates that file paths requested by agents stay within their assigned
 * workspace root directory. Detects and blocks path traversal attacks
 * (`../` sequences), absolute paths outside the workspace, and symlink escapes
 * that could break containment.
 *
 * Every blocked access attempt is logged with full context for audit.
 */
export class WorkspaceSandboxService {
  /**
   * @description Validate whether a requested path resolves to a location
   * within the given workspace root. Handles relative paths, absolute paths,
   * `../` traversal, and symlink resolution.
   *
   * @param workspaceRoot - Absolute path to the agent's workspace root directory
   * @param requestedPath - The path the agent wants to access (relative or absolute)
   * @returns Validation result with the resolved path and block reason if denied
   */
  validatePath(workspaceRoot: string, requestedPath: string): PathValidationResult {
    const normalizedRoot = path.resolve(workspaceRoot);

    if (!requestedPath || requestedPath.trim() === '') {
      const result: PathValidationResult = {
        allowed: false,
        resolvedPath: '',
        reason: 'Empty path is not allowed',
      };
      logger.warn({ workspaceRoot: normalizedRoot, requestedPath }, 'Blocked empty path access attempt');
      return result;
    }

    const resolvedPath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(normalizedRoot, requestedPath);

    const rootWithSep = normalizedRoot.endsWith(path.sep)
      ? normalizedRoot
      : `${normalizedRoot}${path.sep}`;

    if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(rootWithSep)) {
      const result: PathValidationResult = {
        allowed: false,
        resolvedPath,
        reason: `Path "${requestedPath}" resolves to "${resolvedPath}" which is outside workspace root "${normalizedRoot}"`,
      };
      logger.warn(
        { workspaceRoot: normalizedRoot, requestedPath, resolvedPath },
        'Blocked path traversal attempt — resolved path outside workspace',
      );
      return result;
    }

    if (fs.existsSync(resolvedPath)) {
      try {
        const realPath = fs.realpathSync(resolvedPath);
        const realRoot = fs.realpathSync(normalizedRoot);
        const realRootWithSep = realRoot.endsWith(path.sep)
          ? realRoot
          : `${realRoot}${path.sep}`;

        if (realPath !== realRoot && !realPath.startsWith(realRootWithSep)) {
          const result: PathValidationResult = {
            allowed: false,
            resolvedPath: realPath,
            reason: `Path "${requestedPath}" is a symlink that escapes workspace root (real path: "${realPath}")`,
          };
          logger.warn(
            { workspaceRoot: normalizedRoot, requestedPath, resolvedPath, realPath },
            'Blocked symlink escape — real path outside workspace',
          );
          return result;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          { workspaceRoot: normalizedRoot, requestedPath, err: errMsg },
          'Error resolving real path during symlink check',
        );
        return {
          allowed: false,
          resolvedPath,
          reason: `Failed to resolve real path for symlink check: ${errMsg}`,
        };
      }
    }

    logger.debug(
      { workspaceRoot: normalizedRoot, requestedPath, resolvedPath },
      'Path validation passed',
    );

    return { allowed: true, resolvedPath };
  }

  /**
   * @description Create a sandboxed filesystem interface scoped to the given
   * workspace root. Every operation validates path containment before executing.
   *
   * @param workspaceRoot - Absolute path to the workspace root directory
   * @returns SandboxedFs interface with all operations constrained to the workspace
   * @throws Error if the workspace root does not exist or is not a directory
   */
  createSandboxedFs(workspaceRoot: string): SandboxedFs {
    const normalizedRoot = path.resolve(workspaceRoot);

    if (!fs.existsSync(normalizedRoot)) {
      throw new Error(`Workspace root does not exist: ${normalizedRoot}`);
    }

    const rootStat = fs.statSync(normalizedRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${normalizedRoot}`);
    }

    const self = this;

    function guardedResolve(relativePath: string): string {
      const result = self.validatePath(normalizedRoot, relativePath);
      if (!result.allowed) {
        throw new Error(`Workspace boundary violation: ${result.reason}`);
      }
      return result.resolvedPath;
    }

    return {
      get workspaceRoot() {
        return normalizedRoot;
      },

      readFile(relativePath: string, encoding: BufferEncoding = 'utf8'): string {
        const resolved = guardedResolve(relativePath);
        return fs.readFileSync(resolved, encoding);
      },

      writeFile(relativePath: string, content: string): void {
        const resolved = guardedResolve(relativePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, content, 'utf8');
      },

      exists(relativePath: string): boolean {
        const result = self.validatePath(normalizedRoot, relativePath);
        if (!result.allowed) {
          return false;
        }
        return fs.existsSync(result.resolvedPath);
      },

      mkdir(relativePath: string, options?: { recursive?: boolean }): void {
        const resolved = guardedResolve(relativePath);
        fs.mkdirSync(resolved, { recursive: options?.recursive ?? false });
      },

      readdir(relativePath: string): string[] {
        const resolved = guardedResolve(relativePath);
        return fs.readdirSync(resolved, 'utf8');
      },

      stat(relativePath: string): fs.Stats {
        const resolved = guardedResolve(relativePath);
        return fs.statSync(resolved);
      },
    };
  }
}
