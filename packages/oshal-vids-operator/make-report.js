/* Reusable daily OSHAL trading-report pipeline.
   Usage:  node make-report.js [data.json] [intro.mp4] [out.mp4]
   - data.json  : the day's numbers + narration (default out/recap-data.json)
   - intro.mp4  : brand-constant electric-oshal intro w/ Tyra VO + serious theme (default out/intro.mp4)
   - out.mp4    : final report (default out/oshal-report-<date>.mp4)
   Steps: render data-driven dashboard -> record -> SAPI narration -> ffmpeg stitch intro+recap. */
const { chromium } = require('playwright');
const fs = require('fs'), cp = require('child_process'), path = require('path');
const HERE = __dirname, OUTDIR = path.join(HERE, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, a) => cp.spawnSync(c, a, { encoding: 'utf8' });

(async () => {
  const dataPath = process.argv[2] || path.join(OUTDIR, 'recap-data.json');
  const intro = process.argv[3] || path.join(OUTDIR, 'intro.mp4');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const stamp = (data.date || 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const out = process.argv[4] || path.join(OUTDIR, `oshal-report-${stamp}.mp4`);
  if (!fs.existsSync(intro)) throw new Error('missing intro.mp4 (brand-constant intro) at ' + intro);
  const ff = cp.execSync('python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"').toString().trim();

  // 1) record the data-driven dashboard
  const recDir = path.join(OUTDIR, 'rec');
  fs.rmSync(recDir, { recursive: true, force: true }); fs.mkdirSync(recDir, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: recDir, size: { width: 1920, height: 1080 } } });
  await ctx.addInitScript((d) => { window.RECAP_DATA = d; }, data);
  const p = await ctx.newPage();
  await p.goto('file:///' + path.join(OUTDIR, 'recap-dashboard.html').replace(/\\/g, '/'));
  await sleep(data.durationMs || 31000);
  await ctx.close(); await b.close();
  const webm = path.join(recDir, fs.readdirSync(recDir).find((f) => f.endsWith('.webm')));
  console.log('recorded', webm);

  // 2) narration (Windows SAPI, local — no content filter)
  const voPath = path.join(OUTDIR, 'recap-vo.wav'); let haveVO = false;
  if (data.narration) {
    const txt = path.join(OUTDIR, 'recap-narration.txt'); fs.writeFileSync(txt, data.narration, 'utf8');
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$v=$s.GetInstalledVoices()|%{$_.VoiceInfo.Name}|?{$_ -match 'Zira'}|select -First 1; if($v){$s.SelectVoice($v)}; ` +
      `$s.Rate=2; $t=Get-Content -Raw '${txt}'; $s.SetOutputToWaveFile('${voPath}'); $s.Speak($t); $s.Dispose()`;
    const r = sh('powershell.exe', ['-NoProfile', '-Command', ps]);
    haveVO = r.status === 0 && fs.existsSync(voPath); if (!haveVO) console.log('SAPI warn:', r.stderr || r.status);
  }

  // 3) recap.mp4 (dashboard video + narration, or silent)
  const recap = path.join(OUTDIR, 'recap.mp4');
  const audioIn = haveVO
    ? ['-i', voPath, '-filter_complex', '[1:a]apad[a]', '-map', '0:v', '-map', '[a]']
    : ['-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000', '-map', '0:v', '-map', '1:a'];
  sh(ff, ['-y', '-i', webm, ...audioIn, '-r', '30', '-s', '1920x1080', '-c:v', 'libx264', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', recap]);

  // 4) stitch intro + recap
  const fc = '[0:v]scale=1920:1080,fps=30,setsar=1,format=yuv420p[v0];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];' +
    '[1:v]scale=1920:1080,fps=30,setsar=1,format=yuv420p[v1];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];' +
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]';
  sh(ff, ['-y', '-i', intro, '-i', recap, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);

  console.log('REPORT:', out, fs.existsSync(out) ? fs.statSync(out).size + ' bytes' : 'MISSING');
  process.exit(0);
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
