/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted code-server bridge routes from server.ts to comply with 800-line refactoring trigger
 */

import express from 'express';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { readGlobalRuntimeSettings } from '@/shared/services/runtime-config-loader';

const logger = createChildLogger({ module: 'code-server-bridge' });

const DEFAULT_CODE_SERVER_URL = 'http://localhost:8888';
const DEFAULT_CODE_SERVER_WORKSPACE_ROOT = '/workspace';

/**
 * @description Registers code-server bridge routes that proxy workspace-aware
 * requests to the embedded code-server instance (VS Code in the browser).
 *
 * @param app - Express application
 * @param requiresAuth - Authentication middleware
 */
export function registerCodeServerBridgeRoutes(
  app: express.Application,
  requiresAuth: express.RequestHandler,
): void {
  const redirectHandler = (
    req: express.Request,
    res: express.Response,
  ): void => {
    const targetUrl = buildCodeServerRedirectUrl(req.originalUrl || '/code');
    logger.info({ requestUrl: req.originalUrl, targetUrl }, 'Redirecting cockpit code route to code-server');
    res.redirect(302, targetUrl);
  };

  app.get('/code', requiresAuth, redirectHandler);
  app.get('/code/', requiresAuth, redirectHandler);
  app.get('/code/*codePath', requiresAuth, redirectHandler);
}

/**
 * @description Builds the absolute redirect URL for code-server handoff routes.
 * The OSHAL `/code` prefix is stripped and the remaining path/query is appended
 * to `CODE_SERVER_URL` (or localhost fallback).
 *
 * @param requestUrl - Incoming OSHAL request URL beginning with `/code`.
 * @returns Absolute redirect target for code-server.
 */
export function buildCodeServerRedirectUrl(requestUrl: string): string {
  const codeServerBaseUrl = (process.env.CODE_SERVER_URL || DEFAULT_CODE_SERVER_URL).replace(/\/+$/, '');
  const requestTarget = new URL(requestUrl, 'http://oshal.local');
  normalizeCodeServerWorkspaceQuery(requestTarget.searchParams);
  const strippedPath = requestTarget.pathname.replace(/^\/code/, '');
  const suffix = strippedPath.length > 0 ? strippedPath : '/';
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const query = requestTarget.searchParams.toString();
  return `${codeServerBaseUrl}${normalizedSuffix}${query ? `?${query}` : ''}`;
}

/**
 * @description Rewrites code-server folder and file query params onto the
 * configured shared workspace root so bridge URLs stay portable across swarm
 * hosts even when OSHAL discovered a local absolute path.
 *
 * @param searchParams - URL query params that may contain folder/file values.
 */
function normalizeCodeServerWorkspaceQuery(searchParams: URLSearchParams): void {
  ['folder', 'file'].forEach((key) => {
    const rawValue = searchParams.get(key);
    if (!rawValue) {
      return;
    }
    searchParams.set(key, normalizeCodeServerWorkspacePath(rawValue));
  });
}

/**
 * @description Maps one workspace path value from a local OSHAL path or
 * `workspace/...` display path onto the configured code-server workspace root.
 *
 * @param rawValue - Folder or file query value from the OSHAL bridge request.
 * @returns Code-server-safe workspace path.
 */
function normalizeCodeServerWorkspacePath(rawValue: string): string {
  const workspaceRoot = resolveCodeServerWorkspaceRoot();
  const relativePath = readWorkspaceRelativePath(rawValue);
  if (relativePath === null) {
    return rawValue;
  }
  if (!relativePath) {
    return workspaceRoot;
  }
  return joinWorkspacePath(workspaceRoot, relativePath);
}

/**
 * @description Resolves the shared workspace root exposed inside code-server.
 * This may differ from the OSHAL host filesystem root when code-server runs on
 * a swarm target with its own shared mount.
 *
 * @returns Absolute workspace root path expected by code-server.
 */
function resolveCodeServerWorkspaceRoot(): string {
  const runtimeSettings = readGlobalRuntimeSettings();
  const configuredFromSettings = typeof runtimeSettings.codeServerWorkspaceRoot === 'string'
    ? runtimeSettings.codeServerWorkspaceRoot
    : '';
  const configuredRoot = configuredFromSettings
    || process.env.CODE_SERVER_WORKSPACE_ROOT
    || process.env.CODE_WORKSPACE_ROOT
    || process.env.CLINE_WORKSPACE_ROOT
    || process.env.WORKSPACE_ROOT
    || DEFAULT_CODE_SERVER_WORKSPACE_ROOT;
  return normalizeFilesystemPath(configuredRoot) || DEFAULT_CODE_SERVER_WORKSPACE_ROOT;
}

/**
 * @description Extracts the workspace-relative suffix from a local absolute
 * path, a code-server path, or a `workspace/...` display path.
 *
 * @param rawValue - Incoming folder/file path value from the bridge request.
 * @returns Relative workspace path, empty string for root, or null when the
 * value is unrelated to the shared workspace namespace.
 */
function readWorkspaceRelativePath(rawValue: string): string | null {
  const normalizedValue = normalizeFilesystemPath(rawValue);
  if (!normalizedValue) {
    return '';
  }

  if (normalizedValue === 'workspace' || normalizedValue === '/workspace') {
    return '';
  }
  if (normalizedValue.startsWith('workspace/')) {
    return normalizedValue.slice('workspace/'.length);
  }
  if (normalizedValue.startsWith('/workspace/')) {
    return normalizedValue.slice('/workspace/'.length);
  }

  const candidateRoots = new Set<string>([
    resolveCodeServerWorkspaceRoot(),
    normalizeFilesystemPath(process.env.CLINE_WORKSPACE_ROOT || ''),
    normalizeFilesystemPath(process.env.WORKSPACE_ROOT || ''),
    normalizeFilesystemPath(path.resolve(process.cwd(), 'workspace')),
  ].filter((value) => value.length > 0));

  for (const root of candidateRoots) {
    if (normalizedValue === root) {
      return '';
    }
    if (normalizedValue.startsWith(`${root}/`)) {
      return normalizedValue.slice(root.length + 1);
    }
  }

  const workspaceMarker = normalizedValue.lastIndexOf('/workspace/');
  if (workspaceMarker >= 0) {
    return normalizedValue.slice(workspaceMarker + '/workspace/'.length);
  }

  return null;
}

/**
 * @description Normalizes one filesystem-like value for URL path rewriting.
 *
 * @param value - Raw filesystem path or display path.
 * @returns Slash-normalized path with trailing separators removed.
 */
function normalizeFilesystemPath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/**
 * @description Joins the code-server workspace root with a workspace-relative
 * suffix using URL-safe forward slashes.
 *
 * @param workspaceRoot - Absolute code-server workspace root.
 * @param relativePath - Relative child path inside the workspace root.
 * @returns Joined absolute workspace path.
 */
function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\/+$/, '');
  const normalizedRelative = relativePath.replace(/^\/+/, '');
  return normalizedRelative ? `${normalizedRoot}/${normalizedRelative}` : normalizedRoot;
}