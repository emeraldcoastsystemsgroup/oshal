/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: optional loopback-only static server for this directory.
 */
// Serve only this mockup directory on the loopback interface.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const port = Number(process.env.MOCKUP_PORT || 4319);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
 if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
 let pathname;
 try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
 const target = path.resolve(root, '.' + pathname.replace(/\/$/, '/index.html'));
 const relative = path.relative(root, target);
 if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
 fs.stat(target, (error, stat) => {
  if (error || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
 });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`OSHAL home mockups: http://127.0.0.1:${port}/`));
