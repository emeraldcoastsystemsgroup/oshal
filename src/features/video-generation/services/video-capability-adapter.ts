/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the video capability adapter the shared resolver walks. Declarations come from the built-in VideoGenProviders (ADR-070) with the payer each declares (D4): deck-to-video and ComfyUI free, Veo user-paid because ADR-070's second hard rule bills paid video to the caller's own GCP. ONE availability function (D3) for the options list and the resolver: registered, a declared class, then the provider's own probe — for Veo, the ADR-070 credential rule exactly as veo-client applies it (the caller's token, else the swarm service account only with VEO_ALLOW_SWARM_BILLING=true, and a Vertex project either way). Video has no selector today, so there is no seed: with no swarm row the resolver refuses naming that. No core surface resolves video yet; S4 moves Video Studio's Veo call onto this.
 */

/**
 * @description The video capability adapter (ADR-173).
 * @module video-generation/services/video-capability-adapter
 */

import type {
  CapabilityAdapter,
  CapabilityAvailability,
  CapabilityCallerCredentials,
  CapabilityCostClass,
} from '@/shared/capability-providers';
import { VideoProviderRegistry } from './provider-registry';
import { registerDefaultVideoProviders } from './register-providers';

/** Who pays for each built-in video provider (ADR-173 D4, ADR-070 rule 2 for Veo). */
export const VIDEO_PROVIDER_COST_CLASSES: Readonly<Record<string, CapabilityCostClass>> = Object.freeze({
  'deck-to-video': 'free',
  comfyui: 'free',
  veo: 'user-paid',
});

/** The names the options list shows. */
const VIDEO_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'deck-to-video': 'Deck to video (on-host)',
  comfyui: 'ComfyUI video (GPU box)',
  veo: 'Veo (your Google Cloud)',
});

let builtIns: VideoProviderRegistry | null = null;

/**
 * @description The built-in video providers, registered once into a registry this adapter owns
 * (the process singleton belongs to the generation loop and is never mutated here).
 * @returns The registry.
 */
function builtInVideoProviders(): VideoProviderRegistry {
  if (!builtIns) builtIns = registerDefaultVideoProviders(new VideoProviderRegistry());
  return builtIns;
}

/** @description An unavailable answer. */
function unavailable(providerId: string, missing: CapabilityAvailability['missing'], detail: string): CapabilityAvailability {
  return { providerId, available: false, missing, detail };
}

/**
 * @description ADR-070's credential rule for Veo, as veo-client applies it: a Vertex project, and
 * the caller's own token — the swarm service account only when VEO_ALLOW_SWARM_BILLING=true.
 * @param probe - The Veo provider's own probe (project + service-account key).
 * @param credentials - A token the caller handed in, if any.
 * @param env - Environment map.
 * @returns The availability.
 */
async function veoAvailability(
  probe: () => Promise<{ available: boolean; reason?: string }>,
  credentials: CapabilityCallerCredentials | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CapabilityAvailability> {
  if (!(env.VERTEX_PROJECT || env.GCP_PROJECT_ID)) {
    return unavailable('veo', 'no-credential', 'VERTEX_PROJECT (or GCP_PROJECT_ID) is not set — Veo needs a Vertex-enabled GCP project.');
  }
  if (credentials?.vertexToken) return { providerId: 'veo', available: true, missing: null, detail: '' };
  if (env.VEO_ALLOW_SWARM_BILLING === 'true') {
    const status = await probe();
    if (status.available) return { providerId: 'veo', available: true, missing: null, detail: '' };
    return unavailable('veo', 'no-credential', status.reason || 'the swarm service account is not usable');
  }
  return unavailable('veo', 'no-credential', 'Veo bills the caller\'s own connected GCP account (ADR-070); this call carried no caller token, and the swarm service account is used only with VEO_ALLOW_SWARM_BILLING=true.');
}

/**
 * @description The video capability adapter.
 * @param registry - The provider registry (default: the built-ins this module registers once).
 * @returns The adapter.
 */
export function createVideoCapabilityAdapter(registry: () => VideoProviderRegistry = builtInVideoProviders): CapabilityAdapter {
  return {
    capability: 'video',
    declarations: () => registry().list().map((provider) => ({
      capability: 'video' as const,
      providerId: provider.id,
      displayName: VIDEO_DISPLAY_NAMES[provider.id] ?? provider.id,
      costClass: VIDEO_PROVIDER_COST_CLASSES[provider.id] ?? null,
    })),
    availability: async (providerId, _principal, credentials) => {
      const provider = registry().get(providerId);
      if (!provider) return unavailable(providerId, 'not-registered', `No video provider "${providerId}" is registered on this deployment.`);
      if (!VIDEO_PROVIDER_COST_CLASSES[providerId]) {
        return unavailable(providerId, 'no-cost-class', `${providerId} declares no cost class, so it is never offered (ADR-173 D4).`);
      }
      if (providerId === 'veo') return veoAvailability(() => provider.probe(), credentials);
      const status = await provider.probe().catch((err: unknown) => ({ available: false, reason: err instanceof Error ? err.message : String(err) }));
      if (!status.available) return unavailable(providerId, 'no-credential', status.reason || `${providerId} is not configured on this deployment.`);
      return { providerId, available: true, missing: null, detail: '' };
    },
    seedSwarmDefault: async () => ({
      choice: null,
      source: 'none (no video selector exists)',
      reason: 'No swarm video default is set: an operator writes one with PUT /api/capability-providers/swarm/video. Until ADR-173 S4 each video surface still names its own provider.',
    }),
  };
}
