/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added extension-layer persona composer scaffold to keep BaseAgent closed
 */

/**
 * @description Supported persona layer types for deterministic prompt composition.
 */
export type PersonaLayerType =
  | 'platform'
  | 'host'
  | 'tenant'
  | 'role'
  | 'session'
  | 'task';

/**
 * @description One persona fragment used during layered prompt assembly.
 */
export interface PersonaLayer {
  layerType: PersonaLayerType;
  priority: number;
  promptFragment: string;
  metadata?: Record<string, unknown>;
}

/**
 * @description Result of persona composition.
 */
export interface ComposedPersona {
  mergedPrompt: string;
  appliedLayers: PersonaLayer[];
}

/**
 * @description Composes persona layers outside BaseAgent to preserve hot-swap boundaries.
 */
export class PersonaLayerComposer {
  compose(layers: PersonaLayer[]): ComposedPersona {
    const appliedLayers = [...layers].sort((a, b) => a.priority - b.priority);
    const mergedPrompt = appliedLayers
      .map((layer) => layer.promptFragment.trim())
      .filter((fragment) => fragment.length > 0)
      .join('\n\n');

    return {
      mergedPrompt,
      appliedLayers,
    };
  }
}
