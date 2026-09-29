/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Validate and forward the complete signed provider-authority slice at bot-node HTTP ingress, including configured fallback order.
 */

import type { BotNodeRequest } from '@/features/agent-management';

/** Provider authority that may cross the controller-to-node HTTP boundary. */
export type BotNodeProviderAuthority = Partial<Pick<
  BotNodeRequest,
  'providerId' | 'model' | 'configVersion' | 'providerConfigRequired' | 'fallbackOrder'
>>;

/** A signed HTTP request carried a malformed provider-authority field. */
export class InvalidBotNodeProviderAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBotNodeProviderAuthorityError';
  }
}

/**
 * @description Parse the authority fields promoted from the signed HTTP body into the internal
 * mesh envelope. Unknown or malformed scalar fields retain the legacy omitted-field behavior;
 * fallbackOrder is rejected when present but malformed because silently dropping part of a
 * signed fallback chain would change the controller's authoritative execution plan.
 */
export function parseBotNodeProviderAuthority(
  body: Record<string, unknown>,
): BotNodeProviderAuthority {
  const authority: BotNodeProviderAuthority = {
    ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.configVersion === 'number' ? { configVersion: body.configVersion } : {}),
    ...(body.providerConfigRequired === true ? { providerConfigRequired: true } : {}),
  };
  if (Object.hasOwn(body, 'fallbackOrder')) {
    if (body.fallbackOrder === null) {
      authority.fallbackOrder = null;
    } else if (!Array.isArray(body.fallbackOrder)
      || !body.fallbackOrder.every((provider) => typeof provider === 'string' && provider.trim().length > 0)) {
      throw new InvalidBotNodeProviderAuthorityError(
        'fallbackOrder must be null or an array of non-empty provider ids',
      );
    } else {
      authority.fallbackOrder = body.fallbackOrder;
    }
  }
  return authority;
}
