/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for kernel manifests' authorization catalogs. swarm-apps/jarvis.yaml declares `catalog: swarm-apps/jarvis-authorization.yaml`, spelled from the platform root, which is how the native kernel reads it (and the running native kernel reads this very tree), while this repository's confined loader joined it to swarm-apps/ and failed with ENOENT 'swarm-apps/swarm-apps' - the evidence nightly's audit proof, the manifests gate and every legacy boot. The catalog file itself was then loaded as a manifest by every scan. Every case uses the real loader, the real shared contract and the real filesystem: each kernel manifest's catalog loads, names the same file the native rule reads from the platform root, and stays out of the boot scan; the root-relative spelling is translated only inside a swarm-apps directory and stays confined there (no dot segments, no symlinks, no reach outside); a declared catalog is skipped by scans while a manifest-shaped file never is; and the ledger gate passes on the real tree.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { listManifestFiles, readManifest } from '../../src/features/swarm-apps';
import { declaredCatalogFiles, loadApplicationAuthorization, parseAuthorizationCatalog } from '../../src/shared/application-authorization';

const ROOT = resolve(__dirname, '../..');
const KERNEL_DIR = join(ROOT, 'swarm-apps');
/** A catalog the shared contract validates, taken from the shipped one so the fixture cannot drift into invalidity. */
const CATALOG = readFileSync(join(KERNEL_DIR, 'jarvis-authorization.yaml'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'oshal-kernel-catalog-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;

/** @description The flat kernel manifests that declare an authorization catalog, and the value each declares. */
function declaring(): Array<{ file: string; manifest: { uses?: unknown; authorization?: { catalog?: unknown } }; catalog: string }> {
  return readdirSync(KERNEL_DIR).filter((name) => name.endsWith('.yaml')).flatMap((name) => {
    const manifest = yaml.load(readFileSync(join(KERNEL_DIR, name), 'utf8')) as { name?: unknown; uses?: unknown; authorization?: { catalog?: unknown } };
    const catalog = manifest?.authorization?.catalog;
    return manifest?.name && typeof catalog === 'string' ? [{ file: join(KERNEL_DIR, name), manifest, catalog }] : [];
  });
}

/** @description A fresh directory named `name` under the scratch tree. @returns its path. */
function dir(name: string): string {
  seq += 1;
  const path = join(scratch, `case-${seq}`, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** @description The manifest shape loadApplicationAuthorization reads, declaring `catalog`. */
const declare = (catalog: string) => ({ uses: ['application-authorization'], authorization: { version: 1, catalog } });

describe('every kernel manifest\'s catalog resolves in both runtimes', () => {
  it('jarvis.yaml still declares the root-relative spelling the native kernel reads', () => {
    // Changing the value would change bytes the running native kernel has admitted from this tree.
    expect(declaring().map((d) => [d.file.slice(ROOT.length + 1), d.catalog])).toContainEqual(['swarm-apps/jarvis.yaml', 'swarm-apps/jarvis-authorization.yaml']);
  });

  it('loads each declared catalog through the real loader, and it is the file the native rule reads from the platform root', () => {
    for (const { file, manifest, catalog } of declaring()) {
      const legacy = loadApplicationAuthorization(dirname(file), manifest);
      expect(legacy, file).not.toBeNull();
      // The native rule (oshal-kernel crates/oshald/src/platform_apps.rs: the package directory of a
      // platform declaration is the platform ROOT; crates/packages/src/application_authorization.rs
      // read_catalog: join each segment to it, refuse a symlinked segment or a path that leaves it).
      let target = ROOT;
      for (const segment of catalog.split('/')) {
        target = join(target, segment);
        expect(lstatSync(target).isSymbolicLink(), `${file}: ${target}`).toBe(false);
      }
      expect(statSync(target).isFile(), `${file}: ${target}`).toBe(true);
      expect(realpathSync(target).startsWith(realpathSync(ROOT) + sep), target).toBe(true);
      expect(legacy, `${file}: both runtimes must read the same catalog`).toEqual(parseAuthorizationCatalog(readFileSync(target, 'utf8')));
    }
  });

  it('loads every manifest the boot scan returns, and the declared catalog is not one of them', () => {
    const kernel = listManifestFiles().filter((file) => dirname(file) === KERNEL_DIR);
    const names = kernel.map((file) => file.slice(KERNEL_DIR.length + 1));
    expect(names).toContain('jarvis.yaml');
    expect(names).not.toContain('jarvis-authorization.yaml');
    for (const file of kernel) expect(() => readManifest(file), file).not.toThrow();
    expect([...declaredCatalogFiles(KERNEL_DIR)]).toEqual(['jarvis-authorization.yaml']);
  });

  it('passes the ai-usage ledger gate on this tree (the catalog is not an unrated manifest)', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ai-usage-ledger.js'), '--core', ROOT, '--check', join(ROOT, 'docs/apps/ai-usage-ledger.md')],
      { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });
});

describe('the root-relative spelling is translated only inside swarm-apps, and stays confined there', () => {
  it('reads `swarm-apps/<file>` and `<file>` alike from a swarm-apps directory', () => {
    const kernel = dir('swarm-apps');
    writeFileSync(join(kernel, 'c.yaml'), CATALOG);
    const expected = parseAuthorizationCatalog(CATALOG);
    expect(loadApplicationAuthorization(kernel, declare('swarm-apps/c.yaml'))).toEqual(expected);
    expect(loadApplicationAuthorization(kernel, declare('c.yaml'))).toEqual(expected);
  });

  it('leaves a package directory with any other name exactly as it was', () => {
    const pkg = dir('pkg');
    writeFileSync(join(pkg, 'c.yaml'), CATALOG);
    expect(() => loadApplicationAuthorization(pkg, declare('swarm-apps/c.yaml'))).toThrow(/ENOENT/);
    mkdirSync(join(pkg, 'swarm-apps'));
    writeFileSync(join(pkg, 'swarm-apps', 'c.yaml'), CATALOG);
    expect(loadApplicationAuthorization(pkg, declare('swarm-apps/c.yaml'))).toEqual(parseAuthorizationCatalog(CATALOG));
  });

  it('still refuses dot segments, an absolute path and a symlink under the translated spelling', () => {
    const kernel = dir('swarm-apps');
    writeFileSync(join(dirname(kernel), 'outside.yaml'), CATALOG);
    expect(() => loadApplicationAuthorization(kernel, declare('swarm-apps/../outside.yaml'))).toThrow(/catalog path escapes package/);
    expect(() => loadApplicationAuthorization(kernel, declare('/swarm-apps/outside.yaml'))).toThrow(/catalog path escapes package/);
    symlinkSync(join(dirname(kernel), 'outside.yaml'), join(kernel, 'link.yaml'));
    expect(() => loadApplicationAuthorization(kernel, declare('swarm-apps/link.yaml'))).toThrow(/catalog symlinks are forbidden/);
  });
});

describe('a scan skips only a catalog a sibling manifest declares', () => {
  it('claims a declared catalog under either spelling, and nothing else', () => {
    const kernel = dir('swarm-apps');
    writeFileSync(join(kernel, 'a.yaml'), 'name: a\nauthorization:\n  version: 1\n  catalog: swarm-apps/a-auth.yaml\n');
    writeFileSync(join(kernel, 'b.yaml'), 'name: b\nauthorization:\n  version: 1\n  catalog: b-auth.yaml\n');
    writeFileSync(join(kernel, 'a-auth.yaml'), CATALOG);
    writeFileSync(join(kernel, 'b-auth.yaml'), CATALOG);
    writeFileSync(join(kernel, 'stray-auth.yaml'), CATALOG);
    expect([...declaredCatalogFiles(kernel)].sort()).toEqual(['a-auth.yaml', 'b-auth.yaml']);
  });

  it('never claims a manifest-shaped file, so one manifest cannot hide another from a scan', () => {
    const kernel = dir('swarm-apps');
    writeFileSync(join(kernel, 'a.yaml'), 'name: a\nauthorization:\n  version: 1\n  catalog: swarm-apps/b.yaml\n');
    writeFileSync(join(kernel, 'b.yaml'), 'name: b\ndisplayName: B\n');
    expect([...declaredCatalogFiles(kernel)]).toEqual([]);
  });

  it('claims nothing in a directory it cannot read', () => {
    expect([...declaredCatalogFiles(join(scratch, 'no-such-directory'))]).toEqual([]);
  });
});
