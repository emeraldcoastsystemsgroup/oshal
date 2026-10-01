/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Test Lab registration guard for the deck engine's brand-look card: the card is in SCENARIOS, its suites exist and are exactly the suites tests/README.md documents for it, its in-process step passes on this engine, and its verdict fails, naming the format, when a file lacks the brand or a renderer draws a forged look.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { BRAND_LOOK_SCENARIOS, brandLookVerdict } from '@/app/routes/test-lab-brand-look-scenarios';

const REFUSED = { pptx: 'refused', docx: 'refused', xlsx: 'refused' };
const NONE_MISSING = { pptx: [] as string[], docx: [] as string[], xlsx: [] as string[] };

describe('brand-look Test Lab registration', () => {
  it('is registered, and its suites exist and match the documented local command exactly', () => {
    const [card] = BRAND_LOOK_SCENARIOS;
    expect(SCENARIOS.find((s) => s.id === 'brand-look-render')).toBe(card);
    expect(card.group).toBe('tool');
    expect(card.explicitOnly).toBeUndefined();
    const paths = card.regressionTests!.map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
    const readme = readFileSync('tests/README.md', 'utf8');
    const command = /npx vitest run (tests\/unit\/brand-look-render\.spec\.ts[^\n`]*)/.exec(readme)?.[1] ?? '';
    expect(new Set(command.match(/tests\/unit\/[a-z0-9-]+\.spec\.ts/g))).toEqual(new Set(paths));
  });

  it('passes on this engine: three files read back in the brand, the forged look refused', async () => {
    const result = await BRAND_LOOK_SCENARIOS[0].steps[0].run('', {});
    expect(result).toMatchObject({ app: 'deck-generation', state: 'pass' });
  }, 60_000);

  it('fails, naming the format, when a file lacks the brand or a forged look is drawn', () => {
    expect(brandLookVerdict(NONE_MISSING, REFUSED).state).toBe('pass');
    expect(brandLookVerdict({ ...NONE_MISSING, docx: ['7D2AE8'] }, REFUSED))
      .toEqual({ state: 'fail', detail: '.docx lacks 7D2AE8' });
    expect(brandLookVerdict(NONE_MISSING, { ...REFUSED, xlsx: 'drew the forged look' }))
      .toEqual({ state: 'fail', detail: '.xlsx drew the forged look' });
  });
});
