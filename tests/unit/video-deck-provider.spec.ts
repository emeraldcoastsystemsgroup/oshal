import { describe, expect, it } from 'vitest';
import { slideHtml, DeckToVideoProvider } from '../../src/features/video-generation';

describe('deck-to-video slide HTML', () => {
  it('renders title + one <li> per bullet at the target size', () => {
    const html = slideHtml({ title: 'Hello', content: 'one\ntwo\nthree' }, 1080, 1920);
    expect(html).toContain('<h1>Hello</h1>');
    expect((html.match(/<li>/g) || []).length).toBe(3);
    expect(html).toContain('width:1080px');
    expect(html).toContain('height:1920px');
  });

  it('escapes HTML in user content', () => {
    const html = slideHtml({ title: '<script>x', content: 'a & b' }, 1920, 1080);
    expect(html).toContain('&lt;script&gt;x');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<script>x');
  });

  it('omits the heading when no title', () => {
    expect(slideHtml({ content: 'just a bullet' }, 1080, 1080)).not.toContain('<h1>');
  });

  it('is a free provider for the deck-to-video job type', () => {
    const p = new DeckToVideoProvider();
    expect(p.costClass).toBe('free');
    expect(p.estimateCost()).toBe(0);
    expect(p.jobTypes).toContain('deck-to-video');
  });
});
