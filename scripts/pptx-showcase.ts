/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — renders a showcase deck per theme so a human can OPEN the artifact and judge it. There is no LibreOffice on the dev host, so a .pptx cannot be rasterised in CI; the honest substitute is producing the real files and letting the operator look. Doubles as the smoke test for every layout (mirrors scripts/graph-smoke.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { renderPptx, THEME_IDS, resolveTheme } from '@/features/presentation-generation';
import type { DeckThemeId, RenderableSlide } from '@/shared/types';

/**
 * One slide per layout family, written the way an author actually would — this is the deck
 * that proves auto-selection works, since only two slides below name a layout explicitly.
 */
const SHOWCASE: RenderableSlide[] = [
  { title: 'The story so far', content: 'Agent orchestration stopped being a research problem\nEvery team now runs three tools that do not talk\nThe cost shows up as tokens, not headcount', notes: 'Open on the problem, not the product.' },
  { title: 'Every deck looks the same', content: '#layout: statement\nBecause every generator only knows one slide.' },
  { title: 'Where we are', content: '94% :: uptime last quarter\n$1.2M :: pipeline created\n3.4x :: faster than baseline' },
  { title: 'Revenue by quarter', content: 'Q1: 120\nQ2: 180\nQ3: 240\nQ4: 310' },
  { title: 'Revenue mix', content: 'Enterprise: 55\nMid-market: 30\nSelf-serve: 15' },
  { title: 'Adoption by team', content: 'Engineering: 42\nSales: 18\nSupport: 27\nFinance: 9' },
  { title: 'Build vs buy', content: '## Build\nfull control of the roadmap\nour IP\nslower to ship\n## Buy\nlive next quarter\nvendor lock-in\nprice rises with seats' },
  { title: 'By segment', content: '| Segment | Revenue | Growth | Churn |\n| --- | --- | --- | --- |\n| Enterprise | $4.1M | 22% | 3% |\n| Mid-market | $1.8M | 41% | 7% |\n| Self-serve | $0.6M | 88% | 19% |' },
  { title: 'What they told us', content: '> It cut our close from four days to about twenty minutes, and nobody had to learn a new tool.\n— Jane Roe, CFO at Northwind' },
  { title: 'Roadmap', content: 'Q1 2026 :: Private preview\nQ2 2026 :: General availability\nQ3 2026 :: Marketplace\nQ4 2026 :: On-prem' },
  { title: 'How it works', content: 'Discover :: read the landscape\nDecide :: pick the harness\nDeliver :: ship and measure' },
  { title: 'Where each option lands', content: '## Fast and cheap\nscripts\nglue code\n## Fast and good\nOSHAL\n## Slow and cheap\nmanual runbooks\n## Slow and good\nbespoke build' },
  { title: 'The engine room', content: 'Every bot node runs a different harness against a different provider\nThe controller never calls an LLM itself\nCost lands per call, per bot, in one ledger' },
  { title: 'Next steps', content: '#layout: closing\nPick a theme and generate a deck\nSend feedback to the Studio\nmaintainer@emeraldcoastsystemsgroup.com' },
];

/**
 * @description Render one showcase deck per theme into an output directory.
 * @param outDir - where to write the .pptx files.
 * @returns the written file paths.
 */
async function renderAll(outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const id of THEME_IDS) {
    const theme = resolveTheme(id);
    const buf = await renderPptx(`OSHAL — ${theme.name}`, SHOWCASE, {
      theme: id as DeckThemeId,
      subtitle: theme.blurb,
      byline: `${theme.mood} · ${theme.fonts.heading} / ${theme.fonts.body}`,
    });
    const file = path.join(outDir, `oshal-showcase-${id}.pptx`);
    fs.writeFileSync(file, buf);
    written.push(file);
    process.stdout.write(`  ${theme.name.padEnd(12)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB  ${file}\n`);
  }
  return written;
}

async function main(): Promise<void> {
  const outDir = process.argv[2] || path.join(process.cwd(), 'pptx-showcase');
  process.stdout.write(`Rendering ${THEME_IDS.length} showcase decks (${SHOWCASE.length + 1} slides each)…\n`);
  const files = await renderAll(outDir);
  process.stdout.write(`\nDone — ${files.length} decks in ${outDir}\nOpen one in PowerPoint and check View ▸ Slide Master for the six OSHAL layouts.\n`);
}

main().catch((err) => {
  process.stderr.write(`pptx-showcase failed: ${(err as Error).stack}\n`);
  process.exitCode = 1;
});
