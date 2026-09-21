/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-129 codeless k8s chart (deploy/helm/oshal). Pins: (1) the fleet block in values.yaml matches docker-compose.oshal-local.yml via the real generator (counts are generated, never hand-typed — drift here is how docs went 6.8x off reality); (2) the docker-socket bot stays EXCLUDED with its reason logged (no docker daemon inside a k8s pod); (3) every fleet bot's persona file exists on disk (a persona rename otherwise ships a crash-looping pod); (4) agent IDs are unique per fleet (the a0…030 three-way collision, k8s edition); (5) registry-pull defaults hold — public ghcr.io oshal-bot image, relay + Kyma APIRule OFF (a generic cluster has neither headscale nor the APIRule CRD, and rendering either fails the whole install); (6) the codex fleet floor (chart shared-env follows compose SEQ-13: openai-codex, model >= gpt-5.5); (7) K5 + seeding-repair parity in the bot template source: bots carry the least-privilege oshal_bot DSN (never the superuser interpolation) and NO config-seed cp (bot-entrypoint Step 1b copy-if-missing is the only seeding path).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | K5 check (7) follows the DSN into the chart's oshal-db-credentials Secret (chart 0.5.0): bots.yaml no longer holds the oshal_bot DSN as a literal, so the case renders the chart and requires every bot's DATABASE_URL, resolved through that Secret, to authenticate as oshal_bot. The template-source half (no superuser interpolation in bots.yaml) is unchanged.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { RENDER_TIMEOUT_MS, helmTemplate, resolvedEnv } from '../helpers/helm-template';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHART_DIR = path.join(REPO_ROOT, 'deploy', 'helm', 'oshal');

// The generator is the single source of fleet truth — the spec runs the REAL one
// against the REAL compose file, so a compose bot change reddens this without any
// chart edit (and vice versa).
const generatorUrl = new URL(`file://${path.join(REPO_ROOT, 'scripts', 'generate-chart-fleet.mjs').replace(/\\/g, '/')}`).href;

const values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;
const botsTemplate = fs.readFileSync(path.join(CHART_DIR, 'templates', 'bots.yaml'), 'utf8');
const apiTemplate = fs.readFileSync(path.join(CHART_DIR, 'templates', 'api.yaml'), 'utf8');

describe('ADR-129 chart fleet parity (compose is the source of truth)', () => {
  it('values.yaml fleet block matches the compose-derived fleet (generator --check)', async () => {
    const gen = await import(generatorUrl);
    const { changed } = gen.run('check');
    expect(changed, 'fleet drift — run: node scripts/generate-chart-fleet.mjs --write').toBe(false);
  });

  it('docker-socket bots are excluded from the k8s fleet, with the reason logged', async () => {
    const gen = await import(generatorUrl);
    const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.oshal-local.yml'), 'utf8');
    const { bots, excluded } = gen.deriveFleet(compose);
    const socketExclusions = excluded.filter((e: { reason: string }) => e.reason.includes('docker socket'));
    expect(socketExclusions.length, 'the docker-socket exclusion rule must stay alive').toBeGreaterThan(0);
    for (const e of socketExclusions) {
      expect(bots.map((b: { name: string }) => b.name)).not.toContain(e.name);
    }
  });

  it('every fleet bot persona file exists in ai-lab/bot-personas', () => {
    for (const fleet of ['kernel', 'full'] as const) {
      for (const bot of values.fleets[fleet]) {
        const persona = bot.personaFile ?? `/app/ai-lab/bot-personas/${bot.name}.yaml`;
        const onDisk = path.join(REPO_ROOT, persona.replace('/app/', '').split('/').join(path.sep));
        expect(fs.existsSync(onDisk), `${fleet} bot ${bot.name}: persona missing on disk: ${persona}`).toBe(true);
      }
    }
  });

  it('fleets are non-vacuous, kernel ⊆ full, and agent IDs are unique per fleet', () => {
    expect(values.fleets.kernel.length).toBeGreaterThanOrEqual(3);
    expect(values.fleets.full.length).toBeGreaterThan(values.fleets.kernel.length);
    const fullNames = new Set(values.fleets.full.map((b: { name: string }) => b.name));
    for (const k of values.fleets.kernel) {
      expect(fullNames.has(k.name), `kernel bot ${k.name} missing from full`).toBe(true);
    }
    for (const fleet of ['kernel', 'full'] as const) {
      const ids = values.fleets[fleet].map((b: { agentId: string }) => b.agentId);
      expect(new Set(ids).size, `duplicate agentId in fleets.${fleet}`).toBe(ids.length);
    }
  });
});

