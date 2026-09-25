/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run the real CLI against private archive files and a connection trap; prove dry reads and fail-closed mock or unconfirmed writes.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'futures-cli-'));
let server: Server, url: string, connections = 0;
beforeAll(async () => {
  mkdirSync(join(directory, 'minute'));
  writeFileSync(join(directory, 'minute', 'ESZ25.txt'), '10/01/2025,10:00,100,101,99,100,50\n10/01/2025,10:59,100,103,99,102,50\n');
  server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  url = `postgres://fixture:fixture@127.0.0.1:${(server.address() as { port: number }).port}/unused`;
});
afterAll(async () => { await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); });
function cli(flags: string[]) {
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, ['-r','ts-node/register/transpile-only','-r','tsconfig-paths/register', 'scripts/oshal-futures-ingest.ts', ...flags], {
      cwd: resolve(__dirname, '../..'), env: { ...process.env, DATABASE_URL: url, PGHOST: '127.0.0.1', POSTGRES_HOST: '127.0.0.1',
        DOTENV_CONFIG_PATH: join(directory, 'absent.env'), LOG_LEVEL: 'silent' }, windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timed out')); }, 30_000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
const real = () => ['--source','kibot-file','--root','ES','--tf','1Hour','--data-dir',directory,
  '--source-time-zone','America/New_York','--start','2025-10-01','--end','2025-10-01'];
describe('Futures archive CLI boundary', () => {
  it('runs actual file preview without connecting to PostgreSQL or running a paper demo', async () => {
    const result = await cli(real()); expect(result.code, result.output).toBe(0);
    const plan = JSON.parse(result.output.split('RESULT ')[1].trim());
    expect(plan.totalBars).toBe(1); expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.manifest[0].first).toBe('2025-10-01T14:00:00.000Z');
    expect(result.output).not.toContain('BUY'); expect(result.output).not.toContain('account:'); expect(connections).toBe(0);
  }, 45_000);
  it.each([['--store'], ['--source','unknown'], ['--unexpected']])('refuses unsafe mock or unknown flags before database work: %j', async (...flags) => {
    const result = await cli(flags); expect(result.code).toBe(2); expect(connections).toBe(0);
  }, 45_000);
  it('refuses real --store without the prior fingerprint and typed confirmation before connecting', async () => {
    const result = await cli([...real(), '--store','--owner','fixture-owner']);
    expect(result.code).toBe(2); expect(result.output).toContain('no fallback'); expect(connections).toBe(0);
  }, 45_000);
});
