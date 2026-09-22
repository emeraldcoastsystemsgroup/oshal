/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the api's Postgres wait probe cannot hang. On the first live 0.5.0 upgrade the probe connected seconds before oshal-db-0 was replaced and sat on the dead socket for about four minutes; the retry loop never ran. This spec takes the probe EXACTLY as the chart renders it and runs it with real node + pg against a TCP listener that accepts and never answers — the same half-open condition — and requires a non-zero exit well inside the loop's own cadence. It also holds the outer timeout(1) bound in the rendered loop.
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmTemplate } from '../helpers/helm-template';

/** The wait-loop line: the only `node -e` in the api start script that reads PROBE_URL. */
function renderedProbeLine(): string {
  const api = containerOf(helmTemplate({}), 'Deployment', 'oshal-api', 'api');
  const script = String((api.args || []).join('\n'));
  const line = script.split('\n').find(l => l.includes('node -e') && l.includes('PROBE_URL'));
  expect(line, 'the api start script carries a PROBE_URL wait probe').toBeTruthy();
  return line!.trim();
}

/** The JavaScript between node -e "…" on that line. */
function probeScript(line: string): string {
  const m = line.match(/node -e "([^"]+)"/);
  expect(m, 'the probe is a double-quoted node -e script').toBeTruthy();
  return m![1];
}

let blackhole: net.Server;
let port = 0;
const sockets: net.Socket[] = [];

beforeAll(async () => {
  // Accept every connection and never write a byte: a Postgres whose pod went away under a
  // live socket looks exactly like this to the client.
  blackhole = net.createServer(sock => { sockets.push(sock); });
  await new Promise<void>(resolve => blackhole.listen(0, '127.0.0.1', () => resolve()));
  port = (blackhole.address() as net.AddressInfo).port;
});

afterAll(async () => {
  sockets.forEach(s => s.destroy());
  await new Promise<void>(resolve => blackhole.close(() => resolve()));
});

describe('the api Postgres wait probe is bounded', () => {
  it('each attempt runs under an outer timeout(1)', () => {
    const line = renderedProbeLine();
    const m = line.match(/timeout\s+(\d+)\s+node -e/);
    expect(m, 'the node probe is wrapped in timeout <seconds>').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(30);
  }, RENDER_TIMEOUT_MS);

  it('against a server that accepts and never answers, the rendered probe exits non-zero quickly', async () => {
    const js = probeScript(renderedProbeLine());
    const started = Date.now();
    const result = await new Promise<{ code: number | null; ms: number }>((resolve) => {
      const child = spawn(process.execPath, ['-e', js], {
        cwd: REPO_ROOT,
        env: { ...process.env, PROBE_URL: `postgresql://probe:probe@127.0.0.1:${port}/probe` },
        stdio: 'ignore',
      });
      // Far longer than any bounded attempt; an unbounded probe is still waiting here.
      const guard = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
      child.on('exit', code => { clearTimeout(guard); resolve({ code, ms: Date.now() - started }); });
    });
    expect(result.code, `probe exited ${result.code} after ${result.ms}ms (null = killed by the 20s guard: it hung)`).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.ms).toBeLessThan(15_000);
  }, 30_000);
});
