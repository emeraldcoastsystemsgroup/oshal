/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR         | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove existing desktop profiles migrate to the hosted visual Jarvis surface while an explicit post-migration opt-out remains durable.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Mocked Electron's app path in Vitest so the config migration unit stays isolated from the packaged desktop runtime dependency.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/oshal-chat-test',
  },
}));

import {
  CURRENT_CONFIG_VERSION,
  migrateConfig,
} from '../../packages/oshal-chat/src/main/config';

describe('OSHAL Chat Full-Jarvis config migration', () => {
  it('defaults a profile that predates the Full-Jarvis setting onto the hosted visual surface', () => {
    const migrated = migrateConfig({
      controlPlaneUrl: 'http://localhost:35457',
      cockpitBaseUrl: '',
    });

    expect(migrated.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(migrated.fullJarvisEnabled).toBe(true);
    expect(migrated.cockpitBaseUrl).toBe('');
  });

  it('preserves a legacy profile that explicitly selected orb-only mode', () => {
    const migrated = migrateConfig({
      controlPlaneUrl: 'http://localhost:35457',
      fullJarvisEnabled: false,
      cockpitBaseUrl: '',
    });

    expect(migrated.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(migrated.fullJarvisEnabled).toBe(false);
  });

  it('preserves an explicit opt-out after the migration has been recorded', () => {
    const migrated = migrateConfig({
      configVersion: CURRENT_CONFIG_VERSION,
      fullJarvisEnabled: false,
      cockpitBaseUrl: 'https://custom-oshal.example',
    });

    expect(migrated.fullJarvisEnabled).toBe(false);
    expect(migrated.cockpitBaseUrl).toBe('https://custom-oshal.example');
  });

  it('does not redirect a custom self-hosted control plane to the bundled public origin', () => {
    const migrated = migrateConfig({
      controlPlaneUrl: 'http://tenant-controller.lan:5000',
      fullJarvisEnabled: false,
      cockpitBaseUrl: '',
    });

    expect(migrated.fullJarvisEnabled).toBe(false);
    expect(migrated.cockpitBaseUrl).toBe('');
  });

  it('lets installer environment settings override the migration', () => {
    const migrated = migrateConfig(
      { fullJarvisEnabled: false, cockpitBaseUrl: '' },
      { fullJarvisEnabled: false, cockpitBaseUrl: 'https://tenant.example' },
    );

    expect(migrated.fullJarvisEnabled).toBe(false);
    expect(migrated.cockpitBaseUrl).toBe('https://tenant.example');
  });
});
