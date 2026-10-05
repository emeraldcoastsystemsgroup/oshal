/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the clean-install fixes found on a real arm64 Linux run, plus env insertion. Each scripts/lib/installer-env.sh function runs in REAL bash against a real temp filesystem (the boundary the defects lived in): a Windows .env (BOM + CRLF) inserts cleanly and never overwrites a different one; missing install secrets are filled but an existing ENCRYPTION_KEY is never rotated; placeholders count as missing; the docker project root is the real path on Linux, replacing a Docker Desktop path; an explicit auth mode wins without duplicate keys; bind-mount sources are created as the user (~/.claude.json a FILE, never a root-owned directory); the unattended sign-in link lands in an owner-only file; a foreign-CPU image stops with the --mode 2 fix. Plus the installer wiring that makes these run.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The CPU check is hermetic (fake uname, daemon OS and binfmt dir) and proves backward compatibility: an Apple-silicon Mac, Docker Desktop on Linux/WSL, Windows Git Bash, a Linux host with a binfmt handler and OSHAL_ALLOW_FOREIGN_ARCH=1 all keep running a foreign-CPU image with a warning; only a host that cannot emulate stops.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const LIB = join(process.cwd(), 'scripts/lib/installer-env.sh');
const SH = join(process.cwd(), 'scripts/oshal-install.sh');

/** Git Bash by path on Windows; this guard must fail loudly, not skip, when no bash exists. */
function bashPath(): string {
  for (const candidate of ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash']) {
    try { execSync(`"${candidate}" -c "exit 0"`, { stdio: 'ignore' }); return candidate; } catch { /* next */ }
  }
  throw new Error('no usable bash found');
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oshal-envins-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Source the real lib (with the installer's note/local_sub stand-ins) and run a snippet. */
function run(snippet: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const script = [
    'set -u',
    "note() { printf 'NOTE %s\\n' \"$*\"; }",
    "local_sub() { printf 'local-%s' \"$(printf '%s' \"$1\" | tr 'A-Z' 'a-z' | cut -c1-8)\"; }",
    `. "${LIB.replace(/\\/g, '/')}"`,
    snippet,
  ].join('\n');
  const r = spawnSync(bashPath(), ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, ...env } });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const mode = (p: string): number => statSync(p).mode & 0o777;
const read = (p: string): string => readFileSync(p, 'utf8');

describe('env insertion (--env-file)', () => {
  it('inserts a Windows .env: BOM and CRLF stripped, owner-only', () => {
    writeFileSync(join(dir, 'src.env'), '\uFEFFCOMPOSE_PROFILES=build\r\nAPP_URL=https://box.example.com\r\n');
    const r = run('insert_env_file src.env dest.env');
    expect(r.code).toBe(0);
    expect(read(join(dir, 'dest.env'))).toBe('COMPOSE_PROFILES=build\nAPP_URL=https://box.example.com\n');
    expect(mode(join(dir, 'dest.env'))).toBe(0o600);
  });

  it('never overwrites a different existing .env, but accepts an identical one', () => {
    writeFileSync(join(dir, 'src.env'), 'A=1\n');
    writeFileSync(join(dir, 'dest.env'), 'A=2\n');
    const refused = run('insert_env_file src.env dest.env');
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/never overwritten/);
    expect(read(join(dir, 'dest.env'))).toBe('A=2\n');
    writeFileSync(join(dir, 'dest.env'), 'A=1\n');
    expect(run('insert_env_file src.env dest.env').code).toBe(0);
  });

  it('refuses a missing source', () => {
    expect(run('insert_env_file nope.env dest.env').code).not.toBe(0);
    expect(existsSync(join(dir, 'dest.env'))).toBe(false);
  });

  it('keeps a migrated IdP posture unless an explicit auth mode is given', () => {
    const prod = 'MOCK_OIDC=false\nOIDC_ISSUER_URL=https://accounts.google.com\nOSHAL_OPERATOR_EMAILS=owner@example.com,other@example.com\n';
    writeFileSync(join(dir, 'src.env'), prod);
    const idp = run('IMAGE=oshal-bot:latest ADMIN_EMAIL=owner@example.com AUTH_MODE=basic AUTH_MODE_EXPLICIT=0\n'
      + 'install_inserted_env src.env dest.env && echo "MODE=$AUTH_MODE"');
    expect(idp.out).toContain('MODE=idp');
    expect(read(join(dir, 'dest.env'))).not.toMatch(/OSHAL_INSTALL_OWNER_SUB=/);
    expect(read(join(dir, 'dest.env'))).toMatch(/^OSHAL_BOT_IMAGE=oshal-bot:latest$/m);

    rmSync(join(dir, 'dest.env'));
    const basic = run('IMAGE=oshal-bot:latest ADMIN_EMAIL=owner@example.com AUTH_MODE=basic AUTH_MODE_EXPLICIT=1\n'
      + 'install_inserted_env src.env dest.env && echo "MODE=$AUTH_MODE"');
    const out = read(join(dir, 'dest.env'));
    expect(basic.out).toContain('MODE=basic');
    expect(out.match(/^LOCAL_AUTH=/gm)).toHaveLength(1);
    expect(out.match(/^MOCK_OIDC=/gm)).toHaveLength(1);
    expect(out).toMatch(/^LOCAL_AUTH=true$/m);
    expect(out).toMatch(/^MOCK_OIDC=false$/m);
    expect(out).toMatch(/^OSHAL_OPERATOR_EMAILS=owner@example.com,other@example.com$/m);
    expect(out).toMatch(/^OSHAL_INSTALL_OWNER_SUB=local-/m);
    expect(out).toMatch(/^OSHAL_INSTALL_OWNER_ISSUER=urn:oshal:local-auth$/m);
  });

  it('reads the posture a file declares', () => {
    for (const [body, want] of [['LOCAL_AUTH=true\n', 'basic'], ['MOCK_OIDC=TRUE\n', 'mock'], ['OIDC_ISSUER_URL=x\n', 'idp']]) {
      writeFileSync(join(dir, 'e.env'), body);
      expect(run('env_auth_mode e.env').out.trim()).toBe(want);
    }
  });
});

