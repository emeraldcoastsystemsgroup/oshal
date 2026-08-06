/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove deterministic connector risk, forbid connector-level YAML risk declarations, and exercise the effective-catalog icon review gate including its fail-closed path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require complete effective category coverage and source-evidence reporting across the optional 1,000-spec generated target.
 * -----------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  auditSpec,
  deriveConnectorRiskLevel,
} from '../../../src/app/connectors/runtime/catalog-audit';
import { ConnectorMarketplaceService } from '../../../src/app/connectors/runtime/marketplace';
import type { ConnectorSpec } from '../../../src/app/connectors/runtime/spec';

const ROOT = process.cwd();
const CURATED_DIR = path.join(ROOT, 'swarm-apps/connectors');
const GENERATED_DIR = path.join(ROOT, 'output/connectors/imported-openapi');
const CURATION_SCRIPT = path.join(ROOT, 'scripts/connectors/curation-audit.mjs');
const ENRICH_SCRIPT = path.join(ROOT, 'scripts/connectors/enrich-openapi-icons.ts');
const TSX_CLI = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');

function baseSpec(overrides: Partial<ConnectorSpec> = {}): ConnectorSpec {
  return {
    provider: 'policy-test',
    baseUrl: 'https://api.policy.test',
    auth: { type: 'apiKeyHeader', header: 'X-Api-Key' },
    resources: [{ name: 'list', tool: 'policy-list', method: 'GET', path: '/items' }],
    ...overrides,
  };
}

function runCuration(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, CURATION_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CONNECTOR_SPEC_DIRS: '' },
  });
}