describe('ADR-129 chart codeless-install defaults', () => {
  it('image defaults to the public registry pull (never the retired image name)', () => {
    expect(values.image.repository).toBe('ghcr.io/emeraldcoastsystemsgroup/oshal-bot');
    expect(values.image.pullPolicy).toBe('IfNotPresent');
  });

  it('Kyma APIRule and the tailnet relay are OFF by default (generic clusters)', () => {
    expect(values.cockpit.apiRule.enabled).toBe(false);
    expect(values.relay.enabled).toBe(false);
  });

  it('LLM defaults follow the codex fleet floor (compose SEQ-13 parity)', () => {
    expect(values.swarm.forceLlmProvider).toBe('openai-codex');
    const m = /^gpt-(\d+)\.(\d+)/.exec(values.swarm.forceLlmModel);
    expect(m, `forceLlmModel must be a gpt-<maj>.<min> id, got ${values.swarm.forceLlmModel}`).toBeTruthy();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    expect(major > 5 || (major === 5 && minor >= 5), `model ${values.swarm.forceLlmModel} is below the gpt-5.5 floor`).toBe(true);
    expect(values.swarm.codexReasoningEffort).toBeTruthy();
  });

  it('bots carry the least-privilege oshal_bot DSN, never the superuser (K5)', () => {
    // The superuser interpolation belongs to the api's BOOTSTRAP_DATABASE_URL only —
    // its presence in the BOT template is the exact 0.1.x defect K5 closed.
    expect(botsTemplate.includes('.Values.infra.postgres.user'), 'bots.yaml must not build a DSN from the superuser role').toBe(false);
    expect(botsTemplate.includes('.Values.infra.postgres.password'), 'bots.yaml must not carry the superuser password').toBe(false);
    // The DSN now arrives through the chart's Secret, so the check is on what each bot
    // actually resolves to, not on a literal in the template.
    const objects = helmTemplate({});
    const bots = objects.filter((o) => o.kind === 'Deployment' && o.metadata.labels?.['oshal.io/bot'] === 'true');
    expect(bots.length, 'the default fleet rendered no bots - nothing was checked').toBeGreaterThan(0);
    for (const b of bots) {
      const url = resolvedEnv(objects, b.spec?.template?.spec?.containers?.[0]).DATABASE_URL;
      expect(url, `${b.metadata.name} resolves no DATABASE_URL`).toBeTruthy();
      expect(new URL(url).username, `${b.metadata.name} does not connect as oshal_bot`).toBe('oshal_bot');
    }
  }, RENDER_TIMEOUT_MS);

  it('seeding-repair parity: bots never cp the config seed; api copies IF-MISSING only', () => {
    // Assert on template CODE, not the change-log narrative that documents the old bug.
    const code = (t: string) => t.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code(botsTemplate).includes('cp '), 'bot seeding belongs to bot-entrypoint.sh Step 1b, not the pod command').toBe(false);
    expect(code(apiTemplate)).toContain('cp -n /app/config-seed/global-config.json');
    expect(code(apiTemplate).includes('cp -f'), 'api must never force-reimpose the seed over runtime config').toBe(false);
  });
});
