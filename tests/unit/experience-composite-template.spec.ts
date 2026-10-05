/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Refuse implicit composite mappings, missing required members, unsupported role shapes and ambiguous versions before installation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Permit native application composites while refusing ambiguous owners and unsupported lifecycle floors.
 */
import { describe, expect, it } from 'vitest';
import { validateExperienceDeclaration } from '@/shared/experience-contract';

const manifest = () => ({ name: 'home-experience', uses: ['experience', 'experience-roles', 'application-authorization', 'app-dependencies'], authorization: { version: 1, catalog: 'authorization.yaml' },
  routes: [{ mountPath: '/api/home-experience', auth: 'oidc' }], dependencies: { required: { apps: ['household'] }, optional: { apps: ['shopping'] } },
  experience: { version: 1, entry: '/api/home-experience/app', shell: 'page', label: 'Home', skin: 'family', roleTemplates: [{ id: 'adult', version: 1, label: 'Household adult',
    members: [{ app: 'home-experience', role: 'viewer' }, { app: 'household', role: 'adult' }, { app: 'shopping', role: '@app-admin' }] }] } });
describe('experience composite role declarations', () => {
  it('requires its own lifecycle floor so an incomplete runtime cannot silently ignore templates', () => {
    const input = manifest(); input.uses = input.uses.filter(skill => skill !== 'experience-roles');
    expect(() => validateExperienceDeclaration(input)).toThrow(/experience-roles/);
  });
  it('accepts explicit catalog mappings and a deliberately declared legacy adapter without writing grants', () => {
    const input = manifest(), before = JSON.stringify(input);
    expect(() => validateExperienceDeclaration(input)).not.toThrow(); expect(JSON.stringify(input)).toBe(before);
  });
  it.each([[], null, [{ id: 'adult', version: 0, label: 'Adult', members: [] }], [{ id: 'adult', version: 1, label: 'Adult', members: [{ app: 'home-experience', role: 'viewer' }] }]])('refuses incomplete template %j', roleTemplates => {
    const input = manifest(); expect(() => validateExperienceDeclaration({ ...input, experience: { ...input.experience, roleTemplates } })).toThrow();
  });
  it.each(['@access-admin', '*', 'viewer OR admin', '../admin'])('refuses management delegation or inferred role %s', role => {
    const input = manifest(); input.experience.roleTemplates[0].members[0].role = role;
    expect(() => validateExperienceDeclaration(input)).toThrow(/exact catalog role/);
  });
  it('refuses an undeclared app, repeated role edge or duplicate template identity', () => {
    const input = manifest(); input.experience.roleTemplates[0].members.push({ app: 'foreign', role: 'viewer' });
    expect(() => validateExperienceDeclaration(input)).toThrow(/declared dependency/);
    input.experience.roleTemplates[0].members.pop(); input.experience.roleTemplates[0].members.push(input.experience.roleTemplates[0].members[0]);
    expect(() => validateExperienceDeclaration(input)).toThrow(/repeat/);
    input.experience.roleTemplates[0].members.pop(); input.experience.roleTemplates.push(input.experience.roleTemplates[0]);
    expect(() => validateExperienceDeclaration(input)).toThrow(/unique/);
  });
});

describe('native application composite declarations', () => {
  const native = () => {
    const experience = manifest();
    return { name: 'little-monsters', uses: ['application-authorization', 'experience-roles', 'app-dependencies'],
      dependencies: experience.dependencies, authorization: { version: 1, catalog: 'authorization.yaml', roleTemplates: [{
        id: 'student', version: 1, label: 'Student', members: [{ app: 'little-monsters', role: 'student' },
          { app: 'household', role: 'adult' }, { app: 'shopping', role: '@app-admin' }],
      }] } };
  };
  it('accepts a complete native bundle without an experience shell and changes no declaration', () => {
    const input = native(), before = JSON.stringify(input);
    expect(() => validateExperienceDeclaration(input)).not.toThrow(); expect(JSON.stringify(input)).toBe(before);
  });
  it.each(['experience-roles', 'application-authorization'])('requires the compatibility floor %s', skill => {
    const input = native(); input.uses = input.uses.filter(value => value !== skill);
    expect(() => validateExperienceDeclaration(input)).toThrow(/require uses/);
  });
  it('refuses two competing native and experience template owners', () => {
    expect(() => validateExperienceDeclaration({ ...native(), experience: manifest().experience })).toThrow(/one declaration owner/);
  });
  it('refuses a native template missing a required component or granting a management role', () => {
    const input = native(); input.authorization.roleTemplates[0].members = [{ app: input.name, role: 'student' }];
    expect(() => validateExperienceDeclaration(input)).toThrow(/every required member/);
    input.authorization.roleTemplates[0].members.push({ app: 'household', role: '@access-admin' });
    expect(() => validateExperienceDeclaration(input)).toThrow(/exact catalog role/);
  });
  it('refuses a group or unsupported catalog declaration instead of ignoring its native templates', () => {
    expect(() => validateExperienceDeclaration({ ...native(), kind: 'group' })).toThrow(/ordinary application/);
    const input = native(); input.authorization.version = 2;
    expect(() => validateExperienceDeclaration(input)).toThrow(/version 1/);
  });
});
