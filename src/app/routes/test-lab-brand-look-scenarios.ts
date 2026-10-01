/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for brand looks in the deck-generation kernel skill (backlog "AI Office: draw a deck, document or workbook in a brand kit's exact colors and fonts", approved 2026-09-22). One in-process step on the installed engine: build a brand look from a synthetic kit, render a deck, a document and a workbook in memory, read the kit's colors and body face back out of each file, and require each renderer to refuse a forged look. It writes nothing, calls no route and spends nothing.
 *
 * @module routes/test-lab-brand-look-scenarios
 */

import JSZip from 'jszip';
import { createChildLogger } from '@/shared/logger';
import {
  brandTheme, isBrandLookError, renderDocx, renderPptx, renderXlsx, type DeckTheme,
} from '@/features/presentation-generation';
import type { RenderableSlide } from '@/shared/types';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-brand-look' });

const APP = 'deck-generation';
const LABEL = 'Brand look renders, forged look refused';

/** A synthetic kit whose colors and faces belong to none of the ten built-in looks. */
const SAMPLE_KIT = {
  base: 'executive',
  colors: { primary: '#7d2ae8', secondary: '#00a6a6', accent: '#ff7a59', dark: '#1d1733', light: '#fffdf7' },
  fonts: { heading: 'Georgia', body: 'Trebuchet MS' },
};

/** Read back from every format: the primary color, the text color and the body face. */
const EXPECTED = ['7D2AE8', '1D1733', 'Trebuchet MS'];

const OUTLINE: RenderableSlide[] = [
  { title: 'Where we are', content: 'shipped the runtime\nsigned three design partners' },
  { title: 'The numbers', content: '94% :: uptime last quarter\n$1.2M :: pipeline created' },
  { title: 'By segment', content: '| Segment | Revenue |\n| --- | --- |\n| Enterprise | 4100000 |\n| Mid-market | 1800000 |' },
];

const RENDERERS = { pptx: renderPptx, docx: renderDocx, xlsx: renderXlsx } as const;
type Format = keyof typeof RENDERERS;

/**
 * @description Every XML part of a rendered Office file, joined — where its colors and faces live.
 * @param buf - the rendered file.
 * @returns the joined XML.
 */
async function xmlText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.xml$/.test(name));
  return (await Promise.all(parts.map((name) => zip.files[name].async('string')))).join('\n');
}

/**
 * @description Judge the evidence the step gathered. A file missing any expected value, or a
 * renderer that drew the forged look (or failed for another reason), fails the step and is named.
 * @param missing - per format, the expected values its file did not contain.
 * @param refusals - per format, what handing it the forged look produced ('refused' is correct).
 * @returns the step state and its detail.
 */
export function brandLookVerdict(
  missing: Record<Format, string[]>, refusals: Record<Format, string>,
): Pick<StepResult, 'state' | 'detail'> {
  const unread = (Object.keys(missing) as Format[]).filter((k) => missing[k].length).map((k) => `.${k} lacks ${missing[k].join(', ')}`);
  const drawn = (Object.keys(refusals) as Format[]).filter((k) => refusals[k] !== 'refused').map((k) => `.${k} ${refusals[k]}`);
  if (unread.length || drawn.length) return { state: 'fail', detail: [...unread, ...drawn].join('; ') };
  return {
    state: 'pass',
    detail: 'A deck, a document and a workbook drawn in a synthetic brand look carry its colors and body face; '
      + 'each renderer refused a forged look and produced no file.',
  };
}

/**
 * @description The live step: on this server's own engine, render the three formats in a brand
 * look and read them back, then hand each renderer a forged look. In memory only.
 * @param _cookie - the initiating user's session cookie; unused, this step calls no route.
 * @returns the verdict.
 */
async function brandLookStep(_cookie: string): Promise<StepResult> {
  try {
    const look = brandTheme(SAMPLE_KIT);
    const forged = { ...look, colors: { ...look.colors, accent: 'not-a-color' } } as DeckTheme;
    const missing = {} as Record<Format, string[]>;
    const refusals = {} as Record<Format, string>;
    for (const kind of Object.keys(RENDERERS) as Format[]) {
      const render = RENDERERS[kind];
      const xml = await xmlText(await render('Test Lab brand look', OUTLINE, { theme: look }));
      missing[kind] = EXPECTED.filter((value) => !xml.includes(value));
      refusals[kind] = await render('Test Lab forged look', OUTLINE, { theme: forged }).then(
        () => 'drew the forged look',
        (err: unknown) => (isBrandLookError(err) ? 'refused' : `failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    return { app: APP, label: LABEL, ...brandLookVerdict(missing, refusals) };
  } catch (err) {
    logger.error({ err }, 'brand-look Test Lab step failed');
    return { app: APP, label: LABEL, state: 'fail', detail: `The engine could not draw a brand look: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The brand-look Test Lab card: one in-process render-and-read-back of the installed engine. */
export const BRAND_LOOK_SCENARIOS: Scenario[] = [{
  id: 'brand-look-render',
  title: 'Brand looks in the deck engine (deck-generation kernel skill)',
  group: 'tool',
  description: 'Builds a brand look from a synthetic kit with this server\'s deck engine, renders a deck, a document and a workbook in memory and reads the kit\'s colors and body face back out of each file, then hands each renderer a forged look and requires the refusal. The linked suites also pin the ten built-in looks part-for-part. Writes nothing, calls no route and spends nothing.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/brand-look-render.spec.ts' },
    { level: 'unit', path: 'tests/unit/deck-looks-unchanged.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-brand-look-registration.spec.ts' },
  ],
  steps: [{ id: 'render', app: APP, label: LABEL, run: brandLookStep }],
}];
