/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum (skill profiles): barrel for the profileable-capability registry + the shared app-profile registry/composer.
 */

export {
  SKILL_CAPABILITIES,
  SKILL_CAPABILITY_IDS,
  isSkillCapabilityId,
  type SkillCapabilityId,
  type SkillCapabilityDeclaration,
} from './capabilities';

export {
  registerAppSkillProfiles,
  unregisterAppSkillProfiles,
  resolveSkillProfileByApp,
  resolveSkillProfileByTicketType,
  registeredSkillProfileApps,
  composeSkillProfilePrompt,
  type SkillProfile,
  type SkillProfileMap,
} from './registry';
