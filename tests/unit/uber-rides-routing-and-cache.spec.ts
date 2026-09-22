/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the three things scripts/oshal-uber-rides.js used to hardcode. (1) THE GEOCODER WAS A LITERAL — an operator running their own Nominatim, or an air-gapped box where the public one is unreachable and every address silently fails to resolve, had no way to point this at anything else; OSHAL_GEOCODER_URL now does. (2) THE CACHE DIED WITH THE PROCESS — geoCache was a bare Map, so every api restart re-asked the public endpoint for addresses this box had already resolved, which is exactly the pattern its usage policy asks callers not to produce and the reason the file carries a rate limiter at all. (3) THE ROAD DISTANCE WAS ALWAYS A MODEL — straight line times 1.3 is the ACCEPTED keyless default, but an operator with an OSRM/Valhalla endpoint can now set OSHAL_ROUTING_URL and get a measured one with no code change, and a routed answer must not be described with a road factor that was never applied to it.
 *
 *   These cross the boundaries they claim to guard rather than mocking them. The geocoder and the
 *   routing engine are a REAL http server this file starts, reached over a REAL socket by the REAL
 *   CLI. The restart proof is two REAL child processes sharing one REAL cache file on disk — a
 *   second call inside one process proves only that a Map works, which was never in doubt. The
 *   assertion that matters is the request COUNT the stand-in endpoint observed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'oshal-uber-rides.js');

/**
 * Two pins a degree of longitude apart at 30 degrees north — about 96 km, nowhere near the 20 km
 * the stand-in routing engine reports, so a routed answer can never be mistaken for the modelled
 * one.
 */
const PIN_ALPHA = { lat: 30, lon: -86 };
const PIN_BRAVO = { lat: 30, lon: -85 };
const ADDRESS_ALPHA = '1 Alpha Street, Testville';
const ADDRESS_BRAVO = '2 Bravo Avenue, Testville';
const ROUTED_METRES = 20000;

interface Observed { path: string; query: URLSearchParams }

let server: http.Server;
let origin = '';
let observed: Observed[] = [];
let resolvable = true;
let routingStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    observed.push({ path: url.pathname, query: url.searchParams });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/search') {
      const q = String(url.searchParams.get('q') || '');
      const pin = /alpha/i.test(q) ? PIN_ALPHA : PIN_BRAVO;
      res.end(JSON.stringify(resolvable
        ? [{ lat: String(pin.lat), lon: String(pin.lon), display_name: q }]
        : []));
      return;
    }
    if (url.pathname.startsWith('/osrm/route/v1/driving/')) {
      if (routingStatus !== 200) { res.statusCode = routingStatus; res.end('{}'); return; }
      res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: ROUTED_METRES }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the stand-in endpoint did not bind');
  origin = 'http://127.0.0.1:' + address.port;
});

afterAll(async () => {
  await new Promise<void>((done) => { server.close(() => done()); });
});

beforeEach(() => { observed = []; resolvable = true; routingStatus = 200; });

/**
 * A cache file path nothing else in this run shares.
 *
 * @description Each case gets its own directory so one test's durable cache can never satisfy
 *   another's lookup — which would turn the restart proof into a coincidence.
 * @returns {string} an absolute path in a fresh temp directory
 */
function freshCachePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-rides-cache-')),
    'uber-rides-geocode-cache.json',
  );
}

/**
 * Run the real CLI in a real child process and parse the JSON it contracts to print.
 *
 * @description DATABASE_URL/PGHOST and OSHAL_WORKSPACE_ROOT are stripped so the run cannot reach
 *   this box's database or its workspace volume; everything the test wants to control it passes in.
 * @param {string[]} args - CLI arguments
 * @param {Record<string,string>} env - the operator env under test
 * @returns {Promise<any>} the parsed result object the CLI printed
 */
async function runCli(args: string[], env: Record<string, string>): Promise<any> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.DATABASE_URL;
  delete childEnv.PGHOST;
  delete childEnv.OSHAL_WORKSPACE_ROOT;
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT, env: childEnv, timeout: 30000,
  });
  return JSON.parse(stdout);
}

const searches = () => observed.filter((entry) => entry.path === '/search');
const routes = () => observed.filter((entry) => entry.path.startsWith('/osrm/route/'));

describe('the geocoder endpoint is the operator, not a literal in the source', () => {
  it('asks the configured service and answers from it', async () => {
    const result = await runCli(['geocode', ADDRESS_ALPHA], {
      OSHAL_GEOCODER_URL: origin,
      OSHAL_GEOCODE_CACHE_PATH: freshCachePath(),
    });
    // If the URL were still hardcoded this endpoint would never be called and the address would
    // resolve (or fail) against the public one — either way, not here.
    expect(searches()).toHaveLength(1);
    expect(searches()[0].query.get('q')).toBe(ADDRESS_ALPHA);
    expect(result.lat).toBe(PIN_ALPHA.lat);
    expect(result.lon).toBe(PIN_ALPHA.lon);
  }, 20000);
});

