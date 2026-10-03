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
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export storyboard-cli-image-executor — the app-boot injection seam for the ADR-130 codex-cli image provider (register/resolve; the feature never imports the app layer).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export storyboard-antigravity-image-provider (the antigravity-cli rail) and storyboard-image-default (the image selection by the render bot's own harness and its app-boot reader seam), ADR-130 amendment 2026-10-02.
 *
 * @module video-generation/services
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: export the video capability adapter; the image adapter (createImageCapabilityAdapter, buildStoryboardImageProvider, STORYBOARD_IMAGE_COST_CLASSES) rides the existing storyboard-image-providers export and selectStoryboardImageSeed the storyboard-image-default one. Additive.
 */

export * from './storyboard';
export * from './storyboard-frames';
export * from './storyboard-image-providers';
export * from './storyboard-cli-image-executor';
export * from './storyboard-antigravity-image-provider';
export * from './storyboard-image-default';
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
export * from './video-capability-adapter';
