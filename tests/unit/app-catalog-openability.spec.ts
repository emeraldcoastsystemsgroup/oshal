/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The regression guard for the applications catalog. It decided openability from a hand-typed WORKING array plus "manifestPath contains deployed-apps", so a store package passed on its path while a CORE manifest could only pass by being typed in — and five shipped apps with real rail surfaces (security-center, workflow-studio, intelligent-processing, person-model, oshal-engineering) rendered a disabled "Coming soon" button in the screen that is supposed to be the inventory of truth. These cases drive the REAL core manifests off disk through the REAL loader, the REAL summary projection and the REAL page decision, so any name list re-introduced between them turns this red; the page-shape cases are what catch a list added straight back into the HTML, which a module-only test would never see.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';
import { hasCockpitSurface, toSummary } from '../../src/features/swarm-apps/services/swarm-app-record-view';
import { catalogRank, isOpenable, openControl } from '../../src/pages/applications/js/app-catalog-openability.js';
import type { SwarmAppManifest, SwarmApplicationRecord, SwarmApplicationSummary } from '../../src/features/swarm-apps/types';

const REPO_ROOT = join(__dirname, '..', '..');
const PAGE = join(REPO_ROOT, 'src', 'pages', 'applications', 'index.html');

/** The kernel-resident core manifests (Rule 0c) — the set the hand-typed allowlist never kept up with. */
const CORE_MANIFESTS: readonly string[] = [
  'codex-packer.yaml', 'devops.yaml', 'intelligent-operations.yaml', 'intelligent-processing.yaml',
  'jarvis.yaml', 'oshal-dev.yaml', 'oshal-engineering.yaml', 'person-model.yaml',
  'security.yaml', 'workflow-studio.yaml',
];

/**
 * @description Read one real core manifest off disk through the real loader.
 * @param file - File name under swarm-apps/.
 * @returns The parsed manifest.
 */
function coreManifest(file: string): SwarmAppManifest {
  return readManifest(join(REPO_ROOT, 'swarm-apps', file));
}

/**
 * @description Project a manifest into the listing summary the catalog actually consumes, through
 * the real toSummary — so a derivation that stops populating hasSurface fails here rather than
 * silently greying out every row in the browser.
 * @param manifest - A real manifest.
 * @param manifestPath - Where the file sits; varied to prove the path no longer decides anything.
 * @returns The summary entry GET /api/swarm/apps would serialize.
 */
function summaryFor(manifest: SwarmAppManifest, manifestPath?: string): SwarmApplicationSummary {
  const record = {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description ?? '',
    version: manifest.version ?? '1.0.0',
    status: 'active',
    agentIds: [],
    toolNames: [],
    manifest,
    manifestPath: manifestPath ?? join(REPO_ROOT, 'swarm-apps', `${manifest.name}.yaml`),
    loadedAt: new Date(0),
    updatedAt: new Date(0),
    scope: 'public',
    ownerSub: null,
    tenantId: null,
  } as unknown as SwarmApplicationRecord;
  return toSummary(record, null);
}

/** Every core manifest that declares a surface a cockpit can open. */
const WITH_SURFACE = CORE_MANIFESTS.map(coreManifest).filter((m) => hasCockpitSurface(m));
/** Every core manifest that declares none — genuinely headless, not unfinished. */
const HEADLESS = CORE_MANIFESTS.map(coreManifest).filter((m) => !hasCockpitSurface(m));

