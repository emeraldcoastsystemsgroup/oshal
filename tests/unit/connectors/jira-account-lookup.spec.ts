import { describe, expect, it } from 'vitest';
import { normalizeJiraSiteUrl } from '../../../src/app/routes/connector-account-lookup';

describe('jira account lookup', () => {
  it('normalizes a Jira REST API root to the site root', () => {
    expect(normalizeJiraSiteUrl('https://example.atlassian.net/rest/api/3')).toBe('https://example.atlassian.net');
    expect(normalizeJiraSiteUrl('https://example.atlassian.net/rest/api/3/')).toBe('https://example.atlassian.net');
  });

  it('leaves a Jira site root unchanged', () => {
    expect(normalizeJiraSiteUrl(' https://example.atlassian.net/ ')).toBe('https://example.atlassian.net');
  });
});
