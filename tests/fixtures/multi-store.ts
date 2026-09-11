/** Local Git stores for exercising real installer and browser boundaries without live services. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const audit = require('../../scripts/oshal-package-audit') as { PACKAGE_AUDIT_CONTROLS: string[] };

export function createStore(root: string, packages = [{ name: 'sample-app', deps: [] as string[] }]) {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  mkdirSync(join(root, 'audits'));
  const repo = pathToFileURL(root).href;
  const apps = packages.map(({ name, deps }) => {
    const sourcePath = name === 'sample-app' ? 'source-folder' : name;
    mkdirSync(join(root, sourcePath));
    writeFileSync(join(root, sourcePath, 'oshal-app.yaml'), [
      `name: ${name}`, `displayName: ${name}`, 'version: 1.0.0', 'suite: ai-engineering',
      `dependencies:\n  apps: ${JSON.stringify(deps)}`,
      'routes:\n  - mountPath: /api/sample-app\n    module: routes/index.js\n    factory: createRoutes\n    auth: session',
    ].join('\n'));
    const sourceSha = '0'.repeat(40);
    writeFileSync(join(root, 'audits', `${name}.json`), JSON.stringify({
      profileVersion: 1, app: name, version: '1.0.0', sourceSha, status: 'pending', auditedAt: null,
      controls: Object.fromEntries(audit.PACKAGE_AUDIT_CONTROLS.map(key => [key, 'pending'])), evidence: [],
    }, null, 2) + '\n');
    return { name, displayName: name, description: 'Local test package', version: '1.0.0', suite: 'ai-engineering', status: 'ready',
      source: { type: 'git-subdir', url: repo, path: sourcePath, ref: 'main' }, audit: { record: `audits/${name}.json`, sourceSha } };
  });
  writeFileSync(join(root, 'marketplace.json'), JSON.stringify({ version: 1, apps }));
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, '-c', 'user.name=OSHAL tests', '-c', 'user.email=maintainer@emeraldcoastsystemsgroup.com', 'commit', '-m', 'local fixture'], { stdio: 'pipe' });
  return { repo, apps };
}
