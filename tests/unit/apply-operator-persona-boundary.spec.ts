/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the remote Apply persona's browser-only model authorization and staged, model-hidden completion contract.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface ApplyPersona {
  authorizations?: Record<string, string>;
  capabilities?: string[];
  perspective?: string;
  selector_descriptor?: string;
}

const source = readFileSync(
  resolve(process.cwd(), 'ai-lab/bot-personas/apply-operator.yaml'),
  'utf8',
);
const persona = yaml.load(source) as ApplyPersona;

describe('Apply operator model boundary', () => {
  it('authorizes browser control and no profile, queue, email, or recording tool', () => {
    expect(persona.authorizations).toEqual({ browser_control: 'auto' });
  });

  it('describes staged data and trusted model-hidden completion', () => {
    expect(persona.perspective).toContain('./job.json');
    expect(persona.perspective).toContain('./profile.json');
    expect(persona.perspective).toMatch(/Do not access email or a credential vault/i);
    expect(persona.perspective).toMatch(/trusted runtime[\s\S]*model-hidden completion/i);
    expect(persona.selector_descriptor).toMatch(/trusted controller to record/i);
  });

  it('does not advertise direct email-code retrieval or application recording', () => {
    expect(persona.capabilities).toEqual([
      'ats-form-fill', 'browser-screen-control', 'application-submission',
    ]);
    expect(source).not.toMatch(/\b(?:career_profile|apply_queue|email_code|apply_trace)\b/);
  });
});