describe('app catalog openability is derived from the manifest', () => {
  it('finds both kinds of core app on disk, so neither case below can pass vacuously', () => {
    expect(WITH_SURFACE.length).toBeGreaterThan(0);
    expect(HEADLESS.length).toBeGreaterThan(0);
    expect(WITH_SURFACE.length + HEADLESS.length).toBe(CORE_MANIFESTS.length);
  });

  // THE REGRESSION. Each of these ships a rail surface, and each rendered a disabled "Coming soon"
  // button purely because its name was not typed into the page's WORKING array.
  it.each(WITH_SURFACE.map((m) => [m.name, m] as const))(
    'offers Open on %s, which declares a real surface',
    (_name, manifest) => {
      const app = summaryFor(manifest);
      expect(app.hasSurface).toBe(true);
      const control = openControl(app);
      expect(control.openable).toBe(true);
      expect(isOpenable(app)).toBe(true);
      expect(control.label).not.toMatch(/coming soon/i);
      expect(control.title).not.toMatch(/coming soon|not ready/i);
    },
  );

  it.each(HEADLESS.map((m) => [m.name, m] as const))(
    'tells the truth about %s, which declares no surface at all',
    (_name, manifest) => {
      const app = summaryFor(manifest);
      expect(app.hasSurface).toBe(false);
      const control = openControl(app);
      expect(control.openable).toBe(false);
      // Truthful about WHY, and never a claim that a shipped app is unfinished.
      expect(control.title).toMatch(/no cockpit surface/i);
      expect(control.label).not.toMatch(/coming soon/i);
      expect(control.title).not.toMatch(/coming soon|not ready|backlog/i);
    },
  );

  it('sorts openable apps ahead of headless ones without consulting a name', () => {
    expect(catalogRank(summaryFor(WITH_SURFACE[0]))).toBeLessThan(catalogRank(summaryFor(HEADLESS[0])));
  });

  // The other half of the defect: a store package passed because its path said deployed-apps, and
  // that is the only reason core manifests were the ones left behind.
  it('does not care where the manifest file sits on disk', () => {
    for (const manifest of [WITH_SURFACE[0], HEADLESS[0]]) {
      const fromCore = summaryFor(manifest, '/app/swarm-apps/x.yaml');
      const fromDeployed = summaryFor(manifest, '/workspace/deployed-apps/x/oshal-app.yaml');
      expect(isOpenable(fromDeployed)).toBe(isOpenable(fromCore));
    }
  });

  it('derives the surface signal from ui.static, ui.dynamic and a group toolbar alike', () => {
    const decl = (body: unknown): SwarmAppManifest => body as SwarmAppManifest;
    expect(hasCockpitSurface(decl({ ui: { static: [{ toolName: 't', label: 'L', icon: 'i', iframeUrl: '/x' }] } }))).toBe(true);
    expect(hasCockpitSurface(decl({ ui: { dynamic: { source: 's' } } }))).toBe(true);
    expect(hasCockpitSurface(decl({ kind: 'group', toolbar: [{ app: 'a', surface: 's' }] }))).toBe(true);
    expect(hasCockpitSurface(decl({ ui: { static: [] } }))).toBe(false);
    expect(hasCockpitSurface(decl({ kind: 'group', toolbar: [] }))).toBe(false);
    expect(hasCockpitSurface(decl({}))).toBe(false);
    expect(hasCockpitSurface(undefined)).toBe(false);
  });

  it('never reads openability off the icon, which a tile does not have to carry', () => {
    const noIcon = { ui: { static: [{ toolName: 't', label: 'L', icon: '', iframeUrl: '/x' }] } } as unknown as SwarmAppManifest;
    expect(hasCockpitSurface(noIcon)).toBe(true);
  });
});

describe('the catalog page keeps no inventory of its own', () => {
  const html = readFileSync(PAGE, 'utf8');
  // The executable page, with HTML comments stripped. The assertions below are about what the page
  // DOES, and a comment recording why the old allowlist was removed has to stay sayable — a guard
  // that forbade naming the defect would only teach the next person to delete the explanation.
  const script = html.replace(/<!--[\s\S]*?-->/g, '');

  it('reads the shared, manifest-derived decision instead of deciding inline', () => {
    expect(script).toMatch(/import\s*\{[^}]*openControl[^}]*\}\s*from\s*'\/applications\/js\/app-catalog-openability\.js'/);
  });

  it('carries no hand-typed app allowlist', () => {
    expect(script).not.toMatch(/\bWORKING\b/);
    expect(script).not.toMatch(/\bPREVIEW\b/);
    // The shape, not only those two names: a literal list of known app names in this page is the
    // defect whatever the next person calls it.
    for (const name of ['jarvis', 'career-hunter', 'security-center', 'workflow-studio', 'person-model', 'gov-contracting']) {
      expect(script).not.toMatch(new RegExp(`'${name}'\\s*[,\\]]`));
    }
  });

  it('never tells a viewer that a loaded app is coming soon', () => {
    expect(script).not.toMatch(/Coming soon/);
    expect(script).not.toMatch(/tracked in BACKLOG/i);
  });

  it('no longer decides anything from the manifest path', () => {
    expect(script).not.toMatch(/manifestPath[^\n]*includes\(\s*'deployed-apps'\s*\)/);
  });
});
