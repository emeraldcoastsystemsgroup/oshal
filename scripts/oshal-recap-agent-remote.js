#!/usr/bin/env node
/*
 * trade_recap_pipeline tool (in-container CLI) — the AGENT-DRIVEN recap.
 *
 * Instead of dispatching a rigid build (oshal-recap-render-remote.js -> make-trade-report.cmd,
 * which "voiced over old clips"), this hands a GOAL + the day's data to the video PC's LOCAL
 * AGENT (the node's claude/codex CLI) and lets it drive Google Vids itself per the operator
 * SOP (packages/oshal-vids-operator/RECAP-SOP.md): fresh clips, verified render badges,
 * assemble, archive, publish to both sites, verify, report. This is the "specialized bot that
 * monitors + is connected to the swarm + takes a goal and just does it" the operator asked for.
 *
 * Mechanics (reuses the proven detach-and-poll pattern):
 *   1) pick an online node advertising shell.exec (the render/video PC)
 *   2) write the goal prompt to the shared out dir (recap-agent.prompt.txt)
 *   3) Start-Process recap-agent-node.ps1 DETACHED on the node (the node's local agent runs
 *      with no 120s cap and writes recap-agent.done / .err)
 *   4) poll the sentinel until done/err (progress -> stderr; final JSON -> stdout)
 *
 *   Usage:  node oshal-recap-agent-remote.js [{input}]
 *   input (all optional): { node?, date?, publish?:true, dryRun?:false, cli?:"claude|codex" }
 *   Prints JSON: the agent's own summary (recap-agent.done), or { ok:false, error }.
 */
'use strict';
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH = { [process.env.REMOTE_CLIENT_AUTH_HEADER || 'x-remote-client-key']: process.env.REMOTE_CLIENT_SHARED_SECRET || '' };
const BASE = `http://127.0.0.1:${process.env.PORT || 5000}`;
const REPO_WIN = process.env.OSHAL_RENDER_REPO || 'C:\\Projects\\open-shal-swarm-harness-agent-llm';
const PS1 = `${REPO_WIN}\\scripts\\recap-agent-node.ps1`;
const OUT_WIN = `${REPO_WIN}\\packages\\oshal-vids-operator\\out`;
const OUT_CONTAINER = '/run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/packages/oshal-vids-operator/out';

function parseInput(raw) { if (!raw) return {}; try { return JSON.parse(raw); } catch { return {}; } }
function log(...a) { console.error('[recap-agent]', ...a); }

async function listClients() {
  const r = await fetch(`${BASE}/api/remote-clients`, { headers: AUTH });
  if (!r.ok) throw new Error(`list remote-clients HTTP ${r.status}`);
  return (await r.json()).clients || [];
}

function pickNode(cs, input) {
  const online = cs.filter((c) => c.status === 'online' && (c.capabilities || []).includes('shell.exec'));
  const want = process.env.OSHAL_RENDER_NODE_ID || input.node;
  if (want) { const n = online.find((c) => c.clientId === want || c.name === want); if (n) return n; }
  return online.find((c) => /parentpc|render|vids/i.test(c.name || '')) || online[0] || null;
}

async function execNode(node, command, maxPolls) {
  const taskId = `recap-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const env = {
    taskId, correlationId: taskId, fromAgentId: 'recap-agent',
    toAgentId: node.agentId || node.clientId, intent: 'mcp.call-tool',
    input: { name: 'shell.exec', arguments: { command } }, createdAt: new Date().toISOString(),
  };
  const e = await fetch(`${BASE}/api/remote-clients/${node.clientId}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(env),
  });
  if (e.status !== 201) throw new Error(`enqueue HTTP ${e.status} ${await e.text()}`);
  for (let i = 0; i < (maxPolls || 16); i++) {
    await sleep(2500);
    const r = await fetch(`${BASE}/api/remote-clients/${node.clientId}/tasks/${taskId}/result`, { headers: AUTH });
    if (r.ok) {
      const j = await r.json();
      const o = (j.output && typeof j.output === 'object') ? j.output : {};
      return { status: j.status, stdout: String(o.stdout || ''), stderr: String(o.stderr || ''), exitCode: o.exitCode, error: j.error };
    }
  }
  throw new Error('node exec timed out (no result)');
}

