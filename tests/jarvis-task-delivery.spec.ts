/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the actual Jarvis page in Chromium with thousands of workflow rows, bounded receipts, rejected writes and overlapping shelf reads.
 */
import { expect, test, type Page } from '@playwright/test';
import { fulfillJarvis, installSpeechStub, jarvisPageUrl, json } from './helpers/jarvis-rich-response-fixtures';

type Task = { id: string; title: string; status: string; result: string | null; delivered: boolean };
const reply = (id: string): Task => ({ id, title: `Saved reply ${id}`, status: 'done', result: `Actual answer ${id}`, delivered: false });

async function ready(page: Page): Promise<void> {
  await installSpeechStub(page);
  await page.goto(jarvisPageUrl());
  await page.waitForFunction('shelfPrimed && !shelfPollActive');
}

async function repoll(page: Page): Promise<void> {
  await page.waitForFunction('mode !== "speaking" && mode !== "listening"');
  await page.evaluate('pollShelf()');
}

test('4,000 workflow records stay on the shelf without delivery; one saved answer announces once', async ({ page }) => {
  const tasks: Task[] = Array.from({ length: 4000 }, (_, i) => ({ ...reply(`workflow-${i}`), result: null, status: i % 2 ? 'error' : 'done' }));
  const receipts: string[] = [];
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jarvis/tasks') return json(route, { tasks });
    if (pathname.endsWith('/delivered')) {
      receipts.push(pathname);
      tasks[tasks.length - 1].delivered = true;
      return json(route, { ok: true });
    }
    return fulfillJarvis(route);
  });
  await ready(page);
  expect(await page.evaluate('lastShelfJobs.length')).toBe(4000);
  expect(receipts).toEqual([]);
  const before = await page.locator('#convo').textContent();
  await repoll(page);
  expect(await page.locator('#convo').textContent()).toBe(before);
  tasks.push(reply('fresh-answer'));
  await repoll(page);
  await expect.poll(() => receipts.length).toBe(1);
  expect(receipts).toEqual(['/api/jarvis/tasks/fresh-answer/delivered']);
  await expect(page.locator('#convo')).toContainText('Saved reply fresh-answer');
  const announced = await page.locator('#convo').textContent();
  await repoll(page);
  expect(await page.locator('#convo').textContent()).toBe(announced);
  expect(receipts).toHaveLength(1);
});

test('many actual replies use at most three concurrent receipts and deduplicate pending IDs', async ({ page }) => {
  const tasks = Array.from({ length: 24 }, (_, i) => reply(`answer-${i}`));
  const receipts: string[] = [];
  let active = 0, maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jarvis/tasks') return json(route, { tasks });
    if (!pathname.endsWith('/delivered')) return fulfillJarvis(route);
    receipts.push(pathname);
    maximum = Math.max(maximum, ++active);
    await gate;
    await json(route, { ok: true });
    active -= 1;
  });
  await ready(page);
  await expect.poll(() => active).toBe(3);
  await page.evaluate('Object.keys(durableTaskResults).forEach(markDelivered)');
  expect(receipts).toHaveLength(3);
  expect(await page.evaluate('Object.values(durableTaskResults).some(task => task.delivered)')).toBe(false);
  release();
  await expect.poll(() => receipts.length).toBe(24);
  await expect.poll(() => page.evaluate('Object.values(durableTaskResults).every(task => task.delivered)')).toBe(true);
  expect(maximum).toBe(3);
  expect(new Set(receipts).size).toBe(24);
});

test('HTTP and network failures remain undelivered and retry quietly on a later poll', async ({ page }) => {
  const tasks = [reply('http-failure'), reply('network-failure')];
  const attempts = new Map<string, number>();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jarvis/tasks') return json(route, { tasks });
    if (!pathname.endsWith('/delivered')) return fulfillJarvis(route);
    const count = (attempts.get(pathname) || 0) + 1;
    attempts.set(pathname, count);
    if (count === 1 && pathname.includes('network-failure')) return route.abort('failed');
    if (count === 1) return route.fulfill({ status: 503, body: 'store unavailable' });
    return json(route, { ok: true });
  });
  await ready(page);
  await expect.poll(() => attempts.size).toBe(2);
  await page.waitForFunction('mode !== "speaking"');
  expect(await page.evaluate('Object.values(durableTaskResults).some(task => task.delivered)')).toBe(false);
  const announced = await page.locator('#convo').textContent();
  await repoll(page);
  await expect.poll(() => [...attempts.values()]).toEqual([2, 2]);
  await expect.poll(() => page.evaluate('Object.values(durableTaskResults).every(task => task.delivered)')).toBe(true);
  expect(await page.locator('#convo').textContent()).toBe(announced);
  expect(errors).toEqual([]);
});

test('concurrent shelf refreshes share one active read', async ({ page }) => {
  let reads = 0, hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/jarvis/tasks') return fulfillJarvis(route);
    reads += 1;
    if (hold) await gate;
    return json(route, { tasks: [] });
  });
  await ready(page);
  reads = 0;
  hold = true;
  await page.evaluate('void Promise.all([pollShelf(), pollShelf(), pollShelf()])');
  await expect.poll(() => reads).toBe(1);
  release();
  await page.waitForFunction('!shelfPollActive');
  expect(reads).toBe(1);
});
