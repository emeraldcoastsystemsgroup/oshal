/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial unit tests for ClineCLIWrapper (agent API configuration contract)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated Change Log for attribution and timestamp compliance
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for tools and mcp config fields
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Operator directive 2026-08-13 — nothing hardcoded: configuration decides and the swarm env file is the fallback. The provider-type assertion was pinning the hardcoded 'claude-code'; replaced with the four-row precedence contract (config -> FORCE_LLM_PROVIDER -> LLM_PROVIDER -> the wrapper's own name).
 */

/**
 * @description
 * Unit tests for ClineCLIWrapper. Validates initialization, method outputs, and config validation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ClineCLIWrapper } from '../../src/features/llm-provider/services/cline-cli-wrapper';
import type { ClineCLIConfig } from '../../src/shared/types/llm-provider';

describe('ClineCLIWrapper', () => {
  const validConfig: ClineCLIConfig = {
    binaryPath: '/usr/local/bin/cline',
    args: ['--foo', '--bar'],
    env: { TEST_ENV: '1' },
    tools: [{ name: 'tool1' }, { name: 'tool2' }],
    mcp: { endpoint: 'http://localhost:1234', key: 'abc' },
  };

  it('should initialize and return correct agent name', () => {
    const wrapper = new ClineCLIWrapper(validConfig);
    expect(wrapper.getAgentName()).toBe('Cline CLI Agent');
    expect(wrapper.getConfig()).toEqual(validConfig);
  });

  describe('provider type is configuration, never a literal', () => {
    // Operator directive 2026-08-13: nothing hardcoded; config decides and the swarm env file is
    // the fallback. This used to `return 'claude-code'` unconditionally, which is how a Cline
    // wrapper reported a vendor it has no opinion about long after the fleet moved to codex.
    const priorForce = process.env.FORCE_LLM_PROVIDER;
    const priorLlm = process.env.LLM_PROVIDER;

    afterEach(() => {
      if (priorForce === undefined) delete process.env.FORCE_LLM_PROVIDER;
      else process.env.FORCE_LLM_PROVIDER = priorForce;
      if (priorLlm === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = priorLlm;
    });

    it('takes the provider from the config when it declares one', () => {
      delete process.env.FORCE_LLM_PROVIDER;
      process.env.LLM_PROVIDER = 'openai-codex';
      const wrapper = new ClineCLIWrapper({ ...validConfig, provider: 'claude-code' });
      expect(wrapper.getProviderType()).toBe('claude-code');
    });

    it('falls back to the swarm env file when the config declares none', () => {
      delete process.env.FORCE_LLM_PROVIDER;
      process.env.LLM_PROVIDER = 'openai-codex';
      expect(new ClineCLIWrapper(validConfig).getProviderType()).toBe('openai-codex');
    });

    it('prefers FORCE_LLM_PROVIDER over LLM_PROVIDER, matching the rest of the swarm', () => {
      process.env.FORCE_LLM_PROVIDER = 'openai-codex';
      process.env.LLM_PROVIDER = 'claude-code';
      expect(new ClineCLIWrapper(validConfig).getProviderType()).toBe('openai-codex');
    });

    it('names itself — not a vendor — when nothing is configured at all', () => {
      delete process.env.FORCE_LLM_PROVIDER;
      delete process.env.LLM_PROVIDER;
      expect(new ClineCLIWrapper(validConfig).getProviderType()).toBe('cline-cli');
    });
  });

  it('should validate a correct config', () => {
    const wrapper = new ClineCLIWrapper(validConfig);
    expect(wrapper.validateConfig()).toBe(true);
    expect(wrapper.getConfig().tools).toEqual(validConfig.tools);
    expect(wrapper.getConfig().mcp).toEqual(validConfig.mcp);
  });

  it('should throw error for missing binaryPath', () => {
    const badConfig = { ...validConfig, binaryPath: '' };
    const wrapper = new ClineCLIWrapper(badConfig);
    expect(() => wrapper.validateConfig()).toThrow('ClineCLIConfig: binaryPath is required and must be a string');
  });

  it('should throw error for invalid args', () => {
    const badConfig = { ...validConfig, args: 'not-an-array' as any };
    const wrapper = new ClineCLIWrapper(badConfig);
    expect(() => wrapper.validateConfig()).toThrow('ClineCLIConfig: args must be an array of strings');
  });

  it('should throw error for invalid tools', () => {
    const badConfig = { ...validConfig, tools: 'not-an-array' as any };
    const wrapper = new ClineCLIWrapper(badConfig);
    expect(() => wrapper.validateConfig()).toThrow('ClineCLIConfig: tools must be an array');
  });

  it('should throw error for invalid mcp', () => {
    const badConfig = { ...validConfig, mcp: 'not-an-object' as any };
    const wrapper = new ClineCLIWrapper(badConfig);
    expect(() => wrapper.validateConfig()).toThrow('ClineCLIConfig: mcp must be an object');
  });

  it('should throw error for invalid env', () => {
    const badConfig = { ...validConfig, env: 'not-an-object' as any };
    const wrapper = new ClineCLIWrapper(badConfig);
    expect(() => wrapper.validateConfig()).toThrow('ClineCLIConfig: env must be an object');
  });
});