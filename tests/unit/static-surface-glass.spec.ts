import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectIndexPages(dir: string): string[] {
  const entries = readdirSync(dir);
  const pages: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      pages.push(...collectIndexPages(fullPath));
    } else if (entry === 'index.html') {
      pages.push(fullPath);
    }
  }

  return pages;
}

function isExternallyOwnedSurface(page: string): boolean {
  return page.includes(`${path.sep}workflow-studio${path.sep}`);
}

describe('static page glass UX contract', () => {
  it('serves shared surface CSS before OIDC can redirect asset requests', () => {
    const server = readFileSync(path.join(process.cwd(), 'src/app/server.ts'), 'utf8');
    const cssMount = server.indexOf("app.use('/shared/ui/css'");
    const oidcMount = server.indexOf('app.use(authMiddleware)');

    expect(cssMount).toBeGreaterThan(-1);
    expect(oidcMount).toBeGreaterThan(-1);
    expect(cssMount).toBeLessThan(oidcMount);
  });

  it('serves browser bundles publicly before OIDC or guest identity resolution', () => {
    const server = readFileSync(path.join(process.cwd(), 'src/app/server.ts'), 'utf8');
    const distMount = server.indexOf("app.use('/dist'");
    const distMountEnd = server.indexOf('\n', distMount);
    const oidcMount = server.indexOf('app.use(authMiddleware)');

    expect(distMount).toBeGreaterThan(-1);
    expect(oidcMount).toBeGreaterThan(-1);
    expect(distMount).toBeLessThan(oidcMount);
    expect(server.slice(distMount, distMountEnd)).not.toContain('requiresAuth');
  });

  it('serves shared design CSS network-first from the cockpit service worker', () => {
    const serviceWorker = readFileSync(path.join(process.cwd(), 'src/pages/cockpit/service-worker.js'), 'utf8');
    const sharedCssBranch = serviceWorker.indexOf("url.pathname.startsWith('/shared/ui/css/')");
    const staticAssetBranch = serviceWorker.indexOf('caches.match(request).then((cached)');

    expect(sharedCssBranch).toBeGreaterThan(-1);
    expect(staticAssetBranch).toBeGreaterThan(-1);
    expect(sharedCssBranch).toBeLessThan(staticAssetBranch);
    expect(serviceWorker).toContain("fetch(request, { redirect: 'manual', cache: 'reload' })");
  });

  it('packages shared design CSS into every production Docker image layout', () => {
    for (const dockerfile of ['Dockerfile', 'Dockerfile.oshal']) {
      const content = readFileSync(path.join(process.cwd(), dockerfile), 'utf8');

      expect(content, dockerfile).toContain('dist/shared/ui/css');
      expect(content, dockerfile).toContain('src/shared/ui/css');
    }
  });

  it('does not override core cockpit theme tokens from the additive glass sheet', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/shared/ui/css/surface-glass.css'), 'utf8');
    const forbiddenTokenAssignments = [
      '--bg-secondary',
      '--bg-tertiary',
      '--bg-card',
      '--bg-card-hover',
      '--glass-bg',
      '--glass-bg-heavy',
      '--border-color',
      '--text-primary',
      '--text-secondary',
    ];

    for (const token of forbiddenTokenAssignments) {
      expect(css, token).not.toMatch(new RegExp(`(^|\\n)\\s*${token}\\s*:`));
    }
  });

  it('does not hijack generic app layout selectors from the shared glass sheet', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/shared/ui/css/surface-glass.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const forbiddenGenericSelectors = {
      '.hero': /(^|[\s,(])\.hero([,{:\s)]|$)/,
      '.panel': /(^|[\s,(])\.panel([,{:\s)]|$)/,
      '.card': /(^|[\s,(])\.card([,{:\s)]|$)/,
      '.tile': /(^|[\s,(])\.tile([,{:\s)]|$)/,
      '.item': /(^|[\s,(])\.item([,{:\s)]|$)/,
      '.message': /(^|[\s,(])\.message([,{:\s)]|$)/,
      '.chat-panel': /(^|[\s,(])\.chat-panel([,{:\s)]|$)/,
      button: /(^|[\s,(])button([,{:\s.#)]|$)/,
      input: /(^|[\s,(])input([,{:\s.#)]|$)/,
      textarea: /(^|[\s,(])textarea([,{:\s.#)]|$)/,
      select: /(^|[\s,(])select([,{:\s.#)]|$)/,
    };

    for (const [selector, pattern] of Object.entries(forbiddenGenericSelectors)) {
      expect(css, selector).not.toMatch(pattern);
    }
  });

  it('loads the shared surface-glass stylesheet on every static page', () => {
    const pagesDir = path.join(process.cwd(), 'src/pages');
    const pages = collectIndexPages(pagesDir).filter((page) => !isExternallyOwnedSurface(page));

    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      expect(html, path.relative(process.cwd(), page)).toContain('/shared/ui/css/surface-glass.css');
    }
  });

  it('loads surface-glass after local page styles where local styles exist', () => {
    const pagesDir = path.join(process.cwd(), 'src/pages');
    const pages = collectIndexPages(pagesDir).filter((page) => !isExternallyOwnedSurface(page));

    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const glassIndex = html.indexOf('/shared/ui/css/surface-glass.css');
      const pageName = path.basename(path.dirname(page));
      const localStyleIndex = html.indexOf(`/${pageName}/${pageName}.css`);

      if (localStyleIndex >= 0) {
        expect(glassIndex, path.relative(process.cwd(), page)).toBeGreaterThan(localStyleIndex);
      }
    }
  });
});
