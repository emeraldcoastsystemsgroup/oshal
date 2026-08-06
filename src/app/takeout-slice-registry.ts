/**
 * Package-contributed Google Takeout slice registry.
 *
 * The kernel owns archive safety, authentication, and lifecycle. Installed applications own
 * only their literal archive suffix and ingest function. Contributions exist only while the
 * owning app is active, so toggling or uninstalling an app removes its data path immediately.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Add confined, atomic package Takeout registration and owner-aware dispatch.
 *
 * @module takeout-slice-registry
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { AppContext } from '@/app/composition/app-context';
import { registerPackageFrameworkAliases } from '@/app/composition/manifest-route-mounter';
import type {
  ManifestTakeoutRegistrar,
  SwarmAppTakeoutSliceDeclaration,
} from '@/features/swarm-apps';
import { createChildLogger } from '@/shared/logger';
import type { ExtractedSlice, TakeoutSliceSpec } from './routes/takeout-ingest';

const logger = createChildLogger({ module: 'takeout-slice-registry' });
const nodeRequire = createRequire(__filename);
const DEFAULT_SLICE_BYTES = 64 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 512;

/** Input exposed to one package-owned Takeout handler after archive safety checks. */
export interface TakeoutSliceHandlerInput {
  /** Authenticated OIDC subject; packages must use it as the data owner key. */
  userSub: string;
  /** UTF-8 contents of the one matched and size-bounded archive entry. */
  content: string;
  /** Normalized archive entry name, for audit/error context only. */
  fileName: string;
}

/** Deliberately small result contract returned to the aggregate Takeout endpoint. */
export interface TakeoutSliceHandlerResult {
  summary?: string;
}

type TakeoutSliceHandler = (
  ctx: AppContext,
  input: TakeoutSliceHandlerInput,
) => TakeoutSliceHandlerResult | Promise<TakeoutSliceHandlerResult>;

interface RegisteredTakeoutSlice {
  spec: TakeoutSliceSpec;
  handler: TakeoutSliceHandler;
  packageContext: AppContext;
}

/** Read/dispatch contract consumed by the generic Takeout route. */
export interface TakeoutSliceRuntime {
  /** Snapshot of every currently active package contribution. */
  specs(): TakeoutSliceSpec[];
  /** Dispatch an extracted slice to the exact app+kind registration. */
  ingest(userSub: string, slice: ExtractedSlice): Promise<TakeoutSliceHandlerResult>;
}

/** Whether `candidate` resolves inside `root`, including symlink resolution. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * @description Live implementation of the feature-layer lifecycle port. Registration first
 * builds and validates a complete replacement, then swaps one Map entry, so a failed reload
 * cannot leave a half-old/half-new handler set live.
 */
export class TakeoutSliceRegistry implements ManifestTakeoutRegistrar, TakeoutSliceRuntime {
  private readonly byApp = new Map<string, RegisteredTakeoutSlice[]>();

  constructor(private readonly ctx: AppContext) {
    // Package route JS retains `@/` imports after compilation. Vitest supplies its own alias
    // resolver; production Node needs the same long-lived resolver used by dynamic routes.
    if (!process.env.VITEST) {
      try {
        registerPackageFrameworkAliases(path.resolve(__dirname, '..'));
      } catch (err) {
        logger.error({ err }, 'Failed to register framework aliases for Takeout package handlers');
      }
    }
  }