describe('install secrets and project root (every .env path)', () => {
  it('fills missing secrets, never rotates an existing ENCRYPTION_KEY, and replaces placeholders', () => {
    writeFileSync(join(dir, 'e.env'), 'ENCRYPTION_KEY=keep-this-existing-key\nJWT_SECRET=replace-with-a-long-random-string\n');
    writeFileSync(join(dir, 'docker-compose.oshal-local.yml'), 'services: {}\n');
    expect(run('finalize_install_env e.env docker-compose.oshal-local.yml').code).toBe(0);
    const out = read(join(dir, 'e.env'));
    expect(out).toMatch(/^ENCRYPTION_KEY=keep-this-existing-key$/m);
    for (const k of ['SWARM_SERVICE_SECRET', 'SESSION_SECRET', 'REMOTE_CLIENT_SHARED_SECRET', 'JWT_SECRET']) {
      expect(out).toMatch(new RegExp(`^${k}=[0-9a-f]{64}$`, 'm'));
    }
    expect(mode(join(dir, 'e.env'))).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('writes the real project root on Linux/macOS, replacing a Docker Desktop path', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/docker-compose.oshal-local.yml'), 'services: {}\n');
    writeFileSync(join(dir, 'e.env'), 'OSHAL_DOCKER_PROJECT_ROOT=/run/desktop/mnt/host/c/Projects/oshal\n');
    run('finalize_install_env e.env src/docker-compose.oshal-local.yml');
    const want = realpathSync(join(dir, 'src'));
    expect(read(join(dir, 'e.env'))).toMatch(new RegExp(`^OSHAL_DOCKER_PROJECT_ROOT=${want}$`, 'm'));
    writeFileSync(join(dir, 'e.env'), 'OSHAL_DOCKER_PROJECT_ROOT=/srv/custom\n');
    run('finalize_install_env e.env src/docker-compose.oshal-local.yml');
    expect(read(join(dir, 'e.env'))).toMatch(/^OSHAL_DOCKER_PROJECT_ROOT=\/srv\/custom$/m);
  });
});

describe('bind-mount sources are created as the user, never by docker as root', () => {
  it('creates ~/.claude.json as a FILE and the credential folders as directories', () => {
    writeFileSync(join(dir, 'e.env'), '');
    expect(run('prepare_bind_sources "$HOME/src" e.env').code).toBe(0);
    for (const d of ['.codex', '.claude', '.gemini', 'src/output/connectors/imported-openapi']) {
      expect(statSync(join(dir, d)).isDirectory()).toBe(true);
    }
    expect(mode(join(dir, '.oshal-google-workspace'))).toBe(0o700);
    expect(statSync(join(dir, '.claude.json')).isFile()).toBe(true);
    expect(read(join(dir, '.claude.json'))).toBe('{}\n');
  });

  it('never clobbers an existing ~/.claude.json and honors an .env override', () => {
    writeFileSync(join(dir, '.claude.json'), '{"keep":true}\n');
    writeFileSync(join(dir, 'e.env'), `CLAUDE_CONFIG_HOST_JSON=${dir}/alt.json\n`);
    run('prepare_bind_sources "$HOME/src" e.env');
    expect(read(join(dir, '.claude.json'))).toBe('{"keep":true}\n');
    expect(statSync(join(dir, 'alt.json')).isFile()).toBe(true);
  });
});

describe('first sign-in and image CPU', () => {
  it('saves the unattended set-password link to an owner-only file', () => {
    const r = run('save_first_signin_link "$HOME/FIRST-SIGN-IN.txt" "http://localhost:35457/invite?token=t" "in 1 hour"');
    expect(r.code).toBe(0);
    expect(read(join(dir, 'FIRST-SIGN-IN.txt'))).toContain('http://localhost:35457/invite?token=t');
    expect(mode(join(dir, 'FIRST-SIGN-IN.txt'))).toBe(0o600);
    expect(r.out).not.toContain('token=t'); // the link itself is never printed
  });

  // Hermetic host: a fake docker (server/image CPU and daemon OS) and a fake uname, plus an empty
  // binfmt dir unless a test registers a handler, so the host running the suite never decides it.
  const host = (server: string, image: string, opts: { os?: string; uname?: string } = {}) =>
    `docker() { case "$*" in *Server.Arch*) echo ${server};; *Architecture*) echo ${image};;`
    + ` *OperatingSystem*) echo '${opts.os ?? 'Ubuntu 24.04 LTS'}';; esac; }\n`
    + `uname() { echo ${opts.uname ?? 'Linux'}; }\n`;
  const noBinfmt = (): Record<string, string> => { mkdirSync(join(dir, 'binfmt'), { recursive: true }); return { BINFMT_DIR: join(dir, 'binfmt') }; };

  it('stops with the --mode 2 fix when the image is built for another CPU and nothing can emulate it', () => {
    const bad = run(`${host('arm64', 'amd64')}check_image_arch ghcr.io/x/oshal-bot:latest; echo REACHED`, noBinfmt());
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/built for amd64, but this machine is arm64.*--mode 2/);
    expect(bad.out).not.toContain('REACHED');
    expect(run(`${host('arm64', 'arm64')}check_image_arch img; echo REACHED`, noBinfmt()).out).toContain('REACHED');
  });

  it('stays backward compatible wherever the foreign image ran before: emulation warns, never stops', () => {
    const env = noBinfmt();
    const passes = (snippet: string, extra: Record<string, string> = {}) => {
      const r = run(`${snippet}check_image_arch img; echo REACHED`, { ...env, ...extra });
      expect(r.code).toBe(0);
      expect(r.out).toContain('REACHED');
      expect(r.err).toMatch(/runs under emulation \(slower\)/);
    };
    passes(host('arm64', 'amd64', { uname: 'Darwin' }));                       // Apple-silicon Mac, Docker Desktop
    passes(host('arm64', 'amd64', { os: 'Docker Desktop' }));                  // Docker Desktop on Linux / WSL
    passes(host('amd64', 'arm64', { uname: 'MINGW64_NT-10.0' }));             // Windows Git Bash
    writeFileSync(join(dir, 'binfmt', 'qemu-x86_64'), 'enabled\ninterpreter /usr/bin/qemu-x86_64\n');
    passes(host('arm64', 'amd64'));                                            // Linux with a binfmt handler
    rmSync(join(dir, 'binfmt', 'qemu-x86_64'));
    passes(host('arm64', 'amd64'), { OSHAL_ALLOW_FOREIGN_ARCH: '1' });         // explicit override
  });
});

