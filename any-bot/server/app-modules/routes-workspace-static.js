/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): body-parser/CORS middleware, /dashboard, workspace browser + API + static mounts, cockpit/static assets (setupRoutes head)
 */

const express = require('express');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../utils/config');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Express middleware (json/urlencoded/CORS), /dashboard, the B11 workspace file server (browser UI + listing API + static mount + /api/workspace-info), and the cockpit/enhanced-UI static mounts. Must be the FIRST registration call — order is the contract.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerWorkspaceAndStaticRoutes(application) {
    // Middleware
    application.app.use(express.json({ limit: '50mb' }));
    application.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // CORS
    application.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Dashboard route (BEFORE static middleware to override)
    application.app.get('/dashboard', (req, res) => {
      res.type('html');
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/dashboard.html'));
    });

    // ═══════════════════════════════════════════
    // B11: Workspace File Server
    // Serves agent deliverables at /workspace/
    // ═══════════════════════════════════════════
    // ⭐ PHASE_54 SESSION_03 FIX: Workspace is at /app/workspace (per docker-compose volume mount)
    // Docker volume mount: ./any-bot/workspace:/app/workspace
    // All code creates files in /app/workspace/, so Express must serve from there
    const workspacePath = config.filesystem.workspaceDir;
    const fs = require('fs');

    // Workspace browser UI
    application.app.get('/workspace', (req, res) => {
      res.type('html');
      res.send(getWorkspaceBrowserHTML());
    });

    // Workspace directory listing API
    application.app.get('/api/workspace', (req, res) => {
      listWorkspaceDir(workspacePath, '', res);
    });
    application.app.get('/api/workspace/*', (req, res) => {
      const subPath = req.params[0] || '';
      listWorkspaceDir(workspacePath, subPath, res);
    });

    // Serve workspace files statically (after API routes to avoid conflicts)
    application.app.use('/workspace', express.static(workspacePath, {
      dotfiles: 'ignore',
      index: false, // Don't serve index.html automatically — use our browser UI
    }));

    // Workspace info API — returns absolute path for code-server link construction
    application.app.get('/api/workspace-info', (req, res) => {
      const absolutePath = require('path').resolve(workspacePath);
      res.json({
        success: true,
        basePath: workspacePath,
        absolutePath: absolutePath,
        mountPoint: '/workspace',
      });
    });

    logger.info(`✓ Workspace file server mounted at /workspace (${workspacePath})`);

    // Static files
    // PHASE_68: Cockpit UI — user-facing dashboard at /cockpit
    application.app.use('/cockpit', express.static('ui-cockpit'));
    
    application.app.use(express.static('ui-enhanced'));
    application.app.use(express.static('.'));
}

  /**
   * List workspace directory contents as JSON
   */
