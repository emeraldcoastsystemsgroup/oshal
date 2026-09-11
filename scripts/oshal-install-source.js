/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind cross-store replacement approval to observed provenance and recheck it at the filesystem mutation boundary.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SOURCE_CONFLICT_EXIT = 42;

/** Normalize Git's optional .git suffix and URL spelling, preserving case-sensitive repo paths. */
function canonicalRepo(repo) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  try {
    const url = new URL(repo.trim());
    if ((url.username && url.protocol !== 'ssh:') || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return url.href.replace(/\/+$/, '');
  } catch { return path.resolve(repo.trim()).replace(/[\\/]+$/, ''); }
}

/** Read the exact previous install; legacy or damaged stamps never imply a trusted source. */
function replacementFor(dest, name, incoming) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error('invalid package name');
  const target = path.join(path.resolve(dest), name);
  if (!fs.existsSync(target)) return null;
  let raw = '';
  let stamp = {};
  try {
    const file = path.join(target, '.oshal-install.json');
    if (fs.statSync(file).size > 64 * 1024) throw new Error('oversized provenance');
    raw = fs.readFileSync(file, 'utf8');
    stamp = JSON.parse(raw);
    if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) throw new Error('invalid provenance');
  } catch {
    // Include the local manifest when no usable stamp exists, so edits invalidate a preview.
    const manifest = path.join(target, 'oshal-app.yaml');
    raw += fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : String(fs.statSync(target).mtimeMs);
    stamp = {};
  }
  const fromRepo = canonicalRepo(stamp.repo);
  const toRepo = canonicalRepo(incoming.repo);
  const registryChanged = typeof stamp.registry === 'string' && !!incoming.registry && stamp.registry !== incoming.registry;
  if (fromRepo && fromRepo === toRepo && !registryChanged) return null;
  const from = {
    repo: fromRepo,
    registry: typeof stamp.registry === 'string' ? stamp.registry : null,
    ref: typeof stamp.ref === 'string' ? stamp.ref : null,
    sha: typeof stamp.sha === 'string' ? stamp.sha : null,
  };
  const to = { repo: toRepo, registry: incoming.registry || null };
  const token = createHash('sha256').update(JSON.stringify({ name, raw, to })).digest('hex');
  return { name, from, to, token };
}

/** A token is valid for one observed previous source and one requested replacement source. */
function assertInstallSource(dest, name, incoming, approval) {
  const replacement = replacementFor(dest, name, incoming);
  if (replacement && replacement.token !== approval) {
    const error = new Error(`source replacement requires confirmation: ${name} from ${replacement.from.repo || 'unknown local source'} to ${replacement.to.repo}. Review it in App Loader, or repeat this exact CLI install with --replace-source ${replacement.token}`);
    error.code = SOURCE_CONFLICT_EXIT;
    error.replacement = replacement;
    throw error;
  }
}

/** Serialize each package's final source check and write across installer child processes. */
function withInstallSourceLock(dest, name, action) {
  fs.mkdirSync(dest, { recursive: true });
  const lock = path.join(dest, `.oshal-install-${name}.lock`);
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    const error = new Error(`another install is changing ${name}; retry after it finishes`);
    error.code = SOURCE_CONFLICT_EXIT;
    throw error;
  }
  try { return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { SOURCE_CONFLICT_EXIT, canonicalRepo, replacementFor, assertInstallSource, withInstallSourceLock };
