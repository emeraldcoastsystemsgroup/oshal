/* WRITE-ONCE daily report generator.  Usage: node build-daily-report.js [recap-data.json]
   FORMULA: oshal cool-lettering intro -> the operator recap (face) -> the PowerPoint deck -> the operator "like & follow".
   - Generates a REAL graphical PowerPoint from the data (make-deck.py) and renders it to video via
     PowerPoint (CreateVideo) -> deck-raw.mp4 (the "powerpoint baked on").
   - The operator's lines + the deck walk-through are one neural voice (edge-tts); brand face/logo clips are fixed.
   - Crossfade-stitches with 0.25s flicker trims. Deterministic; no Veo / no clicks at build time. */
const { chromium } = require('playwright'); // (kept available; not required for the deck path)
const cp = require('child_process'), fs = require('fs'), path = require('path');
const HERE = __dirname, OUT = path.join(HERE, 'out'), BRAND = path.join(OUT, 'brand');
const FF = cp.execSync('python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"').toString().trim();
const VOICE = 'en-US-BrianNeural';
const ff = (a) => { const r = cp.spawnSync(FF, a, { encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status !== 0) console.log('  ffmpeg WARN:', (r.stderr || '').slice(-160)); return r; };
function dur(f) { const r = cp.spawnSync(FF, ['-i', f], { encoding: 'utf8' }); const m = (r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0; }
const valid = (f) => fs.existsSync(f) && dur(f) > 0.5;
const NV = 'scale=1920:1080,fps=30,setsar=1,format=yuv420p';
const NA = 'aformat=sample_rates=48000:channel_layouts=stereo';

(() => {
  const dataPath = process.argv[2] || path.join(OUT, 'recap-data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const stamp = (data.date || 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const out = path.join(OUT, `oshal-report-${stamp}.mp4`);
  for (const b of ['oshal.mp4', 'overview-visual.mp4', 'closing-visual.mp4', 'vo-overview.mp3', 'vo-closing.mp3'])
    if (!fs.existsSync(path.join(BRAND, b))) throw new Error('missing brand asset: ' + b);

  cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Name -like 'ffmpeg*' } | Stop-Process -Force -ErrorAction SilentlyContinue"]);

  // 1) REAL PowerPoint: data -> .pptx -> deck-raw.mp4 (PowerPoint CreateVideo)
  console.log('-> generating PowerPoint deck from data');
  let r = cp.spawnSync('python', [path.join(HERE, 'make-deck.py'), dataPath], { encoding: 'utf8' });
  if (!/DECK_OK/.test(r.stdout || '')) throw new Error('make-deck.py failed: ' + (r.stderr || r.stdout));
  const pptx = path.join(OUT, 'trading-recap.pptx'), deckRaw = path.join(OUT, 'deck-raw.mp4');
  const ps = `$pptx='${pptx}';$out='${deckRaw}';if(Test-Path $out){Remove-Item $out -Force};` +
    `$pp=New-Object -ComObject PowerPoint.Application;$pres=$pp.Presentations.Open($pptx,$true,$false,$false);` +
    `foreach($s in $pres.Slides){try{$s.SlideShowTransition.EntryEffect=3842;$s.SlideShowTransition.Duration=0.7}catch{}};` +
    `$pres.CreateVideo($out,$false,3,1080,30,85);$n=0;` +
    `while($true){$st=$pres.CreateVideoStatus;if($st -eq 3){break};if($st -eq 4){break};Start-Sleep -Milliseconds 700;$n++;if($n -gt 240){break}};` +
    `Start-Sleep -Seconds 1;$pres.Close();$pp.Quit()`;
  console.log('-> rendering deck via PowerPoint (CreateVideo)…');
  cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 240000 });
  if (!valid(deckRaw)) throw new Error('PowerPoint CreateVideo did not produce a valid deck-raw.mp4');
  const deckDur = dur(deckRaw);

  // 2) deck walk-through narration (one voice) from the data
  const voDeck = path.join(OUT, 'vo-deck.mp3');
  cp.spawnSync('python', ['-m', 'edge_tts', '--voice', VOICE, '--text', data.narration || 'Here is the trading desk recap.', '--write-media', voDeck], { encoding: 'utf8' });

  // 3) segments in FORMULA order: oshal -> the operator recap -> PowerPoint -> the operator closing
  const S = (n) => path.join(OUT, n);
  fs.copyFileSync(path.join(BRAND, 'oshal.mp4'), S('seg_oshal.mp4'));
  ff(['-y', '-i', path.join(BRAND, 'overview-visual.mp4'), '-i', path.join(BRAND, 'vo-overview.mp3'), '-filter_complex', `[0:v]${NV}[v];[1:a]apad,${NA}[a]`, '-map', '[v]', '-map', '[a]', '-t', '7.53', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', S('seg_overview.mp4')]);
  ff(['-y', '-i', deckRaw, '-i', voDeck, '-filter_complex', `[0:v]${NV}[v];[1:a]apad,${NA}[a]`, '-map', '[v]', '-map', '[a]', '-t', String(deckDur.toFixed(2)), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', S('seg_deck.mp4')]);
  ff(['-y', '-i', path.join(BRAND, 'closing-visual.mp4'), '-i', path.join(BRAND, 'vo-closing.mp3'), '-filter_complex', `[0:v]${NV}[v];[1:a]apad,${NA}[a]`, '-map', '[v]', '-map', '[a]', '-t', '7.53', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', S('seg_closing.mp4')]);

  const order = ['seg_oshal.mp4', 'seg_overview.mp4', 'seg_deck.mp4', 'seg_closing.mp4'];
  for (const s of order) if (!valid(S(s))) throw new Error('segment invalid: ' + s);

  // 4) crossfade chain
  const D = order.map((s) => dur(S(s))); const XF = 0.4;
  let fc = '', vp = '0:v', ap = '0:a', acc = D[0];
  for (let i = 1; i < order.length; i++) {
    const off = (acc - XF).toFixed(2);
    const vo = i === order.length - 1 ? 'outv' : `v${i}`, ao = i === order.length - 1 ? 'outa' : `a${i}`;
    fc += `[${vp}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${off}[${vo}];[${ap}][${i}:a]acrossfade=d=${XF}[${ao}];`;
    vp = vo; ap = ao; acc += D[i] - XF;
  }
  fs.writeFileSync(S('filt-daily.txt'), fc.replace(/;$/, ''));
  ff(['-y', ...order.flatMap((s) => ['-i', S(s)]), '-filter_complex_script', S('filt-daily.txt'), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
  if (!valid(out)) throw new Error('final report invalid');
  console.log('REPORT_OK', out, dur(out).toFixed(1) + 's');
})();
