/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the cockpit "Provider" column end to end. The renderer has always read `bot.providerId` under a `<th>Provider</th>`, but CockpitAgentUsageStats never declared the field and every rollup dropped it, so the column rendered an em dash for every bot on every ticket regardless of data. These cases cross the drop boundary - a chat_tasks-shaped row through the real rollup and merge - and assert the renderer's contract against the real renderer source rather than a restatement of it, so the column cannot go structurally dead again without a red test.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Also guards the ADR-127 cost-unit label. Est. Cost stacked a subscription price-equivalent, a $0 BYO token count and real metered spend into one figure. The load-bearing case is the negative one: an ABSENT provider and the 'mixed' sentinel must come back unlabelled rather than asserting real money. An unrecognised but PRESENT id is still labelled 'billed' on purpose - cline-cli is asserted that way in this same file - because that is classifyCostUnit's conservative default.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The two renderer cases now EXECUTE renderCostTab and assert on the emitted <td> instead of grepping the module source. The substring versions were theatre and were proven so: they stayed green against a column that rendered an em dash for every row, and stayed green when the whole Cost-by-Bot table was deleted with the matched strings left behind in a comment. They also drive the contributingBots payload, which is the shape the ticket-activity route always sends and the branch that clobbers the other - the defect they failed to catch lived there.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Covers the DIRECT cost summary, which the ticket-activity route prefers over the task rollup. Its per-bot provider aggregation was first-wins, which was invisible until this feature rendered it - a bot spanning claude-code and cline-cli would have shown one provider and one confident ADR-127 unit label for spend that is two different units. It widens to "mixed" now, and the case asserts the derived label then declines to name a unit.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Covers a NULL provider_id end to end, which nothing did. The direct summary writes the literal 'unknown' for one; that is truthy, so it survived every absent-check, and classifyCostUnit answers 'billed' for anything unrecognised - so the cockpit rendered `unknown` labelled `billed`, asserting real metered money for a bot with no recorded provider. 2,701 live chat_tasks rows are in that state, so it was the majority case. Also renames the merge case that said "unknown" where its body passes an ABSENT provider - the same conflation this file spent an entry correcting.
 */