function buildPrompt(date, publish, cliHint) {
  const O = OUT_WIN;
  return [
    `You are the OSHAL daily trade-recap BUILD operator on the video PC. Produce the finished recap`,
    `VIDEO for ${date} and STOP. Do NOT publish (the host archives + you-wrangle publishing). Do NOT`,
    `ask questions. Follow this exactly.`,
    ``,
    `INPUTS already staged in ${O} (the host prepared them):`,
    `  deck-data.json   — the day's REAL numbers: results.pl, results.pct, results.equity,`,
    `                     results.leaders, ytd.retPct, date. Use these EXACT figures; never invent.`,
    `  deck.pptx        — the 9-slide deck (already built from deck-data.json).`,
    `  the operator-head.png — the operator's headshot.  brand\\oshal.mp4 — the OSHAL sting.`,
    `A debug Chrome signed into Google Vids + Drive is on http://localhost:9222 (do NOT relaunch or`,
    `sign in). Driver: node ${REPO_WIN}\\scripts\\vids-drive.js (shot/click/settext/setfile) — take a`,
    `shot, LOOK at the PNG (you have vision), act, re-shot to verify.`,
    ``,
    `THE HARD RULE (the #1 past bug): every the operator clip is a BRAND-NEW blank video, full-cycle:`,
    `  new tab -> https://docs.google.com/videos/u/0/ -> "Blank video" -> Veo -> switch mode to`,
    `  "Animate an image" FIRST -> set the headshot via the HIDDEN file input (setInputFiles on`,
    `  input[type=file]; NEVER the native Open dialog, it freezes Chrome) -> type the prompt ->`,
    `  Generate -> WAIT for a real duration badge -> Insert -> File>Download -> save to the target`,
    `  file -> VERIFY on disk -> close ONLY that tab.`,
    `NEVER reopen an existing video to add a clip (that strings them into ONE sequence — the bug).`,
    `Keep ONE keeper tab (about:blank) open the whole run; never close the last tab. If Veo shows`,
    `"against our terms", reword neutrally ("the person in the photo says: ...") and retry (max 3/clip).`,
    ``,
    `THREE OPERATOR CLIPS (numbers from deck-data.json; ~20 words each; frame the day honestly by the`,
    `sign of results.pct — small negative = "roughly flat, down about $X"):`,
    `  ${O}\\the operator-intro.mp4    "I'm the operator, a digital representative of OSHAL Autonomous Trading. Here's your transparent trading report for <Month Day>."`,
    `  ${O}\\the operator-overview.mp4 "The book finished roughly <flat/up/down> today, <up|down> about $<abs day P/L>, and we're <up|down> <since-inception>% since inception. Let's dig into the details."   (MUST end with "Let's dig into the details" — the deck handoff.)`,
    `  ${O}\\the operator-close.mp4    "That's your recap. Winners were <leaders, spoken>. Thanks for watching, and please like and follow."`,
    `  Prompt wrapper each: The man in the headshot looks directly at the camera and speaks warmly:`,
    `  "<line>". Natural lighting, subtle motion, no on-screen text, no logos. use Nyx / Clear, lower middle pitch voice`,
    ``,
    `NARRATED DECK (required — Google's own voiceover, NOT silent/music):`,
    `  1. Upload ${O}\\deck.pptx to Google Drive (drive.google.com -> New -> File upload; prefer the`,
    `     hidden input[type=file]; if a native Open dialog appears, type the full path + Enter). Wait.`,
    `  2. In Google Vids, NEW video -> "Convert slides" / import that deck (open it as Google Slides`,
    `     first if the picker needs it). Let Vids generate the video WITH an AI Narrator voiceover.`,
    `  3. When done (duration badge), File>Download -> save ${O}\\deck-narrated.mp4. Verify > 1 MB WITH audio.`,
    ``,
    `ASSEMBLE (do NOT use the old _assemble.js — it is broken):`,
    `  Run:  node ${REPO_WIN}\\scripts\\assemble-recap.js`,
    `  It stitches sting + the operator-intro + the operator-overview + deck-narrated + the operator-close ->`,
    `  ${O}\\trade-recap.mp4. Watch for a non-zero ffmpeg exit.`,
    ``,
    `DO NOT PUBLISH. When ${O}\\trade-recap.mp4 exists and plays (duration > sum of scene minimums),`,
    `write your JSON summary to ${O}\\recap-agent.done :`,
    `  { "ok": true, "date": "${date}", "video": "${O}\\\\trade-recap.mp4", "deck": "${O}\\\\deck.pptx", "clips": ["the operator-intro","the operator-overview","deck-narrated","the operator-close"] }`,
    `ON FAILURE write the real error + failed step to ${O}\\recap-agent.err and stop. Never fabricate`,
    `a file; never claim a clip without a duration badge. Append progress to ${O}\\recap-agent.log.`,
  ].join('\n');
}

