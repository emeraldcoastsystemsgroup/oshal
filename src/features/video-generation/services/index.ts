/**
 * Barrel for video-generation services.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export storyboard-frames — the stage that turns a screenwriter's per-scene camera line into the still image the renderer animates.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export storyboard-image-cost — canonical spend capture for image generation (chat_tasks + oshal_cost_events), part of the media-generation kernel-skill surface so packages record cost without importing operational-intelligence.
 *
 * @module video-generation/services
 */

export * from './storyboard';
export * from './storyboard-frames';
export * from './storyboard-image-providers';
export * from './storyboard-image-cost';
export * from './veo-client';
export * from './image-client';
export * from './video-render-service';
export * from './provider-registry';
export * from './generation-loop';
export * from './providers/veo-provider';
export * from './providers/deck-to-video-provider';
export * from './providers/comfyui-provider';
export * from './register-providers';