describe('a restart does not re-ask for an address this box already resolved', () => {
  it('serves the second process from the cache file the first one wrote', async () => {
    const cachePath = freshCachePath();
    const env = { OSHAL_GEOCODER_URL: origin, OSHAL_GEOCODE_CACHE_PATH: cachePath };

    const first = await runCli(['geocode', ADDRESS_ALPHA], env);
    expect(searches()).toHaveLength(1);
    expect(fs.existsSync(cachePath)).toBe(true);

    // A SECOND PROCESS. Nothing is shared with the first but the file on disk — which is what a
    // restart leaves behind, and the only thing that can make this assertion true.
    const second = await runCli(['geocode', ADDRESS_ALPHA], env);
    expect(searches()).toHaveLength(1);
    expect(second.lat).toBe(first.lat);
    expect(second.lon).toBe(first.lon);
    expect(second.label).toBe(first.label);

    const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(stored.version).toBe(1);
    expect(stored.entries['f:' + ADDRESS_ALPHA.toLowerCase()].hit.lat).toBe(PIN_ALPHA.lat);
  }, 30000);

  it('never persists a miss, so a transient outage cannot make an address permanently unresolvable', async () => {
    const cachePath = freshCachePath();
    resolvable = false;
    const result = await runCli(['geocode', ADDRESS_ALPHA], {
      OSHAL_GEOCODER_URL: origin,
      OSHAL_GEOCODE_CACHE_PATH: cachePath,
    });
    expect(result.error).toBe('address did not resolve');
    const entries = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries
      : {};
    expect(Object.keys(entries)).toHaveLength(0);
  }, 30000);
});

describe('OSHAL_ROUTING_URL is the optional override, and the keyless default stays an estimate', () => {
  it('measures the road when an engine is configured, and quotes no factor it never applied', async () => {
    const result = await runCli(['estimate', ADDRESS_ALPHA, ADDRESS_BRAVO], {
      OSHAL_GEOCODER_URL: origin,
      OSHAL_ROUTING_URL: origin + '/osrm',
      OSHAL_GEOCODE_CACHE_PATH: freshCachePath(),
    });
    expect(routes()).toHaveLength(1);
    expect(routes()[0].path).toContain(
      PIN_ALPHA.lon + ',' + PIN_ALPHA.lat + ';' + PIN_BRAVO.lon + ',' + PIN_BRAVO.lat,
    );
    expect(result.basis).toBe('routed');
    expect(result.distanceKm).toBe(ROUTED_METRES / 1000);
    expect(result.roadFactor).toBeNull();
    expect(result.note).toMatch(/routing engine/);
    expect(result.note).not.toMatch(/road factor/);
    // The modelled answer for these pins is about 125 km. A routed answer that happened to equal
    // it would mean the engine was never consulted.
    expect(result.distanceKm).not.toBeCloseTo(result.straightLineKm * 1.3, 0);
  }, 30000);

  it('falls back to the accepted straight-line estimate when the engine does not answer', async () => {
    routingStatus = 503;
    const result = await runCli(['estimate', ADDRESS_ALPHA, ADDRESS_BRAVO], {
      OSHAL_GEOCODER_URL: origin,
      OSHAL_ROUTING_URL: origin + '/osrm',
      OSHAL_GEOCODE_CACHE_PATH: freshCachePath(),
    });
    expect(routes()).toHaveLength(1);
    expect(result.basis).toBe('geocoded');
    expect(result.roadFactor).toBe(1.3);
    expect(result.distanceKm).toBeCloseTo(result.straightLineKm * 1.3, 0);
    expect(result.distanceKm).not.toBe(ROUTED_METRES / 1000);
    expect(result.note).toMatch(/straight line/);
    expect(result.note).toMatch(/not a driven route/);
  }, 30000);

  it('prices the keyless default as an estimate when no engine is configured at all', async () => {
    const result = await runCli(['estimate', ADDRESS_ALPHA, ADDRESS_BRAVO], {
      OSHAL_GEOCODER_URL: origin,
      OSHAL_GEOCODE_CACHE_PATH: freshCachePath(),
    });
    expect(routes()).toHaveLength(0);
    expect(result.basis).toBe('geocoded');
    expect(result.roadFactor).toBe(1.3);
    expect(result.options.every((option: { estimate: boolean }) => option.estimate === true)).toBe(true);
  }, 30000);

  it('reports which distance path the box is on, without printing the endpoint', async () => {
    const off = await runCli(['status'], { OSHAL_GEOCODE_CACHE_PATH: freshCachePath() });
    expect(off.routing).toBe('straight-line-x-road-factor');
    expect(off.geocoder).toBe('public-nominatim');

    const on = await runCli(['status'], {
      OSHAL_ROUTING_URL: origin + '/osrm',
      OSHAL_GEOCODER_URL: origin,
      OSHAL_GEOCODE_CACHE_PATH: freshCachePath(),
    });
    expect(on.routing).toBe('routing-engine');
    expect(on.geocoder).toBe('operator-configured');
    expect(JSON.stringify(on)).not.toContain(origin);
  }, 30000);
});

describe('an operator value that is not a usable service URL is refused, not obeyed', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cli = require(CLI_PATH) as {
    geocoderBaseUrl: () => string;
    routingBaseUrl: () => string;
    DEFAULT_GEOCODER_URL: string;
  };

  it.each([
    ['file:///etc/passwd', 'a non-http scheme'],
    ['http://user:secret@example.test', 'embedded credentials'],
    ['https://example.test/route?key=abc', 'a query string'],
    ['not a url at all', 'unparseable'],
  ])('ignores %s (%s)', (value) => {
    const previousGeocoder = process.env.OSHAL_GEOCODER_URL;
    const previousRouting = process.env.OSHAL_ROUTING_URL;
    try {
      process.env.OSHAL_GEOCODER_URL = value;
      process.env.OSHAL_ROUTING_URL = value;
      expect(cli.geocoderBaseUrl()).toBe(cli.DEFAULT_GEOCODER_URL);
      expect(cli.routingBaseUrl()).toBe('');
    } finally {
      if (previousGeocoder === undefined) delete process.env.OSHAL_GEOCODER_URL;
      else process.env.OSHAL_GEOCODER_URL = previousGeocoder;
      if (previousRouting === undefined) delete process.env.OSHAL_ROUTING_URL;
      else process.env.OSHAL_ROUTING_URL = previousRouting;
    }
  });
});
