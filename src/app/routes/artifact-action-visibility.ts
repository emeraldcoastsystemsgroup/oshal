/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share caller-visible destination discovery between menus and Jarvis.
 */
import type { Request } from 'express';
import { artifactActionsForType, type ArtifactMenuAction } from '@/shared/artifact-exchange';
import type { PickerVisibleApps } from './artifact-picker-routes';

const BUILTINS = new Set(['kernel-storage', 'kernel-email', 'kernel-rag', 'kernel-jarvis']);

/** @description Discover compatible destinations using the same app visibility policy as the picker. */
export async function visibleArtifactActions(req: Request, mime: string, visibleApps?: PickerVisibleApps): Promise<ArtifactMenuAction[]> {
  const visible = visibleApps ? await visibleApps(req) : new Map<string, string>();
  return artifactActionsForType(mime).filter(action => BUILTINS.has(action.app) || visible.has(action.app));
}
