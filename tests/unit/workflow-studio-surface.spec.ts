import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow studio surface', () => {
  const html = readFileSync(resolve(process.cwd(), 'src/pages/workflow-studio/index.html'), 'utf8');
  const css = readFileSync(resolve(process.cwd(), 'src/pages/workflow-studio/workflow-studio.css'), 'utf8');
  const chatJs = readFileSync(resolve(process.cwd(), 'src/pages/workflow-studio/workflow-studio-chat.js'), 'utf8');

  it('keeps talk-to-build as a visible first-screen workflow generator', () => {
    expect(html).toContain('id="wfChatInput"');
    expect(html).toContain('id="wfChatSend"');
    expect(html).toContain('Generate');
    expect(html.match(/data-wf-prompt=/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(chatJs).toContain("querySelectorAll('[data-wf-prompt]')");
  });

  it('does not expose the old duplicate left-rail chat panel', () => {
    expect(html).toContain('legacy-chat-panel');
    expect(css).toContain('.legacy-chat-panel');
    expect(css).toContain('display: none');
  });
});
