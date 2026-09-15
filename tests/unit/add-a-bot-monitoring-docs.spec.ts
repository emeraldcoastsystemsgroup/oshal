/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the BACKLOG entry "Add-a-bot checklist omits the scrape target". Monitoring became inherited on 2026-08-13 (BUG-15): Prometheus discovers every runtime container by the label the compose `x-bot-common` anchor stamps on it, so there is no scrape-target step. Neither add-a-bot surface (docs/building-a-bot.md, the CLAUDE.md bot-registry section) said so, which left the retired hand-listed step as the obvious thing to reinvent. Pins, per surface: (1) one paragraph/list item names `x-bot-common`, says the bot is scraped automatically, and names the discovery label; (2) no sentence tells anyone to edit ops/monitoring/prometheus.yml and no checklist item names that file. Crosses the boundary the docs describe: the label the docs must name is READ from the real worker scrape job's docker_sd filter and the real compose anchor, so renaming the label in config without updating the docs goes red.
 */

/**
 * Add-a-bot docs describe the monitoring the stack actually has.
 *
 * The docs are the boundary a reader crosses before adding a bot; the config is what the docs
 * make a claim about. So the label the prose must name is never typed here — it is derived from
 * `ops/monitoring/prometheus.yml` (the worker job's discovery filter) and confirmed against the
 * `x-bot-common` anchor in `docker-compose.oshal-local.yml`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const BUILDING_A_BOT = 'docs/building-a-bot.md';
const CLAUDE_MD = 'CLAUDE.md';
const CLAUDE_SECTION = '## Bot registry';
const STACK_COMPOSE = 'docker-compose.oshal-local.yml';
const PROMETHEUS_YML = 'ops/monitoring/prometheus.yml';
const WORKER_JOB = 'oshal-swarm-bots';

/** Verbs that turn a sentence naming prometheus.yml into an instruction to change it. */
const EDIT_VERB = /\b(add|edit|updat|append|regist|list|insert|includ|declar|put|writ|extend|chang|modif)\w*/i;
/** Negations that must come BEFORE that verb for the sentence to be a "do not" instead. */
const NEGATION = /\b(do not|don't|never|no|nobody|not|nothing|without)\b/i;

/**
 * @description Reads the label the worker scrape job discovers containers by, from the real
 *   prometheus.yml. Fails loudly (rather than skipping) if the job or its label filter is gone.
 * @returns The discovery label as a `[key, value]` pair, e.g. `['oshal.tier', 'worker']`.
 */
function workerDiscoveryLabel(): [string, string] {
  const cfg = yaml.load(read(PROMETHEUS_YML)) as { scrape_configs: Array<Record<string, unknown>> };
  const job = cfg.scrape_configs.find((c) => c.job_name === WORKER_JOB);
  expect(job, `${PROMETHEUS_YML} must declare the ${WORKER_JOB} job`).toBeTruthy();
  const sd = (job!.docker_sd_configs ?? []) as Array<{ filters?: Array<{ name: string; values: string[] }> }>;
  const value = sd.flatMap((s) => s.filters ?? []).find((f) => f.name === 'label')?.values[0];
  expect(value, `${WORKER_JOB} must discover targets by a container label`).toMatch(/^[^=]+=[^=]+$/);
  const [key, val] = value!.split('=');
  return [key, val];
}

/**
 * @description Extracts each add-a-bot surface: the whole guide, and CLAUDE.md's bot-registry
 *   section bounded by the next level-2 heading. A renamed heading fails instead of passing empty.
 * @returns Surface name mapped to its markdown text.
 */
function surfaces(): Record<string, string> {
  const claude = read(CLAUDE_MD);
  const start = claude.indexOf(`\n${CLAUDE_SECTION}`);
  expect(start, `${CLAUDE_MD} must keep its "${CLAUDE_SECTION}" section`).toBeGreaterThan(-1);
  const end = claude.indexOf('\n## ', start + 1);
  return {
    [BUILDING_A_BOT]: read(BUILDING_A_BOT),
    [`${CLAUDE_MD} ${CLAUDE_SECTION}`]: claude.slice(start, end === -1 ? undefined : end),
  };
}

/**
 * @description Splits markdown into paragraphs and list items, so a claim must be made in one
 *   place rather than assembled from words scattered across the page.
 * @param text - Markdown source.
 * @returns Blocks of text, one per paragraph or list item.
 */
function blocks(text: string): string[] {
  return text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map((b) => b.replace(/\s+/g, ' ').trim());
}

/**
 * @description True when a sentence tells the reader to change prometheus.yml: it names the file
 *   and an edit verb, and no negation precedes the first such verb.
 * @param sentence - One sentence of prose, whitespace-collapsed.
 * @returns Whether the sentence is an instruction to edit the scrape config.
 */
function instructsPrometheusEdit(sentence: string): boolean {
  if (!/prometheus\.yml/i.test(sentence)) return false;
  const verb = EDIT_VERB.exec(sentence);
  if (!verb) return false;
  return !NEGATION.test(sentence.slice(0, verb.index));
}

describe('add-a-bot docs: monitoring is inherited from x-bot-common', () => {
  const [labelKey, labelValue] = workerDiscoveryLabel();
  const labelForms = [`${labelKey}: ${labelValue}`, `${labelKey}=${labelValue}`];

  it('the label the docs must name is the one the real anchor stamps and the worker job discovers', () => {
    const compose = yaml.load(read(STACK_COMPOSE)) as Record<string, { labels?: Record<string, string> }>;
    const anchorLabels = compose['x-bot-common']?.labels ?? {};
    expect(anchorLabels[labelKey], `x-bot-common must carry ${labelKey}: ${labelValue}`).toBe(labelValue);
  });

  for (const [name, text] of Object.entries(surfaces())) {
    it(`${name} says a bot inheriting x-bot-common is scraped automatically, naming the label`, () => {
      const claim = blocks(text).find((b) => b.includes('x-bot-common')
        && /scraped automatically/i.test(b)
        && labelForms.some((form) => b.includes(form)));
      expect(claim, `${name} must state, in one paragraph or list item, that a bot inheriting `
        + `\`x-bot-common\` is scraped automatically and name the \`${labelForms[0]}\` label`).toBeTruthy();
    });

    it(`${name} never instructs anyone to edit ${PROMETHEUS_YML}`, () => {
      const sentences = blocks(text).flatMap((b) => b.split(/(?<=[.!?])\s+/));
      expect(sentences.filter(instructsPrometheusEdit), `${name} must not send a reader to prometheus.yml`).toEqual([]);
      const checklist = blocks(text).filter((b) => /^[-*] \[[ xX]\]/.test(b));
      expect(checklist.filter((b) => /prometheus\.yml/i.test(b)), `${name} checklist must not name prometheus.yml`).toEqual([]);
    });
  }
});
