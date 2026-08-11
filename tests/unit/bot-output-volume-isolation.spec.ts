/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the 2026-08-12 swarm-seeding repair. bot-entrypoint.sh writes every bot's persona to the SAME fixed path (/app/output/bot-persona.json) and reads it back to become itself — so two bot services sharing one /app/output volume is a last-writer-wins identity race, live-measured putting 7 of 14 concierge bots under ANOTHER bot's persona (finance answered as general-bot, trading as travel-concierge, identity as oshal-assistant). Pins: (1) every bot-common service's /app/output named volume is UNIQUE fleet-wide (including vs the api's), (2) each is declared in the top-level volumes block, (3) the x-bot-common command never force-copies the config seed (`cp -f` re-imposed the seed on EVERY start, silently resetting runtime provider config and dead-coding the entrypoint's copy-if-missing guard). Mutation checks: re-pointing any bot service at api-output, or reintroducing cp -f, goes red.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const composePath = path.resolve(process.cwd(), 'docker-compose.oshal-local.yml');
const compose = fs.readFileSync(composePath, 'utf8');
const lines = compose.split(/\r?\n/);

/** Light service-aware scan: top-level compose service keys sit at 2-space indent. */
interface ServiceFacts {
  name: string;
  usesBotCommon: boolean;
  outputVolumes: string[];
}

function scanServices(): ServiceFacts[] {
  const services: ServiceFacts[] = [];
  let current: ServiceFacts | null = null;
  let inServicesBlock = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServicesBlock = true; continue; }
    if (/^[a-zA-Z]/.test(line) && !/^services:/.test(line)) inServicesBlock = false;
    if (!inServicesBlock) continue;
    const svc = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (svc) {
      current = { name: svc[1], usesBotCommon: false, outputVolumes: [] };
      services.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s+<<:\s*\*bot-common\s*$/.test(line)) current.usesBotCommon = true;
    const vol = line.match(/^\s+-\s+([A-Za-z0-9_-]+):\/app\/output(?::|$|\s)/);
    if (vol) current.outputVolumes.push(vol[1]);
  }
  return services;
}

describe('bot /app/output isolation — the persona file must have ONE writer per volume', () => {
  const services = scanServices();
  const withOutput = services.filter((s) => s.outputVolumes.length > 0);

  it('the parser actually sees the fleet (a broken scan must not pass vacuously)', () => {
    expect(services.length).toBeGreaterThan(30);
    expect(withOutput.length).toBeGreaterThan(15);
    expect(services.filter((s) => s.usesBotCommon).length).toBeGreaterThan(20);
  });

  it('no two services share an /app/output named volume — a shared volume is an identity race', () => {
    const byVolume = new Map<string, string[]>();
    for (const s of withOutput) {
      for (const v of s.outputVolumes) {
        byVolume.set(v, [...(byVolume.get(v) ?? []), s.name]);
      }
    }
    const shared = [...byVolume.entries()].filter(([, owners]) => owners.length > 1);
    expect(
      shared.map(([vol, owners]) => `${vol} shared by: ${owners.join(', ')}`),
    ).toEqual([]);
  });

  it('every mounted /app/output volume is declared in the top-level volumes block', () => {
    const volumesBlock = compose.slice(compose.lastIndexOf('\nvolumes:'));
    const missing = withOutput
      .flatMap((s) => s.outputVolumes)
      .filter((v) => !new RegExp(`^  ${v}:\\s*$`, 'm').test(volumesBlock));
    expect(missing).toEqual([]);
  });

  it('the shared bot command never force-copies the config seed over runtime config', () => {
    // cp -f here re-imposed config-seed onto /app/output on EVERY container start —
    // discarding runtime provider config and dead-coding bot-entrypoint.sh Step 1b's
    // copy-if-missing. Seeding belongs to the entrypoint; compose must not preempt it.
    const botCommon = compose.slice(compose.indexOf('x-bot-common:'), compose.indexOf('x-bot-env'));
    expect(botCommon).not.toContain('cp -f /app/config-seed');
  });
});
