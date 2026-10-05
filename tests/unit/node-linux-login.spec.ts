/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the OSHAL Node's first real Linux desktop install (DGX Spark, 2026-10-05). Each defect blocked the operator: Google refused the node's sign-in window because the npm app name `@oshal/chat/…` survived in the user agent; Antigravity kept its login in the keyring so "Log in + push" never saw it; `codex login` could not take 127.0.0.1:1455 from the swarm on the same box; the launcher inherited VS Code's ELECTRON_RUN_AS_NODE; the swarm wrote the adopted token root-owned into the user's ~/.gemini; and the installer never explained npm's Node-version warnings.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { presentableUserAgent } from '../../packages/oshal-chat/src/main/user-agent';
import { linuxLoginCommand, portListening } from '../../packages/oshal-chat/src/main/linux-login';
import { keepDirectoryOwner } from '@/features/llm-provider/services/antigravity-auth-adoption-service';
import { renderPosixNodeInstaller } from '@/app/routes/node-installer-routes';

const CHROME = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko)';
const TAIL = 'Chrome/150.0.7871.212 Safari/537.36';
const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

afterEach(() => { vi.restoreAllMocks(); });

describe('the user agent Google sees', () => {
  it('removes the npm app name token that made Google refuse the sign-in window', () => {
    const raw = `${CHROME} @oshal/chat/0.5.2 ${TAIL.replace('Safari', 'Electron/43.3.0 Safari')}`;
    expect(presentableUserAgent(raw, '@oshal/chat')).toBe(`${CHROME} ${TAIL}`);
  });

  it('removes a packaged product name and the legacy oshal-chat token too', () => {
    expect(presentableUserAgent(`${CHROME} OSHALNode/1.0.0 ${TAIL}`, 'OSHALNode')).toBe(`${CHROME} ${TAIL}`);
    expect(presentableUserAgent(`${CHROME} oshal-chat/0.4.0 Electron/41.0.0 ${TAIL}`, '@oshal/chat')).toBe(`${CHROME} ${TAIL}`);
  });
});

describe('Linux login commands', () => {
  const listening = [`${TCP_HEADER}\n   0: 0100007F:05AF 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1`];
  const established = [`${TCP_HEADER}\n   0: 0100007F:05AF 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 1 1`];

  it('reads a LISTEN socket on the Codex callback port from /proc/net/tcp, and ignores other states', () => {
    expect(portListening(1455, listening)).toBe(true);
    expect(portListening(1455, established)).toBe(false);
    expect(portListening(1455, ['', ''])).toBe(false);
  });

  it('runs Antigravity without a session bus so agy writes the file the node pushes', () => {
    expect(linuxLoginCommand('antigravity', [])).toBe('env DBUS_SESSION_BUS_ADDRESS=disabled: agy');
  });

  it('uses the Codex device-code login only when a local swarm already holds port 1455', () => {
    expect(linuxLoginCommand('codex', listening)).toBe('codex login --device-auth');
    expect(linuxLoginCommand('codex', established)).toBeNull();
    expect(linuxLoginCommand('claude', listening)).toBeNull();
  });
});

describe('the npm launcher', () => {
  it('drops the Electron-as-Node variables a VS Code terminal exports before starting Electron', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'packages/oshal-chat/bin/oshal-chat.js'), 'utf8');
    expect(source).toMatch(/delete env\.ELECTRON_RUN_AS_NODE;/);
    expect(source).toMatch(/spawn\(electron, \[appRoot, \.\.\.process\.argv\.slice\(2\)\], \{\s*env,/);
  });
});

describe('an adopted login keeps its folder owner', () => {
  it('hands the file to the directory owner when the api runs as root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-adopt-owner-'));
    const file = path.join(dir, 'antigravity-oauth-token');
    fs.writeFileSync(file, '{}');
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'chownSync').mockImplementation(() => undefined);
    const owner = fs.statSync(dir);
    keepDirectoryOwner(file, dir);
    if (owner.uid === 0) expect(chown).not.toHaveBeenCalled();
    else expect(chown).toHaveBeenCalledWith(file, owner.uid, owner.gid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves ownership alone when the api does not run as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const chown = vi.spyOn(fs, 'chownSync').mockImplementation(() => undefined);
    keepDirectoryOwner('/nonexistent/file', '/nonexistent');
    expect(chown).not.toHaveBeenCalled();
  });
});

describe('the Linux one-click installer', () => {
  it('keeps Node 20 as the floor and explains the 22.12 expectation instead of leaving bare npm warnings', () => {
    const script = renderPosixNodeInstaller({
      controlPlaneUrl: 'https://swarm.example.test', token: 'oshal_pat_fixture', clientId: 'node-fixture',
      nodeName: 'fixture', nodePackage: '@oshal/chat', platform: 'linux',
    });
    expect(script).toContain('[ "$NODE_MAJOR" -lt 20 ]');
    expect(script).toContain('[ "$NODE_MAJOR" -lt 22 ]');
    expect(script).toMatch(/expects 22\.12 or newer/);
  });
});