import { describe, it, expect } from 'vitest';
// The direct cost summary is the PREFERRED source for this surface, so its own per-bot
// aggregation has to widen the same way the cockpit merge does.
import { CostTrackingService } from '@/features/operational-intelligence';
import { buildUsageSummaryFromDirectCostSummary } from '@/app/routes/cockpit-route-helpers';
import {
  rollupTaskUsageByAgent,
  mergeAgentUsageMaps,
  readTaskUsageSummary,
  deriveCostUnitLabel,
} from '@/app/routes/cockpit-cost-route-helpers';
// The REAL renderer module. Asserting on its source text instead let both halves of this feature
// ship broken: the substring cases stayed green against a column that rendered an em dash for
// every row, and green again when the entire Cost-by-Bot table was deleted and the strings left
// behind in a comment. Executing it and reading the emitted <td> is the only assertion that bites.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - untyped cockpit JS module
import { renderCostTab } from '../../src/pages/cockpit/js/views/ticket-view-cost-renderer.js';

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

  it('a known provider merged with an ABSENT one keeps the known one', () => {
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

  it('an ABSENT or mixed provider is left unlabelled; an unrecognised one is deliberately "billed"', () => {
    // Two different cases, and the earlier one in this file asserts the second: an ABSENT
    // provider and the 'mixed' sentinel come back unlabelled, because no single unit is knowable.
    // An unrecognised but PRESENT id - cline-cli, asserted as 'billed' twenty lines above - is
    // deliberately labelled, because that is classifyCostUnit's conservative default and changing
    // it belongs in cost-unit.ts next to the sets, not in a display helper.
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

  it('the direct cost summary widens across providers too, instead of keeping the first', () => {
    // This path is preferred over the task rollup (cockpit-ticket-activity-route), so a
    // first-wins provider here would render one confident provider and one confident ADR-127
    // unit label for spend that is two different units — the quiet lie mergeProviderId avoids.
    const rows = [
      { agent_id: 'bot-a', provider_id: 'claude-code', total_cost: '1', total_input_tokens: '1', total_output_tokens: '1', total_tokens: '2', total_requests: '1', cost_currency: 'USD', usage_by_model: {} },
      { agent_id: 'bot-a', provider_id: 'cline-cli', total_cost: '1', total_input_tokens: '1', total_output_tokens: '1', total_tokens: '2', total_requests: '1', cost_currency: 'USD', usage_by_model: {} },
      { agent_id: 'bot-b', provider_id: 'claude-code', total_cost: '1', total_input_tokens: '1', total_output_tokens: '1', total_tokens: '2', total_requests: '1', cost_currency: 'USD', usage_by_model: {} },
    ];
    const pool = { query: async () => ({ rows, rowCount: rows.length }) };
    const service = new CostTrackingService(pool as never);

    return service.queryCostByTicket('tkt-1').then((summary) => {
      expect(summary, 'the query returned null - the fake pool shape is wrong').toBeTruthy();
      expect(summary.usageByAgent['bot-a']?.providerId, 'a bot spanning providers must not claim one')
        .toBe('mixed');
      expect(summary.usageByAgent['bot-b']?.providerId, 'a bot on one provider still names it')
        .toBe('claude-code');
      // And the label derived from it must then decline to name a unit.
      expect(deriveCostUnitLabel(summary.usageByAgent['bot-a'].providerId)).toBeNull();
      expect(deriveCostUnitLabel(summary.usageByAgent['bot-b'].providerId)).toBe('price-equivalent (subscription)');
    });
  });

  it('a NULL provider_id reaches the markup as an em dash, not as "unknown / billed"', () => {
    // The whole path, because every layer of it looked right on its own. The direct summary
    // writes the literal 'unknown' for a NULL provider_id; that is truthy, so it survived every
    // absent-check, and classifyCostUnit answers 'billed' for anything it does not recognise —
    // so the cockpit asserted real metered money for a bot with no recorded provider. 2,701 live
    // chat_tasks rows are in exactly that state, so this was the majority case, not a corner.
    const rows = [{
      agent_id: 'bot-null', provider_id: null, total_cost: '1', total_input_tokens: '1',
      total_output_tokens: '1', total_tokens: '2', total_requests: '1', cost_currency: 'USD',
      usage_by_model: {},
    }];
    const service = new CostTrackingService({ query: async () => ({ rows, rowCount: 1 }) } as never);

    return service.queryCostByTicket('tkt-null').then((summary) => {
      expect(summary, 'the query returned null — the fake pool shape is wrong').toBeTruthy();
      const direct = { usageByAgent: summary?.usageByAgent ?? {} };
      const normalized = buildUsageSummaryFromDirectCostSummary(direct as never);
      const row = normalized.usageByAgent['bot-null'];

      expect(row?.providerId, 'the sentinel reached the cockpit as a provider').toBeNull();
      expect(row?.costUnitLabel, 'a bot with no provider was labelled with a unit').toBeNull();

      const body: { innerHTML: string } = { innerHTML: '' };
      renderCostTab(body, { id: 't1' }, {
        totalCost: 1, totalTokens: 2, totalRequests: 1,
        usageByAgent: normalized.usageByAgent,
        contributingBots: Object.values(normalized.usageByAgent),
      });
      expect(body.innerHTML).toContain('<td>—</td>');
      expect(body.innerHTML, 'the markup still says "unknown"').not.toContain('<td>unknown</td>');
      expect(body.innerHTML, 'real metered money asserted for a bot with no provider')
        .not.toContain('billed');
    });
  });

  it('the rendered Cost-by-Bot row actually shows the provider and the unit', () => {
    // `contributingBots` is the shape the ticket-activity route ALWAYS sends, and the renderer's
    // second normalize branch clobbers the first with it. A payload without it would have passed
    // even while the browser showed an em dash, which is exactly what happened.
    const body: { innerHTML: string } = { innerHTML: '' };
    renderCostTab(body, { id: 't1' }, {
      totalCost: 1.5, totalTokens: 15, totalRequests: 1,
      usageByAgent: {
        'bot-a': {
          agentId: 'bot-a', agentName: 'Bot A', providerId: 'claude-code',
          costUnitLabel: 'price-equivalent (subscription)',
          totalRequests: 1, totalInputTokens: 10, totalOutputTokens: 5, totalTokens: 15, totalCost: 1.5,
        },
      },
      contributingBots: [{
        agentId: 'bot-a', agentName: 'Bot A', providerId: 'claude-code',
        costUnitLabel: 'price-equivalent (subscription)',
        totalRequests: 1, totalInputTokens: 10, totalOutputTokens: 5, totalTokens: 15, totalCost: 1.5,
      }],
    });

    expect(body.innerHTML, 'the Cost-by-Bot table is gone entirely').toContain('<th>Provider</th>');
    expect(body.innerHTML, 'the Provider cell rendered an em dash despite a provider in the payload')
      .toContain('<td>claude-code</td>');
    expect(body.innerHTML, 'the em dash is still being rendered for a row that has a provider')
      .not.toContain('<td>—</td>');
    expect(body.innerHTML, 'the ADR-127 unit label never reached the markup')
      .toContain('price-equivalent (subscription)');
  });

  it('a row with no provider renders the em dash and no unit label', () => {
    const body: { innerHTML: string } = { innerHTML: '' };
    renderCostTab(body, { id: 't1' }, {
      totalCost: 1, totalTokens: 15, totalRequests: 1,
      usageByAgent: {},
      contributingBots: [{
        agentId: 'bot-b', agentName: 'Bot B',
        totalRequests: 1, totalInputTokens: 10, totalOutputTokens: 5, totalTokens: 15, totalCost: 1,
      }],
    });

    expect(body.innerHTML).toContain('<td>—</td>');
    expect(body.innerHTML, 'a unit was asserted for a row whose provider is unknown')
      .not.toContain('price-equivalent');
    expect(body.innerHTML).not.toContain('billed');
  });

});