  /** @inheritdoc */
  async register(
    appName: string,
    packageDir: string,
    declarations: SwarmAppTakeoutSliceDeclaration[],
  ): Promise<void> {
    if (declarations.length === 0) {
      this.byApp.delete(appName);
      return;
    }

    const realPackageDir = fs.realpathSync(packageDir);
    const occupiedKinds = new Set<string>();
    const occupiedSuffixes = new Set<string>();
    for (const [owner, entries] of this.byApp) {
      if (owner === appName) continue;
      for (const entry of entries) {
        occupiedKinds.add(entry.spec.kind);
        occupiedSuffixes.add(entry.spec.pathSuffix.toLowerCase());
        if (entry.spec.htmlPathSuffix) occupiedSuffixes.add(entry.spec.htmlPathSuffix.toLowerCase());
      }
    }

    const entries: RegisteredTakeoutSlice[] = [];
    for (const declaration of declarations) {
      const lowerSuffix = declaration.pathSuffix.toLowerCase();
      if (occupiedKinds.has(declaration.kind)) {
        throw new Error(`Takeout kind already registered by another active app: ${declaration.kind}`);
      }
      const declaredSuffixes = [lowerSuffix];
      if (declaration.htmlPathSuffix) declaredSuffixes.push(declaration.htmlPathSuffix.toLowerCase());
      const conflictingSuffix = declaredSuffixes.find((suffix) => occupiedSuffixes.has(suffix));
      if (conflictingSuffix) {
        throw new Error(`Takeout path already registered by another active app: ${conflictingSuffix}`);
      }
      occupiedKinds.add(declaration.kind);
      for (const suffix of declaredSuffixes) occupiedSuffixes.add(suffix);

      const declaredModule = path.resolve(realPackageDir, declaration.module);
      if (!isWithin(realPackageDir, declaredModule) || !fs.existsSync(declaredModule)) {
        throw new Error(`Takeout module is missing or outside package: ${declaration.module}`);
      }
      const realModule = fs.realpathSync(declaredModule);
      if (!isWithin(realPackageDir, realModule)) {
        throw new Error(`Takeout module resolves outside package: ${declaration.module}`);
      }

      const modulePath = nodeRequire.resolve(realModule);
      delete nodeRequire.cache[modulePath];
      // Load-time compatibility only. Request-time package identity is captured below on ctx.
      process.env.OSHAL_APP_PACKAGE_DIR = realPackageDir;
      const loaded = nodeRequire(modulePath) as Record<string, unknown>;
      const exported = loaded[declaration.handler];
      if (typeof exported !== 'function') {
        throw new Error(
          `Takeout handler export is missing or not a function: ${declaration.module}#${declaration.handler}`,
        );
      }

      entries.push({
        spec: {
          app: appName,
          kind: declaration.kind,
          label: declaration.label.trim(),
          pathSuffix: declaration.pathSuffix,
          htmlPathSuffix: declaration.htmlPathSuffix,
          maxBytes: declaration.maxBytes ?? DEFAULT_SLICE_BYTES,
        },
        handler: exported as TakeoutSliceHandler,
        packageContext: { ...this.ctx, appPackageDir: realPackageDir },
      });
    }

    this.byApp.set(appName, entries);
    logger.info({ appName, slices: entries.map((entry) => entry.spec.kind) }, 'Registered package Takeout slices');
  }

  /** @inheritdoc */
  unregister(appName: string): void {
    if (this.byApp.delete(appName)) {
      logger.info({ appName }, 'Unregistered package Takeout slices');
    }
  }

  /** @inheritdoc */
  specs(): TakeoutSliceSpec[] {
    return Array.from(this.byApp.values(), (entries) => entries.map((entry) => ({ ...entry.spec }))).flat();
  }

  /** @inheritdoc */
  async ingest(userSub: string, slice: ExtractedSlice): Promise<TakeoutSliceHandlerResult> {
    const entry = this.byApp.get(slice.app)?.find((candidate) => candidate.spec.kind === slice.kind);
    if (!entry) throw new Error(`No active Takeout handler for ${slice.app}/${slice.kind}`);

    const result = await entry.handler(entry.packageContext, {
      userSub,
      content: slice.content,
      fileName: slice.fileName,
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(`Takeout handler ${slice.app}/${slice.kind} returned an invalid result`);
    }
    if (result.summary !== undefined && typeof result.summary !== 'string') {
      throw new Error(`Takeout handler ${slice.app}/${slice.kind} returned a non-string summary`);
    }
    return result.summary
      ? { summary: result.summary.trim().slice(0, MAX_SUMMARY_CHARS) }
      : {};
  }
}
