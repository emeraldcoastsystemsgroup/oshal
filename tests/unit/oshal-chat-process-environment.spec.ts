/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove desktop-node model/npm children retain signed-in owner config paths without inheriting controller, provider, database, or remote-client authority.
 */

import { describe, expect, it } from 'vitest';
import { buildLocalNodeProcessEnv } from '../../packages/oshal-chat/src/main/process-environment';

describe('OSHAL Chat local subprocess environment', () => {
  it('keeps runtime and owner config paths while dropping ambient secrets', () => {
    expect(buildLocalNodeProcessEnv({
      Path: 'C:\\runtime',
      USERPROFILE: 'C:\\Users\\owner',
      CODEX_HOME: 'C:\\Users\\owner\\.codex',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\owner\\.claude',
      HTTPS_PROXY: 'http://proxy.example',
      DATABASE_URL: 'ambient-database',
      SESSION_SECRET: 'ambient-session',
      REMOTE_CLIENT_CONTROL_PLANE_TOKEN: 'ambient-control-token',
      OPENAI_API_KEY: 'ambient-provider-key',
      ANTHROPIC_API_KEY: 'ambient-provider-key',
    })).toEqual({
      Path: 'C:\\runtime',
      USERPROFILE: 'C:\\Users\\owner',
      HTTPS_PROXY: 'http://proxy.example',
      CODEX_HOME: 'C:\\Users\\owner\\.codex',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\owner\\.claude',
    });
  });
});
