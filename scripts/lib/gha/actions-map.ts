/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — maps `uses:` marketplace actions to local equivalents for gha-local: checkout/cache→noop, setup-node→version check, artifacts→local dir, docker build-push→local build (NEVER push), login→skip, trivy→dockerized scan, metadata→synthesized outputs. Unknown actions are reported, never silently dropped.
 */

/** How one `uses:` step executes locally. */
export interface MappedAction {
  /** noop = nothing to do locally; shell = run this command; artifact = copy paths;
   *  outputs = synthesize step outputs; skip = deliberately not run locally; unknown = unmapped. */
  kind: 'noop' | 'shell' | 'artifact' | 'outputs' | 'skip' | 'unknown';
  note: string;
  /** For kind shell: the command (bash). */
  cmd?: string;
  /** For kind artifact: name + newline-separated source paths from `with.path`. */
  artifact?: { name: string; paths: string[] };
  /** For kind outputs: the synthesized step outputs. */
  outputs?: Record<string, string>;
}

/** Strips the @version suffix: actions/checkout@v4 → actions/checkout. */
export function actionName(uses: string): string {
  return uses.split('@')[0].toLowerCase();
}

/**
 * @description Maps one `uses:` action (+ its interpolated `with:`) to its local execution.
 * The mapping philosophy: a local run VERIFIES and BUILDS but never publishes — pushes and
 * registry logins are skipped by design, artifacts land in a local folder, caches are moot
 * because the workspace persists.
 * @param uses - the raw uses value (e.g. actions/checkout@v4)
 * @param withArgs - the step's `with:` map, already expression-interpolated
 * @param gitSha - local HEAD sha (for docker/metadata tag synthesis)
 * @returns the mapped local action
 */
export function mapAction(uses: string, withArgs: Record<string, string>, gitSha = 'local'): MappedAction {
  const name = actionName(uses);

  switch (name) {
    case 'actions/checkout':
      return { kind: 'noop', note: 'checkout — already in a local working copy' };
    case 'actions/cache':
    case 'actions/cache/restore':
    case 'actions/cache/save':
      return { kind: 'noop', note: 'cache — local workspace persists between runs' };
    case 'actions/setup-node': {
      const want = withArgs['node-version'] || '';
      return {
        kind: 'shell',
        note: `setup-node — verify local node${want ? ` (workflow wants ${want}.x)` : ''}`,
        cmd: want
          ? `node -e "const w='${want}'.split('.')[0]; const h=process.versions.node.split('.')[0]; console.log('node '+process.versions.node+' (workflow wants '+w+'.x)'); if(+h < +w) { console.error('local node major < workflow requirement'); process.exit(1); }"`
          : 'node --version',
      };
    }
    case 'actions/setup-python':
      return { kind: 'shell', note: 'setup-python — verify local python', cmd: 'python --version || python3 --version' };
    case 'actions/upload-artifact': {
      const artifact = { name: withArgs.name || 'artifact', paths: (withArgs.path || '').split('\n').map((s) => s.trim()).filter(Boolean) };
      return { kind: 'artifact', note: `upload-artifact — copy to .gha-local/artifacts/${artifact.name}/`, artifact };
    }
    case 'actions/download-artifact': {
      const artifact = { name: withArgs.name || 'artifact', paths: [withArgs.path || '.'] };
      return { kind: 'artifact', note: `download-artifact — restore from .gha-local/artifacts/${artifact.name}/`, artifact };
    }
    case 'docker/setup-buildx-action':
      return { kind: 'shell', note: 'setup-buildx — verify docker is available', cmd: 'docker version --format "docker {{.Server.Version}}"' };
    case 'docker/login-action':
      return { kind: 'skip', note: 'registry login — local runs never push; skipped by design' };
    case 'docker/metadata-action': {
      const image = (withArgs.images || 'local/image').split('\n')[0].trim();
      return {
        kind: 'outputs',
        note: `metadata — synthesized local tags for ${image}`,
        outputs: { tags: `${image}:local-${gitSha.slice(0, 12)}`, labels: `org.opencontainers.image.revision=${gitSha}` },
      };
    }
    case 'docker/build-push-action': {
      const file = withArgs.file || 'Dockerfile';
      const context = withArgs.context || '.';
      const tag = (withArgs.tags || `gha-local:${gitSha.slice(0, 12)}`).split('\n')[0].trim();
      const wantedPush = withArgs.push === 'true';
      return {
        kind: 'shell',
        note: `docker build${wantedPush ? ' (workflow wanted PUSH — local build only, never pushed)' : ''}`,
        cmd: `docker build -f "${file}" -t "${tag}" "${context}"`,
      };
    }
    case 'aquasecurity/trivy-action': {
      const ref = withArgs['image-ref'] || withArgs['scan-ref'] || '.';
      const isImage = Boolean(withArgs['image-ref']);
      const severity = withArgs.severity || 'CRITICAL,HIGH';
      const exitCode = withArgs['exit-code'] || '0';
      return {
        kind: 'shell',
        note: 'trivy — dockerized scan (no host install needed)',
        cmd: isImage
          ? `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --severity ${severity} --exit-code ${exitCode} "${ref}"`
          : `docker run --rm -v "$PWD:/scan:ro" aquasec/trivy:latest fs --severity ${severity} --exit-code ${exitCode} /scan`,
      };
    }
    default:
      return { kind: 'unknown', note: `unmapped action "${uses}" — no local equivalent registered` };
  }
}
