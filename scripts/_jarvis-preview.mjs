/**
 * Design preview harness for the Jarvis surface (src/api/jarvis.html).
 * Renders the page standalone with MOCKED swarm data (overview/work-items/tickets) so the node
 * cloud, conversations list, and layout appear, then screenshots it at a desktop viewport.
 *
 *   node scripts/_jarvis-preview.mjs [width] [height] [outfile]
 *
 * Throwaway dev tool (underscore-prefixed). Lets the layout be tuned visually instead of blind.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = pathToFileURL(path.resolve('src/api/jarvis.html')).href;
const W = Number(process.argv[2] || 1820);
const H = Number(process.argv[3] || 780);
const out = process.argv[4] || 'scripts/_jarvis-preview.png';

// ~20 bots spread across the functional groups (names chosen to hit GROUPS keywords).
const bots = [
  ['a0000000-0000-0000-0000-000000000050', 'oshal-assistant', 'assistant'],
  ['b1', 'communications-bot', 'email calendar'],
  ['b2', 'email-bot', 'inbox triage'],
  ['b3', 'social-writer', 'social posts brand'],
  ['b4', 'deck-builder', 'presentations slides'],
  ['b5', 'home-bot', 'smartthings devices scenes'],
  ['b6', 'cloud-ops-bot', 'gcp devops infra'],
  ['b7', 'career-advisor', 'jobs resume recruit'],
  ['b8', 'finance-analyst', 'portfolio plaid finance'],
  ['b9', 'trading-bot', 'stock market trade'],
  ['b10', 'class-tutor', 'education tutor'],
  ['b11', 'quiz-master', 'quiz study'],
  ['b12', 'lecture-scribe', 'lecture'],
  ['b13', 'security-analyst', 'security threat audit'],
  ['b14', 'incident-response', 'incident rca'],
  ['b15', 'code-developer', 'code build'],
  ['b16', 'system-architect', 'architect'],
  ['b17', 'test-engineer', 'test review'],
  ['b18', 'task-manager', 'project manager'],
  ['b19', 'queue-bot', 'queue ops'],
].map(([agentId, name, role], i) => ({ agentId, name, role, capabilities: [role], online: i % 6 !== 0 }));

const overview = { bots, comms: { signals: [] }, activity: { tickets: [], openCount: 0 }, calendar: { events: [] } };
const workItems = { workItems: [
  { assignedAgentId: 'b6', title: 'Audit GCP IAM roles', status: 'in_progress' },
  { assignedAgentId: 'b15', title: 'Build the export module', status: 'in_progress' },
  { assignedAgentId: 'b13', title: 'Scan for exposed secrets', status: 'in_progress' },
] };
const tickets = { tickets: [
  { ticketId: 't1', title: "Now I'm not getting a link there", ticketType: 'chat', status: 'in_process', metadata: { queueId: 'chat', targetBot: 'jarvis', taskId: 'jx1' }, updatedAt: '2026-06-20T10:00:00Z' },
  { ticketId: 't2', title: 'How do I access those files, Jarvis?', ticketType: 'chat', status: 'in_process', metadata: { queueId: 'chat', targetBot: 'jarvis', taskId: 'jx2' }, updatedAt: '2026-06-20T09:00:00Z' },
  { ticketId: 't3', title: 'build a presentation two slides for me', ticketType: 'chat', status: 'in_process', metadata: { queueId: 'chat', targetBot: 'jarvis', taskId: 'jx3' }, updatedAt: '2026-06-20T08:00:00Z' },
  { ticketId: 't4', title: "what's the weather in Orlando, Florida", ticketType: 'chat', status: 'in_process', metadata: { queueId: 'chat', targetBot: 'jarvis', taskId: 'jx4' }, updatedAt: '2026-06-20T07:00:00Z' },
  { ticketId: 't5', title: "Hey, I'm just checking in, how are you", ticketType: 'chat', status: 'in_process', metadata: { queueId: 'chat', targetBot: 'jarvis', taskId: 'jx5' }, updatedAt: '2026-06-20T06:00:00Z' },
] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(({ overview, workItems, tickets }) => {
  const json = (o) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o), text: () => Promise.resolve(JSON.stringify(o)) });
  window.fetch = (u) => {
    const s = String(u);
    if (s.includes('/api/jarvis/overview')) return json(overview);
    if (s.includes('/api/swarm/work-items')) return json(workItems);
    if (s.includes('/api/tickets')) return json(tickets);
    if (s.includes('/api/jarvis/ask/jobs')) return json({ jobs: [] });
    if (s.includes('/api/jarvis/ask')) return json({ jobId: 'x', sessionId: 's', chatTicketId: 'c' });
    return json({});
  };
}, { overview, workItems, tickets });
await page.goto(file, { waitUntil: 'load' });
await page.waitForTimeout(2400);   // let the cloud ease into its cluster slots
await page.screenshot({ path: out });
const m = await page.evaluate(() => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--cloud-top-px').trim();
  const orb = document.getElementById('orb')?.getBoundingClientRect();
  const conv = document.getElementById('threadsSect')?.getBoundingClientRect();
  const tap = document.getElementById('mic')?.getBoundingClientRect();
  // topmost lit node ≈ smallest target y among placed nodes (exposed for measurement)
  const top = (window).__cloudTopY;
  return {
    cloudTopVar: v,
    orbCenterY: orb ? Math.round(orb.top + orb.height / 2) : null,
    orbTopY: orb ? Math.round(orb.top) : null,
    conversationsTopY: conv ? Math.round(conv.top) : null,
    tapTalkY: tap ? Math.round(tap.top) : null,
    cloudTopClusterY: top != null ? Math.round(top) : null,
  };
});
await browser.close();
console.log('wrote', out, `${W}x${H}`);
console.log('MEASURE', JSON.stringify(m));