function listWorkspaceDir(basePath, subPath, res) {
    const fs = require('fs');
    const targetPath = path.join(basePath, subPath);
    
    // Security: prevent path traversal
    const resolved = path.resolve(targetPath);
    const baseResolved = path.resolve(basePath);
    if (!resolved.startsWith(baseResolved)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'Path not found' });
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        // It's a file — return file info
        return res.json({
          success: true,
          path: subPath,
          type: 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
          downloadUrl: `/workspace/${subPath}`,
        });
      }

      // It's a directory — list contents
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(entry => {
          const entryPath = subPath ? `${subPath}/${entry.name}` : entry.name;
          const entryStat = fs.statSync(path.join(resolved, entry.name));
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            path: entryPath,
            size: entry.isDirectory() ? null : entryStat.size,
            modified: entryStat.mtime.toISOString(),
            url: entry.isDirectory() ? `/api/workspace/${entryPath}` : `/workspace/${entryPath}`,
          };
        })
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return b.modified.localeCompare(a.modified); // Most recent first
        });

      res.json({
        success: true,
        path: subPath || '/',
        type: 'directory',
        items,
        count: items.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Generate workspace browser HTML page
   */
function getWorkspaceBrowserHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Workspace Browser</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 0.9rem; }
    .breadcrumb { margin-bottom: 16px; font-size: 0.85rem; }
    .breadcrumb a { color: #38bdf8; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .breadcrumb span { color: #64748b; }
    .file-list { list-style: none; }
    .file-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
    .file-item:hover { background: #1e293b; }
    .file-icon { font-size: 1.3rem; width: 28px; text-align: center; }
    .file-name { flex: 1; font-weight: 500; }
    .file-name a { color: #e2e8f0; text-decoration: none; }
    .file-name a:hover { color: #38bdf8; }
    .file-meta { color: #64748b; font-size: 0.8rem; min-width: 120px; text-align: right; }
    .file-size { color: #64748b; font-size: 0.8rem; min-width: 80px; text-align: right; }
    .empty { color: #64748b; padding: 40px; text-align: center; }
    .loading { color: #94a3b8; padding: 40px; text-align: center; }
    .back-link { display: inline-flex; align-items: center; gap: 6px; color: #38bdf8; text-decoration: none; margin-bottom: 16px; font-size: 0.9rem; }
    .back-link:hover { text-decoration: underline; }
    .stats { background: #1e293b; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; display: flex; gap: 24px; font-size: 0.85rem; }
    .stats span { color: #94a3b8; }
    .stats strong { color: #38bdf8; }
  </style>
</head>
<body>
  <h1>📂 Agent Workspace Browser</h1>
  <p class="subtitle">Browse deliverables created by swarm agents</p>
  <div id="breadcrumb" class="breadcrumb"></div>
  <div id="stats" class="stats" style="display:none"></div>
  <div id="content"><div class="loading">Loading...</div></div>

  <script>
    let currentPath = '';

    function formatSize(bytes) {
      if (bytes === null || bytes === undefined) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatDate(iso) {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }

    function getIcon(type, name) {
      if (type === 'directory') return '📁';
      const ext = name.split('.').pop().toLowerCase();
      const icons = { md: '📝', txt: '📄', json: '📋', js: '⚡', py: '🐍', html: '🌐', css: '🎨', pptx: '📊', pdf: '📕', png: '🖼️', jpg: '🖼️', svg: '🖼️', sh: '🔧', yaml: '⚙️', yml: '⚙️' };
      return icons[ext] || '📄';
    }

    async function navigate(subPath) {
      currentPath = subPath;
      const url = subPath ? '/api/workspace/' + subPath : '/api/workspace';
      
      try {
        const resp = await fetch(url);
        const data = await resp.json();
        
        if (!data.success) {
          document.getElementById('content').innerHTML = '<div class="empty">Error: ' + data.error + '</div>';
          return;
        }

        // Update breadcrumb
        const parts = (subPath || '').split('/').filter(Boolean);
        let bc = '<a href="#" onclick="navigate(\\'\\');return false;">workspace</a>';
        let accumulated = '';
        parts.forEach(p => {
          accumulated += (accumulated ? '/' : '') + p;
          const acc = accumulated;
          bc += ' <span>/</span> <a href="#" onclick="navigate(\\'' + acc + '\\');return false;">' + p + '</a>';
        });
        document.getElementById('breadcrumb').innerHTML = bc;

        if (data.type === 'file') {
          document.getElementById('content').innerHTML = 
            '<div style="padding:20px;text-align:center"><p>File: <strong>' + data.path + '</strong></p>' +
            '<p style="margin:12px 0">Size: ' + formatSize(data.size) + ' | Modified: ' + formatDate(data.modified) + '</p>' +
            '<a href="' + data.downloadUrl + '" target="_blank" style="color:#38bdf8;font-size:1.1rem">⬇️ Download / View</a></div>';
          return;
        }

        // Stats
        const dirs = data.items.filter(i => i.type === 'directory').length;
        const files = data.items.filter(i => i.type === 'file').length;
        const statsEl = document.getElementById('stats');
        statsEl.style.display = 'flex';
        statsEl.innerHTML = '<span>📁 <strong>' + dirs + '</strong> folders</span><span>📄 <strong>' + files + '</strong> files</span><span>Total: <strong>' + data.count + '</strong> items</span>';

        if (data.items.length === 0) {
          document.getElementById('content').innerHTML = '<div class="empty">This directory is empty</div>';
          return;
        }

        let html = '<ul class="file-list">';
        data.items.forEach(item => {
          const icon = getIcon(item.type, item.name);
          if (item.type === 'directory') {
            html += '<li class="file-item" onclick="navigate(\\'' + item.path + '\\')">' +
              '<span class="file-icon">' + icon + '</span>' +
              '<span class="file-name"><a href="#" onclick="event.preventDefault()">' + item.name + '</a></span>' +
              '<span class="file-size"></span>' +
              '<span class="file-meta">' + formatDate(item.modified) + '</span></li>';
          } else {
            html += '<li class="file-item">' +
              '<span class="file-icon">' + icon + '</span>' +
              '<span class="file-name"><a href="' + item.url + '" target="_blank">' + item.name + '</a></span>' +
              '<span class="file-size">' + formatSize(item.size) + '</span>' +
              '<span class="file-meta">' + formatDate(item.modified) + '</span></li>';
          }
        });
        html += '</ul>';
        document.getElementById('content').innerHTML = html;
      } catch(err) {
        document.getElementById('content').innerHTML = '<div class="empty">Failed to load: ' + err.message + '</div>';
      }
    }

    navigate('');
  </script>
</body>
</html>`;
  }

module.exports = { registerWorkspaceAndStaticRoutes };
