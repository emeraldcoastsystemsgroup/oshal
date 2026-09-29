/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the real Jarvis browser surface consumes the shipped shared response-renderer bundle for a bounded oshal:doc block while keeping typed text escaped and action-free.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The page loads on the configured Playwright origin (jarvisPageUrl) and reaches the composer through openTyper, the shared Options -> Type path that also asserts the control closes Options and focuses the input.
 */

import { expect, test } from '@playwright/test';
import {
  fulfillJarvisWithResponseRenderer,
  installSpeechStub,
  jarvisPageUrl,
  json,
  openTyper,
} from './helpers/jarvis-rich-response-fixtures';

test('Jarvis renders a bounded document through the shared response renderer', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: [
          'The shared viewer is active.',
          '```oshal:doc',
          JSON.stringify({
            title: 'Futures research note',
            sections: [{ heading: 'Next review', paragraphs: ['Keep the operator controls visible.'] }],
          }),
          '```',
        ].join('\n\n'),
      });
    }
    return fulfillJarvisWithResponseRenderer(route);
  });

  await page.goto(jarvisPageUrl());
  await openTyper(page);
  await page.locator('#typein').fill('Show the document note.');
  await page.locator('#typer button[type="submit"]').click();

  const answer = page.locator('#convo .msg.bot').last();
  await expect(answer.locator('.rr-doc')).toHaveCount(1);
  await expect(answer.locator('.rr-doc-title')).toHaveText('Futures research note');
  await expect(answer.locator('.rr-doc-section h4')).toHaveText('Next review');
  await expect(answer).toContainText('Keep the operator controls visible.');
  await expect(answer.locator('a,button,input,form,script,iframe')).toHaveCount(0);
});
