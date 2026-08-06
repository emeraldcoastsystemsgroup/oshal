/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): body-parser/CORS middleware, /dashboard, workspace browser + API + static mounts, cockpit/static assets (setupRoutes head)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove wildcard CORS, root workspace/source disclosure and absolute paths; serve only owner-bound task files through canonical link-free containment.
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { trustedServiceUserSub } = require('../services/codebase/swarm-execute-auth');
const {
  assertLinkFreeContainedPath,
  canonicalWorkspaceId,
  isContainedPath,
  resolveExistingTaskWorkspace,
} = require('../services/codebase/task-workspace-scope');

const SERVER_ROOT = path.join(__dirname, '..');
const MAX_RELATIVE_PATH_CHARS = 2_048;

/**
 * @description Registers parsers, protected UI assets, and owner-scoped task workspace reads.
 * The application shell installs service authentication before calling this registrar.
 */
function registerWorkspaceAndStaticRoutes(application) {
  application.app.use(express.json({ limit: '50mb' }));
  application.app.use(express.urlencoded({ extended: false, limit: '50mb' }));

  application.app.get('/dashboard', (_req, res) => {
    res.type('html');
    res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/dashboard.html'));
  });

  // Root listings were cross-owner oracles. Callers must address one owned task exactly.
  const retiredRootWorkspace = (_req, res) => res.status(410).json({
    error: 'root workspace browsing is retired; address an owned task workspace',
  });
  application.app.get('/workspace', retiredRootWorkspace);
  application.app.get('/api/workspace', retiredRootWorkspace);
  application.app.get('/api/workspace-info', retiredRootWorkspace);

  application.app.get('/api/workspace-info/:taskId', async (req, res) => {
    const owned = await resolveOwnedTaskWorkspace(application, req, res);
    if (!owned) return;
    res.json({
      success: true,
      taskId: owned.taskId,
      mountPoint: `/workspace/${encodeURIComponent(owned.taskId)}`,
    });
  });

  application.app.get('/api/workspace/:taskId', async (req, res) => {
    await respondWithWorkspaceEntry(application, req, res, '');
  });
  application.app.get('/api/workspace/:taskId/*', async (req, res) => {
    await respondWithWorkspaceEntry(application, req, res, req.params[0] || '');
  });

  application.app.get('/workspace/:taskId/*', async (req, res) => {
    const owned = await resolveOwnedTaskWorkspace(application, req, res);
    if (!owned) return;
    let target;
    try { target = resolveWorkspaceEntry(owned.workspaceDir, req.params[0] || ''); }
    catch { res.status(404).json({ error: 'File not found' }); return; }
    streamVerifiedFile(target, res);
  });

  // Only explicit UI directories are mounted. Never mount the process/repository root.
  application.app.use('/cockpit', express.static(path.join(SERVER_ROOT, '../ui-cockpit'), {
    dotfiles: 'deny',
    index: false,
  }));
  application.app.use(express.static(path.join(SERVER_ROOT, '../ui-enhanced'), {
    dotfiles: 'deny',
    index: false,
  }));

  logger.info('✓ Owner-scoped workspace file routes registered');
}

async function respondWithWorkspaceEntry(application, req, res, relativePath) {
  const owned = await resolveOwnedTaskWorkspace(application, req, res);
  if (!owned) return;
  let target;
  try { target = resolveWorkspaceEntry(owned.workspaceDir, relativePath); }
  catch { res.status(404).json({ error: 'Path not found' }); return; }

  const stat = fs.lstatSync(target);
  if (stat.isFile()) {
    const url = workspaceUrl(owned.taskId, relativePath);
    res.json({
      success: true,
      path: relativePath,
      type: 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      downloadUrl: url,
    });
    return;
  }
  if (!stat.isDirectory()) { res.status(404).json({ error: 'Path not found' }); return; }

  const items = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    let child;
    try { child = resolveWorkspaceEntry(owned.workspaceDir, childRelative); }
    catch { continue; }
    const childStat = fs.lstatSync(child);
    if (!childStat.isDirectory() && !childStat.isFile()) continue;
    items.push({
      name: entry.name,
      type: childStat.isDirectory() ? 'directory' : 'file',
      path: childRelative,
      size: childStat.isDirectory() ? null : childStat.size,
      modified: childStat.mtime.toISOString(),
      url: childStat.isDirectory()
        ? workspaceApiUrl(owned.taskId, childRelative)
        : workspaceUrl(owned.taskId, childRelative),
    });
  }
  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return right.modified.localeCompare(left.modified);
  });
  res.json({
    success: true,
    taskId: owned.taskId,
    path: relativePath || '/',
    type: 'directory',
    items,
    count: items.length,
  });
}

async function resolveOwnedTaskWorkspace(application, req, res) {
  const userSub = trustedServiceUserSub(req);
  if (!userSub) { res.status(403).json({ error: 'caller_identity_required' }); return null; }
  let taskId;
  try {
    taskId = canonicalWorkspaceId(req.params.taskId);
    if (taskId !== req.params.taskId) throw new Error('non-canonical task id');
  } catch {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  const task = await application.taskController.getTask(taskId);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return null; }
  try { application.taskController.assertTaskOwner(task, userSub); }
  catch { res.status(404).json({ error: 'Task not found' }); return null; }

  try {
    const workspaceDir = resolveExistingTaskWorkspace(task.workspace_dir, workspaceRoots());
    return { taskId, workspaceDir };
  } catch {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
}

function workspaceRoots() {
  return [...new Set([
    config.filesystem.workspaceDir,
    process.env.WORKSPACE_DIR,
    process.env.SHARED_WORKSPACE_ROOT,
    process.env.CLINE_SHARED_WORKSPACE_ROOT,
    process.env.WORKSPACE_ROOT,
  ].filter((entry) => typeof entry === 'string' && entry.length > 0))];
}

function resolveWorkspaceEntry(workspaceDir, rawRelativePath) {
  if (typeof rawRelativePath !== 'string' || rawRelativePath.length > MAX_RELATIVE_PATH_CHARS
    || /[\\\u0000-\u001f\u007f]/.test(rawRelativePath)) {
    throw new Error('invalid relative path');
  }
  const segments = rawRelativePath === '' ? [] : rawRelativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || segment.startsWith('.'))) {
    throw new Error('hidden or ambiguous path segment');
  }
  const target = path.resolve(workspaceDir, ...segments);
  if (!isContainedPath(workspaceDir, target)
    || !assertLinkFreeContainedPath(workspaceDir, target)) {
    throw new Error('uncontained path');
  }
  const realTarget = fs.realpathSync.native(target);
  if (!isContainedPath(workspaceDir, realTarget)) throw new Error('resolved path escape');
  return realTarget;
}

function streamVerifiedFile(target, res) {
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(target, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('not a regular file');
    res.type(path.extname(target));
    res.setHeader('Content-Length', String(stat.size));
    const stream = fs.createReadStream(target, { fd: descriptor, autoClose: true });
    descriptor = undefined;
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!res.headersSent) res.status(404).json({ error: 'File not found' });
  }
}

function encodeRelativePath(relativePath) {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function workspaceUrl(taskId, relativePath) {
  return `/workspace/${encodeURIComponent(taskId)}/${encodeRelativePath(relativePath)}`;
}

function workspaceApiUrl(taskId, relativePath) {
  return `/api/workspace/${encodeURIComponent(taskId)}/${encodeRelativePath(relativePath)}`;
}

module.exports = { registerWorkspaceAndStaticRoutes };
