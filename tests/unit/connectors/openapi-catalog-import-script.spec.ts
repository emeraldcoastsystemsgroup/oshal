import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenAPI catalog bulk importer script', () => {
  it('keeps the ADR-067 bulk import lane commandable and report-driven', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts/connectors/import-openapi-catalog.ts'),
      'utf8',
    );

    expect(source).toContain('https://api.apis.guru/v2/list.json');
    expect(source).toContain('limit: 1000');
    expect(source).toContain('concurrency: 8');
    expect(source).toContain('targetImports');
    expect(source).toContain('iconSlugFromProvider');
    expect(source).toContain('report.skipped.push');
    expect(source).toContain("sourceCatalog: 'apis-guru'");
    expect(source).toContain('--auth-types');
    expect(source).toContain('--target-imports');
    expect(source).toContain('--concurrency');
    expect(source).toContain('--max-operations');
  });

  it('keeps generated connector icon enrichment repeatable and report-driven', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts/connectors/enrich-openapi-icons.ts'),
      'utf8',
    );
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(pkg.scripts['connectors:enrich-icons']).toContain('enrich-openapi-icons.ts');
    expect(source).toContain('https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json');
    expect(source).toContain('favicon-fallback');
    expect(source).toContain('iconVerified');
    expect(source).toContain('icon-enrichment-report.json');
    expect(source).toContain('--dry-run');
    expect(source).toContain('--spec-dir');
  });

  it('keeps browser-assisted provider onboarding human-gated', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts/connectors/assisted-provider-onboarding.ts'),
      'utf8',
    );
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(pkg.scripts['connectors:assisted-onboarding']).toContain('assisted-provider-onboarding.ts');
    expect(source).toContain('connectOverCDP');
    expect(source).toContain('never fills or submits third-party forms');
    expect(source).toContain('Status after manual work');
    expect(source).toContain('Do not let automation accept terms');
    expect(source).not.toContain('.fill(');
    expect(source).not.toContain('.click(');
  });
});
