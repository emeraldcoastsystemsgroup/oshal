/**
 * Full render smoke (run INSIDE the oshal-api container) — exercises the whole Video
 * Studio assembly: real Veo clips per scene -> gemini-tts narration -> burned captions ->
 * ffmpeg stitch -> a single .mp4 written to /app/output. Uses the compiled feature slice
 * at /app/dist so it runs against the exact code the app uses.
 *
 *   docker exec oshal-local-api node \
 *     /run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/scripts/video-render-smoke.cjs
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial in-container full-pipeline render smoke for the Video Studio.
 */

const fs = require('node:fs');
const { renderVideo } = require('/app/dist/features/video-generation');

const storyboard = {
  title: 'muscle-cat-campfire-cake',
  scenes: [
    {
      prompt: 'A futuristic muscle-cat cracks eggs into a metal bowl beside a campfire at night, cinematic close-up, sparks glowing',
      durationSec: 4,
      narration: 'Step one — our hero cat starts the batter.',
      caption: 'Step 1: The Batter',
    },
    {
      prompt: 'The muscle-cat pours cake batter into a cast-iron pan set over a roaring campfire, embers flying, dramatic lighting',
      durationSec: 4,
      narration: 'Then it all goes straight into the fire.',
      caption: 'Step 2: Into the Fire',
    },
  ],
};

const shape = {
  style: 'futuristic live-action, cinematic',
  tone: 'playful',
  aspectRatio: '9:16',
  targetSeconds: 8,
  captions: true,
  voice: 'default',
  music: 'none',
};

(async () => {
  console.log('[render-smoke] starting full render (2 real Veo clips — several minutes)…');
  const t0 = Date.now();
  const result = await renderVideo(storyboard, shape);
  const out = `/app/output/video-render-smoke-${Date.now()}.mp4`;
  fs.writeFileSync(out, result.mp4);
  console.log(`[render-smoke] ✅ wrote ${out} — ${result.durationSec}s, ${result.mp4.length} bytes, est $${result.estimatedCostUsd}, ${(Date.now() - t0) / 1000}s elapsed`);
})().catch((e) => { console.error('[render-smoke] ❌', e && e.stack || e); process.exit(1); });
