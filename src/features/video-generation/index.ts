/**
 * video-generation feature slice — the Video Studio's domain layer.
 *
 * The video-director bot drafts a `Storyboard`; `renderVideo` turns it into a real
 * .mp4 (Veo clips + TTS narration + burned captions + optional music, stitched with
 * ffmpeg). Parallels the presentation-generation slice (outline -> renderPptx).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the Video Studio thin slice.
 *
 * @module video-generation
 */

export * from './types';
export * from './services';