describe('installer wiring', () => {
  const sh = readFileSync(SH, 'utf8');
  it('sources the lib and runs the env + host preparation before any compose up', () => {
    expect(sh).toContain('load_installer_env_lib');
    const finalize = sh.indexOf('finalize_install_env "$ENV_FILE" "$COMPOSE_FILE"');
    const prepare = sh.indexOf('prepare_bind_sources "$(dirname "$COMPOSE_FILE")" "$ENV_FILE"');
    const firstUp = sh.indexOf('up -d oshal-db oshal-redis oshal-chromadb');
    expect(finalize).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(finalize);
    expect(firstUp).toBeGreaterThan(prepare);
  });
  it('accepts --env-file and never re-asks an explicit --auth-mode', () => {
    expect(sh).toContain('--env-file) ENV_SOURCE="$2"');
    expect(sh).toContain('--auth-mode) AUTH_MODE="$2"; AUTH_MODE_EXPLICIT=1');
    expect(sh).toMatch(/AUTH_MODE_EXPLICIT" -eq 0 \] && \[ -z "\$ENV_SOURCE" \] && \[ -t 0 \]/);
  });
  it('points the closing re-check at the verify script actually used', () => {
    expect(sh).not.toContain('Re-check the box any time: bash $DIR/oshal-verify.sh   (');
    expect(sh).toContain('bash ${VERIFY:-$DIR/oshal-verify.sh} --env-file $ENV_FILE');
  });
});
