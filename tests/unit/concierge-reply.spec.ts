import { describe, expect, it } from 'vitest';
import { cleanConciergeReply } from '../../src/app/routes/concierge-reply';

describe('cleanConciergeReply', () => {
  it('extracts the human say field from a valid JSON envelope', () => {
    expect(cleanConciergeReply('{"say":"I found sushi nearby.","show":["sushi-1"],"add":[]}')).toBe('I found sushi nearby.');
  });

  it('extracts the human say field from a fenced JSON envelope', () => {
    expect(cleanConciergeReply('```json\n{"say":"Comfort is selected.","pickup":"my location"}\n```')).toBe('Comfort is selected.');
  });

  it('hides broken envelope-shaped output instead of showing raw JSON in chat', () => {
    expect(cleanConciergeReply('{"say":"Almost there","show":[', 'Try the search and browse controls.')).toBe('Try the search and browse controls.');
  });

  it('hides non-product debug objects without a say field', () => {
    expect(cleanConciergeReply('{"gotIt":true,"tool":"checkout"}', 'I could not turn that into an app action yet.')).toBe('I could not turn that into an app action yet.');
  });

  it('keeps normal conversational prose', () => {
    expect(cleanConciergeReply('Sure, I can help find dinner for two.')).toBe('Sure, I can help find dinner for two.');
  });
});