(async () => {
  const input = parseInput(process.argv[2]);
  // Quote-proof dry-run: JSON {dryRun:true}, a bare "dryrun" arg, OR env OSHAL_RECAP_DRYRUN=1
  // (PowerShell -> docker exec mangles embedded JSON quotes, so env is the reliable channel).
  const argWord = String(process.argv[2] || '').trim().toLowerCase();
  const envDry = /^(1|true|yes|on)$/i.test(process.env.OSHAL_RECAP_DRYRUN || '');
  const dryRun = input.dryRun === true || argWord === 'dryrun' || envDry;
  // Date must be the ET trading day, NOT the UTC date — at ~20:00-23:59 ET the UTC date is
  // already tomorrow, which made the agent (correctly) refuse to recap a session that hasn't
  // closed. Default to the ET calendar date; the agent still confirms it via Alpaca /v2/clock.
  const etDate = () => { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch { return new Date().toISOString().slice(0, 10); } };
  const date = input.date || process.env.OSHAL_RECAP_DATE || etDate();
  const publish = input.publish !== false && !dryRun;
  // print-prompt: emit the corrected build GOAL and exit (the host orchestrator stages this to the node).
  if (argWord === 'print-prompt' || /^(1|true)$/i.test(process.env.OSHAL_RECAP_PRINT || '')) {
    process.stdout.write(buildPrompt(date, false, input.cli)); return;
  }
  try {
    const node = pickNode(await listClients(), input);
    if (!node) throw new Error('no online node advertising shell.exec (start the OSHAL client on the video PC with system control ON)');
    log(`node: ${node.name || node.clientId} · date: ${date} · publish: ${publish}`);

    // 1) Write the goal prompt to the shared out dir (node reads it).
    try { fs.mkdirSync(OUT_CONTAINER, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(`${OUT_CONTAINER}/recap-agent.prompt.txt`, buildPrompt(date, publish, input.cli), 'utf8');
    // Clear a stale sentinel from a prior run so our poll can't read it.
    for (const f of ['recap-agent.done', 'recap-agent.err']) { try { fs.unlinkSync(`${OUT_CONTAINER}/${f}`); } catch { /* absent */ } }

    // 2) Launch the detached agent on the node.
    const envPrefix = input.cli ? `$env:RECAP_AGENT_CLI='${input.cli}'; ` : '';
    const startCmd = `${envPrefix}if(Test-Path '${PS1}'){ Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${PS1}'; 'STARTED' } else { 'NO_PS1' }`;
    const s = await execNode(node, startCmd, 24); // ~60s: the node can be slow to return the launch confirmation under load
    if (/NO_PS1/.test(s.stdout)) throw new Error(`recap-agent launcher missing on node: ${PS1}`);
    if (!/STARTED/.test(s.stdout)) throw new Error(`could not start recap agent on node: ${s.stdout || s.stderr || s.error}`);
    log('agent launched detached; polling for completion (this takes ~15-30 min)…');

    // 3) Poll the sentinel (progress -> stderr). ~36 min ceiling at 20s.
    const pollCmd = `$o='${OUT_WIN}'; if(Test-Path "$o\\recap-agent.done"){ Get-Content "$o\\recap-agent.done" -Raw } elseif(Test-Path "$o\\recap-agent.err"){ 'ERR:'+(Get-Content "$o\\recap-agent.err" -Raw) } else { 'RUNNING:'+(((Get-Content "$o\\recap-agent.log" -Tail 1 -ErrorAction SilentlyContinue)) -join '') }`;
    let last = '';
    for (let i = 0; i < 108; i++) {
      await sleep(20000);
      let p;
      try { p = await execNode(node, pollCmd, 8); } catch (e) { log(`poll ${i} transient: ${e.message}`); continue; }
      const out = (p.stdout || '').trim();
      if (out.startsWith('{')) {
        try { const j = JSON.parse(out); j.node = node.name; process.stdout.write(JSON.stringify(j)); return; }
        catch { process.stdout.write(out); return; }
      }
      if (out.startsWith('ERR:')) throw new Error(`recap agent failed: ${out.slice(4, 800)}`);
      if (out.startsWith('RUNNING:')) { const line = out.slice(8); if (line && line !== last) { log(`… ${line}`); last = line; } }
    }
    throw new Error('recap agent did not complete within ~36 min (no sentinel). It may still be running on the node; check recap-agent.log.');
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    process.exitCode = 1;
  }
})();