function runEnrichment(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, ENRICH_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function targetSpecDirs(): string[] {
  return fs.existsSync(GENERATED_DIR) ? [CURATED_DIR, GENERATED_DIR] : [CURATED_DIR];
}

describe('connector-wide risk policy', () => {
  it('derives high from any mutation, medium from credential-reaching read-only auth, and low otherwise', () => {
    expect(deriveConnectorRiskLevel(baseSpec())).toBe('low');
    expect(deriveConnectorRiskLevel(baseSpec({ auth: { type: 'oauth2' } }))).toBe('medium');
    expect(deriveConnectorRiskLevel(baseSpec({ auth: { type: 'basic' } }))).toBe('medium');
    expect(deriveConnectorRiskLevel(baseSpec({
      resources: [{ name: 'create', method: 'POST', path: '/items' }],
    }))).toBe('high');
    expect(deriveConnectorRiskLevel(baseSpec({
      resources: [{ name: 'purge', method: 'GET', path: '/purge', safety: { action: 'destructive' } }],
    }))).toBe('high');
    expect(deriveConnectorRiskLevel(baseSpec({
      actions: [{
        name: 'publish',
        method: 'POST',
        urlTemplate: '/publish',
        paramsSchema: { type: 'object' },
        riskLevel: 'low',
        description: 'Publish an item.',
      }],
    }))).toBe('high');
  });

  it('fails the catalog audit when YAML attempts to declare connector-wide risk', () => {
    const declared = {
      ...baseSpec(),
      riskLevel: 'low',
      metadata: { riskLevel: 'medium' },
    } as unknown as ConnectorSpec;
    const audit = auditSpec(declared);
    expect(audit.pass).toBe(false);
    expect(audit.derivedRiskLevel).toBe('low');
    expect(audit.issues).toContainEqual(expect.objectContaining({
      level: 'error',
      message: expect.stringMatching(/remove riskLevel and metadata\.riskLevel/),
    }));
  });

  it('publishes action-only connectors as high-risk and write-capable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-catalog-risk-'));
    const specDir = path.join(root, 'connectors');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'publisher.yaml'), [
      'provider: publisher',
      'displayName: Publisher',
      'baseUrl: https://api.publisher.test',
      'auth: { type: oauth2 }',
      'rateLimit: { burst: 1, perSecond: 1 }',
      'retry: { maxRetries: 1 }',
      'resources:',
      '  - { name: profile, tool: publisher-profile, method: GET, path: /profile }',
      'actions:',
      '  - name: publish',
      '    method: POST',
      '    urlTemplate: /publish',
      '    riskLevel: low',
      '    description: Publish an item.',
      '    paramsSchema: { type: object }',
      'metadata:',
      '  category: Social',
      '  description: Read a profile and publish an item.',
    ].join('\n'));
    try {
      const service = new ConnectorMarketplaceService({
        specDir,
        statePath: path.join(root, 'state.json'),
        cachePath: path.join(root, 'cache.json'),
      });
      const catalog = service.list();
      expect(catalog.entries[0]).toMatchObject({ riskLevel: 'high', writeCount: 0 });
      expect(catalog.totals).toMatchObject({ highRisk: 1, writeCapable: 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('effective catalog curation gate', () => {
  it('has no unreviewed target-set icons, no category gap, and reports runtime-derived evidence', () => {
    const dirs = targetSpecDirs();
    const args = ['--json', ...dirs.flatMap((dir) => ['--spec-dir', dir])];
    const result = runCuration(args);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.summary.gates).toMatchObject({
      parseErrors: 0,
      unreviewedFaviconFallbacks: 0,
      invalidOrMissingIcons: 0,
      connectorRiskDeclarations: 0,
    });
    expect(report.summary.coverage.reviewedIcon.n).toBe(report.summary.effectiveConnectors);
    expect(report.summary.coverage.category.n).toBe(report.summary.effectiveConnectors);
    expect(report.summary.effectiveMetadataGaps.uncategorized).toBe(0);
    if (fs.existsSync(GENERATED_DIR)) {
      const generatedFiles = fs.readdirSync(GENERATED_DIR).filter((name) => /\.ya?ml$/i.test(name));
      expect(generatedFiles).toHaveLength(1000);
      expect(report.summary.categorySources['source-taxonomy']).toBeGreaterThan(0);
    }

    const riskTotal = Object.values(report.summary.riskLevels)
      .reduce((sum: number, count) => sum + Number(count), 0);
    expect(riskTotal).toBe(report.summary.effectiveConnectors);
    expect(report.connectors.every((row: { connectorRiskLevel?: string }) =>
      ['low', 'medium', 'high'].includes(row.connectorRiskLevel || ''))).toBe(true);
  }, 120_000);

  it('fails closed when a favicon domain is not traceable to the spec or review registry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-icon-policy-'));
    fs.writeFileSync(path.join(root, 'bad.yaml'), [
      'provider: bad-icon',
      'displayName: Bad Icon',
      'baseUrl: https://api.correct.example',
      'auth: { type: none }',
      'resources: []',
      'metadata:',
      '  category: Developer tools',
      '  description: Policy fixture.',
      '  iconSource: favicon-fallback',
      '  iconVerified: false',
      '  iconUrl: https://icons.duckduckgo.com/ip3/wrong.example.ico',
    ].join('\n'));
    try {
      const result = runCuration(['--json', '--spec-dir', root]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.summary.gates.unreviewedFaviconFallbacks).toBe(1);
      expect(report.connectors[0].icon).toMatchObject({
        status: 'unreviewed-favicon-fallback',
        reviewed: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not let an existing slug or empty normalized alias verify an unrelated Simple Icon', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-icon-match-'));
    const specDir = path.join(root, 'connectors');
    const catalogPath = path.join(root, 'simple-icons.json');
    const reportPath = path.join(root, 'report.json');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(catalogPath, JSON.stringify([
      { title: 'Xiaohongshu', aliases: { loc: { 'zh-CN': '小红书' } } },
    ]));
    fs.writeFileSync(path.join(specDir, 'apivideo.yaml'), [
      'provider: apivideo',
      'displayName: api.video',
      'baseUrl: https://ws.api.video',
      'auth: { type: oauth2 }',
      'resources: [{ name: videos, method: GET, path: /videos }]',
      'metadata:',
      '  icon: xiaohongshu',
      '  iconTitle: Xiaohongshu',
      '  iconSource: simple-icons',
      '  iconVerified: true',
    ].join('\n'));
    try {
      const result = runEnrichment([
        '--catalog', catalogPath,
        '--spec-dir', specDir,
        '--report', reportPath,
        '--dry-run',
      ]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      expect(report.entries[0]).toMatchObject({
        provider: 'apivideo',
        source: 'favicon-fallback',
        iconUrl: 'https://icons.duckduckgo.com/ip3/api.video.ico',
        changed: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('accepts initials only when no public favicon domain exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-initials-policy-'));
    const specPath = path.join(root, 'local.yaml');
    const fixture = (baseUrl: string) => [
      'provider: local-only',
      'displayName: Local Only',
      `baseUrl: ${baseUrl}`,
      'auth: { type: none }',
      'resources: [{ name: ping, method: GET, path: /ping }]',
      'metadata:',
      '  category: Developer tools',
      '  description: Local-only policy fixture.',
      '  iconSource: initials-fallback',
      '  iconVerified: false',
    ].join('\n');
    try {
      fs.writeFileSync(specPath, fixture('http://service.local'));
      const localResult = runCuration(['--json', '--spec-dir', root]);
      expect(localResult.status, localResult.stderr || localResult.stdout).toBe(0);
      expect(JSON.parse(localResult.stdout).connectors[0].icon.status).toBe('reviewed-initials-fallback');

      fs.writeFileSync(specPath, fixture('https://api.public-provider.com'));
      const publicResult = runCuration(['--json', '--spec-dir', root]);
      expect(publicResult.status).toBe(1);
      expect(JSON.parse(publicResult.stdout).connectors[0].icon.status).toBe('invalid-icon-metadata');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
