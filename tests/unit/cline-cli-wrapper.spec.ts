/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial unit tests for ClineCLIWrapper (agent API configuration contract)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated Change Log for attribution and timestamp compliance
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for tools and mcp config fields
 */

/**
 * @description
 * Unit tests for ClineCLIWrapper. Validates initialization, method outputs, and config validation.
 */

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

  it('should initialize and return correct provider type and agent name', () => {
    const wrapper = new ClineCLIWrapper(validConfig);
    expect(wrapper.getProviderType()).toBe('claude-code');
    expect(wrapper.getAgentName()).toBe('Cline CLI Agent');
    expect(wrapper.getConfig()).toEqual(validConfig);
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