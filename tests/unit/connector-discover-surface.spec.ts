import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cockpit connector Discover surface', () => {
  it('pins the connector marketplace and calls the ADR-067 marketplace routes', () => {
    const root = process.cwd();
    const view = readFileSync(
      path.join(root, 'src/pages/cockpit/js/views/ConnectorDiscoverView.js'),
      'utf8',
    );
    const controller = readFileSync(
      path.join(root, 'src/pages/cockpit/js/cockpit-view-controller.js'),
      'utf8',
    );
    const ribbon = readFileSync(
      path.join(root, 'src/pages/cockpit/js/components/RibbonNav.js'),
      'utf8',
    );
    const html = readFileSync(
      path.join(root, 'src/pages/cockpit/index.html'),
      'utf8',
    );
    const css = readFileSync(
      path.join(root, 'src/pages/cockpit/css/connector-discover.css'),
      'utf8',
    );

    expect(view).toContain('/api/connectors/marketplace');
    expect(view).toContain('/api/connectors/marketplace/audit-export?format=csv');
    expect(view).toContain('data-connector-action');
    expect(view).toContain('writeCapable');
    expect(view).toContain('cdn.simpleicons.org');
    expect(view).toContain('connector-action-list');
    expect(view).toContain('entry.tags');
    expect(view).toContain('connectorStatus');
    expect(view).toContain('connectorRisk');
    expect(view).toContain('connectorAction');
    expect(view).toContain('connectorLoadMore');
    expect(view).toContain('this.pageSize = 48');
    expect(view).toContain('FEATURED_CONNECTOR_IDS');
    expect(view).toContain('_renderFeaturedConnectors');
    expect(view).toContain('connector-feature-card');
    expect(view).toContain('surface-card');
    expect(view).toContain('_scheduleRenderBody');
    expect(view).toContain('iconVerified');
    expect(view).toContain('ICON_BY_PROVIDER');
    expect(view).toContain('connector-initials');
    expect(view).toContain('data-connector-preset');
    expect(view).toContain('_renderCatalogMeta');
    expect(view).toContain('Imported OpenAPI');
    expect(view).toContain('connector-onboarding');
    expect(view).toContain('_onboarding(entry)');
    expect(view).toContain('User-owned credential');
    expect(view).toContain('self-serve');
    expect(view).toContain('OAuth apps');
    expect(view).toContain('connector-export');
    expect(controller).toContain("case 'connectors':");
    expect(ribbon).toContain("{ id: 'connectors'");
    expect(ribbon).toContain("PINNED_PLATFORM_VIEW_IDS = ['operations', 'connectors']");
    expect(html).toContain('css/connector-discover.css');
    expect(css).toContain('.connector-card--enabled');
    expect(css).toContain('--connector-glass-bg');
    expect(css).toContain('var(--oshal-glass-bg');
    expect(css).toContain('var(--connector-text)');
    expect(css).toContain('.connector-risk--high');
    expect(css).toContain('.connector-action--destructive');
    expect(css).toContain('backdrop-filter');
    expect(css).toContain('.connector-logo-badge--verified');
    expect(css).toContain('.connector-load-more');
    expect(css).toContain('.connector-quickbar');
    expect(css).toContain('.connector-featured');
    expect(css).toContain('.connector-feature-card');
    expect(css).toContain('.connector-initials');
    expect(css).toContain('.connector-catalog-meta');
    expect(css).toContain('.connector-onboarding');
    expect(css).toContain('.connector-onboarding--oauth-app');
    expect(css).toContain('.connector-export');
  });
});
