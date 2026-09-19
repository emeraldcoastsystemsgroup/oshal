/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the cockpit "Provider" column end to end. The renderer has always read `bot.providerId` under a `<th>Provider</th>`, but CockpitAgentUsageStats never declared the field and every rollup dropped it, so the column rendered an em dash for every bot on every ticket regardless of data. These cases cross the drop boundary - a chat_tasks-shaped row through the real rollup and merge - and assert the renderer's contract against the real renderer source rather than a restatement of it, so the column cannot go structurally dead again without a red test.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Also guards the ADR-127 cost-unit label. Est. Cost stacked a subscription price-equivalent, a $0 BYO token count and real metered spend into one figure. The load-bearing case is the negative one: classifyCostUnit answers 'billed' for anything it does not recognise, so an unknown or merged provider must come back unlabelled rather than asserting real money.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rollupTaskUsageByAgent,
  mergeAgentUsageMaps,
  readTaskUsageSummary,
} from '@/app/routes/cockpit-cost-route-helpers';

const RENDERER = join(process.cwd(), 'src/pages/cockpit/js/views/ticket-view-cost-renderer.js');

/** A chat_tasks row as the task store hands it over: provider_id mapped to providerId. */
function taskRow(agentId: string, providerId: string | undefined, cost = 1) {
  return {
    agentId,
    providerId,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalTokens: 15,
    totalCost: cost,
    totalRequests: 1,
  } as Record<string, unknown>;
}

describe('the cockpit Cost-by-Bot "Provider" column is fed, not structurally dead', () => {
  it('the provider on the task row survives the rollup', () => {
    // The original defect: this field was read off no row and declared on no type, so the
    // column could never show anything. Every one of these ids appears in live chat_tasks.
    for (const provider of ['openai-codex', 'claude-code', 'cline-cli', 'byo-llm', 'deterministic-provider']) {
      const rolled = rollupTaskUsageByAgent([taskRow('bot-a', provider)]);
      expect(rolled['bot-a']?.providerId, `${provider} was dropped by the rollup`).toBe(provider);
    }
  });

  it('a row with no provider yields null, which is what the renderer turns into an em dash', () => {
    // 2,701 live rows have a null provider_id. Those must stay distinguishable from a real
    // provider rather than being coerced to a plausible-looking default.
    const rolled = rollupTaskUsageByAgent([taskRow('bot-a', undefined)]);
    expect(rolled['bot-a']?.providerId).toBeNull();
  });

  it('merging two tickets on the same provider keeps it, and merging across providers says "mixed"', () => {
    // A bot can legitimately run on more than one provider across tasks. Keeping whichever
    // arrived first would render a confident, wrong single value - so the merge must widen.
    const same = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', 'claude-code')]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'claude-code')]),
    );
    expect(same['bot-a']?.providerId).toBe('claude-code');
    expect(same['bot-a']?.totalCost, 'the cost merge must still accumulate').toBe(2);

    const across = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', 'claude-code')]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'openai-codex')]),
    );
    expect(across['bot-a']?.providerId).toBe('mixed');
  });

  it('a known provider merged with an unknown one keeps the known one', () => {
    const merged = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', undefined)]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'cline-cli')]),
    );
    expect(merged['bot-a']?.providerId).toBe('cline-cli');

    const reversed = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', 'cline-cli')]),
      rollupTaskUsageByAgent([taskRow('bot-a', undefined)]),
    );
    expect(reversed['bot-a']?.providerId, 'merge order must not change the answer').toBe('cline-cli');
  });

  it('each provider is labelled with the ADR-127 unit its cost figure is actually in', () => {
    // The Est. Cost column used to stack three different units into one number: a CLI turn is a
    // subscription price-equivalent, a BYO turn is $0 tokens-only, and a hosted turn is real money.
    // Every id here is one the live ledger actually stamps, and each expectation was read off
    // classifyCostUnit rather than assumed - the first draft of this case guessed cline-cli was
    // subscription-backed and openai-codex was metered, and both guesses were backwards.
    const cases: Array<[string, string]> = [
      ['claude-code', 'price-equivalent (subscription)'],
      ['openai-codex', 'price-equivalent (subscription)'],
      ['byo-llm', 'BYO (tokens only)'],
      ['byo-hosted:gemini-2.5-flash', 'BYO (tokens only)'],
      ['image-provider:openrouter', 'billed'],
      ['cline-cli', 'billed'],
    ];
    for (const [provider, label] of cases) {
      const rolled = rollupTaskUsageByAgent([taskRow('bot-a', provider)]);
      expect(rolled['bot-a']?.costUnitLabel, `${provider} was mislabelled`).toBe(label);
    }
  });

  it('an unknown or mixed provider is left unlabelled rather than called "billed"', () => {
    // classifyCostUnit answers 'billed' for anything it does not recognise. Passing an unknown
    // or merged provider straight into it would assert real metered spend for what may be a
    // subscription equivalent - the precise error the unit split exists to prevent.
    expect(rollupTaskUsageByAgent([taskRow('bot-a', undefined)])['bot-a']?.costUnitLabel).toBeNull();

    const across = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', 'claude-code')]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'openai-codex')]),
    );
    expect(across['bot-a']?.providerId).toBe('mixed');
    expect(across['bot-a']?.costUnitLabel, 'a mixed row must not claim a single unit').toBeNull();
  });

  it('the label follows the merged provider, never disagreeing with it', () => {
    // A row showing provider "cline-cli" beside the label "billed" would be worse than no label.
    const merged = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', undefined)]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'cline-cli')]),
    );
    expect(merged['bot-a']?.providerId).toBe('cline-cli');
    expect(merged['bot-a']?.costUnitLabel).toBe('billed');

    const subscription = mergeAgentUsageMaps(
      rollupTaskUsageByAgent([taskRow('bot-a', undefined)]),
      rollupTaskUsageByAgent([taskRow('bot-a', 'claude-code')]),
    );
    expect(subscription['bot-a']?.costUnitLabel).toBe('price-equivalent (subscription)');
  });

  it('the single-task summary labels the row too, not only the merged rollup', () => {
    // readTaskUsageSummary is exported and reaches usage-by-agent WITHOUT passing through
    // mergeAgentUsageMaps. That matters: the merge re-derives the label from the merged provider,
    // so a rollup-only assertion stays green even when the per-task build stops deriving it at
    // all. This case is the one that actually covers the per-task derivation - verified by
    // deleting that derivation and watching only this case go red.
    const summary = readTaskUsageSummary(taskRow('bot-a', 'claude-code'));
    expect(summary.usageByAgent['bot-a']?.providerId).toBe('claude-code');
    expect(summary.usageByAgent['bot-a']?.costUnitLabel).toBe('price-equivalent (subscription)');

    const unknown = readTaskUsageSummary(taskRow('bot-a', undefined));
    expect(unknown.usageByAgent['bot-a']?.costUnitLabel).toBeNull();
  });

  it('the renderer still reads the field this rollup produces', () => {
    // Asserting against the real renderer source, not a copy of it. If someone renames the
    // field on either side, these two halves stop agreeing and this case is what notices.
    const source = readFileSync(RENDERER, 'utf-8');
    expect(source, 'the Provider header is gone - the column was removed, not fixed')
      .toContain('<th>Provider</th>');
    expect(source, 'the renderer no longer reads providerId; the rollup field is now orphaned')
      .toMatch(/bot\.providerId/);
    expect(source, 'the renderer dropped the unit label; Est. Cost is summing units again')
      .toMatch(/bot\.costUnitLabel/);
  });
});
