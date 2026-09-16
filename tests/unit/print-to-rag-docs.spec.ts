/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for BACKLOG "print-to-rag has no user guide and no page on the site". Two halves, both against the real tree rather than a copy of it. THE GUIDE: docs/guides/printing.md must be served by the in-product help hub (the real listGuides/resolveGuideFile over the real corpus) and indexed from the guides README — as must every guide on disk, since a guide nobody can reach from the index is the defect the entry named. Every switch, flag, route and message the guide tells a person to set or look for must still exist in the file that owns it, and each "not yet" statement it makes is pinned in reverse, so a rename or a fix sends the next person back to the guide instead of leaving it stale. THE SITE: publish state is the store registry's `status: ready`, never a package manifest's install-state `status:` (print-ingest installs inactive by ADR-135 D11) — driven through the real catalog builder and page renderer against a fixture store trunk (OSHAL_STORE_DIR), plus the committed print-ingest page itself.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listGuides, resolveGuideFile, resolveGuidesDir } from '@/app/routes/help-routes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gen = require('../../scripts/site-product-pages.js') as {
  renderAll: (model: SiteModel) => Map<string, string>;
};

interface SiteModel {
  missingStore?: boolean;
  apps: Array<{ name: string }>;
  withheld: { kernel: string[]; store: string[] };
}

const REPO = path.resolve(__dirname, '..', '..');
const GUIDE = 'docs/guides/printing.md';

/** Reads a repo file as text. */
function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** The guide's text — empty when absent, so every case fails on its own assertion, not in setup. */
function guideText(): string {
  const file = path.join(REPO, GUIDE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** True when `text` contains the literal or matches the pattern, whitespace runs collapsed so a
 *  rewrapped markdown line is not mistaken for a removed one. */
function has(text: string, needle: string | RegExp): boolean {
  const flat = text.replace(/\s+/g, ' ');
  return typeof needle === 'string' ? flat.includes(needle.replace(/\s+/g, ' ')) : needle.test(flat);
}

/**
 * What the guide tells a person to set, type or look for, and the file that owns each one.
 * `code` is given only where the owner spells it differently from the sentence in the guide.
 */
const NAMED_IN_CODE: Array<{ says: string | RegExp; owner: string; code?: string | RegExp }> = [
  { says: 'printServiceEnabled', owner: 'packages/oshal-chat/src/main/config.ts' },
  { says: 'printServicePort', owner: 'packages/oshal-chat/src/main/config.ts' },
  { says: 'printServiceSpoolDir', owner: 'packages/oshal-chat/src/main/config.ts' },
  { says: 'OSHAL_PRINT_SERVICE=true', owner: 'packages/oshal-chat/src/main/config.ts', code: /if \(OSHAL_PRINT_SERVICE\)/ },
  { says: 'OSHAL_PRINT_SERVICE_PORT', owner: 'packages/oshal-chat/src/main/config.ts' },
  { says: 'OSHAL_PRINT_SERVICE_DIR', owner: 'packages/oshal-chat/src/main/config.ts' },
  { says: 'OSHAL_PRINT_DROP_ENTRY', owner: 'packages/oshal-chat/src/main/print-service.ts' },
  { says: '`print-spool`', owner: 'packages/oshal-chat/src/main/print-service.ts', code: "'print-spool'" },
  { says: 'Print service not started', owner: 'packages/oshal-chat/src/main/print-service.ts' },
  { says: 'Check whether another print-drop instance holds the port', owner: 'packages/oshal-chat/src/main/print-service.ts' },
  { says: 'Swarm tasks on this machine', owner: 'packages/oshal-chat/src/renderer/index.html' },
  { says: 'OSHAL_PRINT_INTAKE_TOKEN', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: '--intake-url', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: '--formats', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: 'OSHAL_PRINT_FORMATS', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: 'oshal print to rag - ', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: '/ipp/print', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: 'not delivered - no recoverable text in this document', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: 'swarm delivery failed - the document is kept locally for retry', owner: 'packages/oshal-print-drop/bin/print-drop.js' },
  { says: 'npm run diagnose', owner: 'packages/oshal-print-drop/package.json', code: '"diagnose":' },
  { says: 'install-startup-task.ps1 -AtStartup', owner: 'packages/oshal-print-drop/scripts/install-startup-task.ps1', code: '[switch] $AtStartup' },
  { says: 'application/vnd.ms-xpsdocument', owner: 'packages/oshal-print-drop/lib/spooler.js' },
  { says: 'application/oxps', owner: 'packages/oshal-print-drop/lib/spooler.js' },
  // The table's two load-bearing facts: text comes only from XPS, and PDF is advertised first by default.
  { says: 'text is read only from XPS', owner: 'packages/oshal-print-drop/lib/spooler.js', code: "if (extension !== 'xps') return null;" },
  { says: 'printer advertising PDF first (the default)', owner: 'packages/oshal-print-drop/lib/printer-attributes.js', code: "DEFAULT_FORMATS = ['application/pdf'" },
  { says: '/api/print-ingest/documents', owner: 'src/app/routes/remote-client-print-routes.ts' },
  { says: 'Application inactive', owner: 'src/app/middleware/swarm-app-gate-middleware.ts' },
  { says: '/api/cli-tokens', owner: 'src/app/server.ts', code: "app.use('/api/cli-tokens'" },
];

/** The body of one top-level function in a source file, for a claim about what it does NOT read. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('printing user guide', () => {
  it('is served by the in-product help hub under its own title', () => {
    const dir = resolveGuidesDir();
    expect(dir).toBeTruthy();
    const entry = listGuides(dir as string).find((g) => g.slug === 'printing');
    expect(entry?.title).toBe('Printing to the swarm');
    expect(resolveGuideFile(dir as string, 'printing')).toBe(path.join(dir as string, 'printing.md'));
  });

  it('is reachable from the guides README, as is every other guide on disk', () => {
    const readme = read('docs/guides/README.md');
    const linked = new Set([...readme.matchAll(/\]\(\.\/([a-z0-9-]+)\.md\)/g)].map((m) => m[1]));
    const onDisk = fs.readdirSync(path.join(REPO, 'docs', 'guides'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3));
    expect(onDisk).toContain('printing');
    expect(onDisk.filter((slug) => !linked.has(slug)), 'guides the README index never links').toEqual([]);
  });

  it('names only switches, flags, routes and messages that exist in the file that owns them', () => {
    const guide = guideText();
    const drift: string[] = [];
    for (const anchor of NAMED_IN_CODE) {
      if (!has(guide, anchor.says)) drift.push(`${GUIDE} does not say ${String(anchor.says)}`);
      if (!has(read(anchor.owner), anchor.code ?? anchor.says)) drift.push(`${anchor.owner} no longer has ${String(anchor.code ?? anchor.says)}`);
    }
    expect(drift).toEqual([]);
  });

  it('every "not yet" it states is still true — a fix here must update the guide', () => {
    const guide = guideText();
    // The Get oshal node installs @oshal/chat from npm; print-drop is neither its dependency nor published.
    expect(guide).toContain('does **not** include it');
    expect(read('src/app/routes/node-installer-routes.ts')).toContain("'@oshal/chat'");
    expect(JSON.parse(read('packages/oshal-chat/package.json')).dependencies ?? {}).not.toHaveProperty('@oshal/print-drop');
    expect(JSON.parse(read('packages/oshal-print-drop/package.json')).private).toBe(true);
    // Get oshal offers no printer.
    expect(guide).toContain('Get oshal has no printer tile');
    expect(read('src/pages/cockpit/tools/devices.html')).not.toMatch(/printer|print to rag/i);
    // The node app renders worker events by intent/phase/text/error; the printer sends {type:'log', message}.
    expect(guide).toContain("does not display the printer's own messages yet");
    expect(read('packages/oshal-chat/src/main/main.ts')).toContain("send('worker:event', { type: 'log', message })");
    expect(functionBody(read('packages/oshal-chat/src/renderer/renderer.js'), 'applyWorkerEvent')).not.toMatch(/\.message\b/);
    // The primary compose stack passes the API an explicit environment list without the bot-destination variable.
    expect(guide).toContain('does not carry `PRINT_INGEST_BOT_DESTINATIONS`');
    const compose = read('docker-compose.oshal-local.yml');
    expect(compose).not.toContain('PRINT_INGEST_BOT_DESTINATIONS');
    expect(compose).not.toMatch(/^\s*env_file:/m);
  });
});

describe('product site: install state is not publish state', () => {
  it('print-ingest has a committed product page although its package installs inactive', () => {
    const page = read('site/oswarm.ai/product/apps/print-ingest/index.html');
    expect(page).toContain('<title>Print Ingest');
    expect(page).toContain('?app=print-ingest');
  });

  it('renders a registry-ready package that installs inactive, and withholds one the registry has not readied', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-store-fixture-'));
    const pkg = (name: string, status: string, label: string) => {
      fs.mkdirSync(path.join(store, name));
      fs.writeFileSync(path.join(store, name, 'oshal-app.yaml'), [
        `name: ${name}`, 'suite: ai-knowledge', `displayName: ${label}`,
        'description: A fixture package. It exists to be published or withheld.', 'version: 0.1.0',
        `status: ${status}`, 'ui:', '  static:', `    - toolName: ${name}`, `      label: ${label} Screen`,
        `      iframeUrl: /api/${name}/app`, '',
      ].join('\n'));
    };
    pkg('installs-inactive', 'inactive', 'Installs Inactive');
    pkg('registry-withheld', 'active', 'Registry Withheld');
    const entry = (name: string, displayName: string, status: string) => ({
      name, displayName, status, suite: 'ai-knowledge', version: '0.1.0',
      description: 'A fixture package. It exists to be published or withheld.',
    });
    fs.writeFileSync(path.join(store, 'marketplace.json'), JSON.stringify({ apps: [
      entry('installs-inactive', 'Installs Inactive', 'ready'),
      entry('registry-withheld', 'Registry Withheld', 'draft'),
    ] }));

    const original = process.env.OSHAL_STORE_DIR;
    const mod = path.join(REPO, 'scripts', 'lib', 'product-site', 'catalog.js');
    process.env.OSHAL_STORE_DIR = store;
    try {
      delete require.cache[mod];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const catalog = require(mod) as { build: () => SiteModel };
      const model = catalog.build();
      expect(model.missingStore).toBeFalsy();
      const names = model.apps.map((a) => a.name);
      expect(names).toContain('installs-inactive');
      expect(names).not.toContain('registry-withheld');
      expect(model.withheld.store).toContain('registry-withheld');

      const pages = gen.renderAll(model);
      const page = pages.get(path.join('product', 'apps', 'installs-inactive', 'index.html')) ?? '';
      expect(page).toContain('Installs Inactive Screen');
      expect(page).toContain('?app=installs-inactive');
      expect(pages.has(path.join('product', 'apps', 'registry-withheld', 'index.html'))).toBe(false);
    } finally {
      delete require.cache[mod];
      if (original === undefined) delete process.env.OSHAL_STORE_DIR;
      else process.env.OSHAL_STORE_DIR = original;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
