/**
 * Profile Studio desktop dispatch. An approved per-user plan is staged into a unique task
 * workspace and applied by linkedin-profile-operator through the real logged-in desktop browser.
 * Result authority is a short-lived, one-use capability carried outside model-visible arguments;
 * the trusted remote daemon, not generated shell, delivers the strictly structured outcome.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial browser-control profile dispatch with desktop result reporting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add the profile-photo step beside banner and featured-resume assets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Route selection and durable enqueue through the shared browser-task dispatcher.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Await durable PostgreSQL enqueue before reporting dispatch success.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Replace fleet-secret/generated-PowerShell prompts with one-use generation-bound callback metadata; stage bounded contained regular assets into a restrictive remote workspace before state transition and clean up every failed dispatch.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Return the generic non-enumerating browser-authorization refusal when the hardened pre-staging selector denies every scoped node.
 *
 * @module app/profile-studio-dispatch
 */

import { constants as fsConstants, promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { taskWorkspaceFolder } from '@/app/routes/remote-client-routes';
import { NO_AUTHORIZED_BROWSER_WORKER_ERROR } from '@/app/browser-worker-eligibility';
import {
  dispatchBrowserTask,
  pickApplyClient,
  type DispatchResult,
} from '@/app/browser-task-dispatch';
import {
  PROFILE_CALLBACK_OPERATION,
  mintProfileDispatchCapability,
  type LinkedInProfilePlan,
  type ProfilePlanStore,
} from '@/features/profile-studio';
import type { RemoteClientRecord } from '@/features/remote-client';

const logger = createChildLogger({ module: 'profile-studio-dispatch' });
const PROFILE_OPERATOR_AGENT_ID = 'cb000000-0000-0000-0000-000000000004';
const IMAGE_LIMIT = 8 * 1024 * 1024;
const RESUME_LIMIT = 12 * 1024 * 1024;

/** @description Relative staged asset names safe to include in the model-visible editing prompt. */
export interface ProfileStagedAssetNames {
  photo?: string;
  background?: string;
  resume?: string;
}

/** @description Inputs needed to stage, authorize, and enqueue exactly one approved generation. */
export interface ProfileDispatchInput {
  plan: LinkedInProfilePlan;
  store: Pick<ProfilePlanStore, 'beginDispatch' | 'failDispatch'>;
  assetRoot: string;
  preferredClientId?: string;
}

/** @description Shared browser-dispatch result returned to the authenticated Career route. */
export type ProfileDispatchResult = DispatchResult;

interface StagedProfileAssets {
  folder: string | null;
  workspacePath?: string;
  names: ProfileStagedAssetNames;
}

interface AssetSpec {
  source: string;
  field: keyof ProfileStagedAssetNames;
  baseName: string;
  limit: number;
  kind: 'image' | 'pdf';
}

/**
 * @description Builds model-visible browser instructions from approved values and relative staged
 * filenames only. It contains no subject, callback URL, capability, fleet secret, or shell command.
 * @param plan - Approved plan values to apply.
 * @param assets - Relative task-workspace filenames prepared by trusted controller code.
 * @returns Full browser-control prompt ending in one strict JSON result contract.
 */
export function buildProfilePrompt(
  plan: LinkedInProfilePlan,
  assets: ProfileStagedAssetNames = {},
): string {
  const fields = profileFieldInstructions(plan, assets);
  return [
    'You are linkedin-profile-operator on the operator\'s own desktop. Update the operator\'s OWN',
    'LinkedIn profile by driving the REAL, logged-in Chrome with your browser_control tools.',
    'Capture, read, act, and re-capture. Paste long text; never type it character by character.',
    ...assetInstructions(assets),
    'START: navigate to https://www.linkedin.com/in/me/ and screenshot. If a login page,',
    'CAPTCHA, or verification prompt appears, STOP immediately. NEVER enter credentials or codes.',
    'APPLY EXACTLY THESE APPROVED CHANGES, one section at a time. Save and verify each section:',
    ...fields,
    'HARD RULES:',
    '- NEVER create a feed post. Any notify-network or share-profile-changes control must be OFF.',
    '- Touch only the listed sections. Do not improve, infer, or add anything else.',
    '- If one change cannot be completed or verified, finish safe remaining changes and fail.',
    'FINAL RESULT CONTRACT:',
    '- Return exactly one JSON object and no prose or code fence.',
    '- Use {"result":"applied","note":"bounded per-field outcome"} only if every field verifies.',
    '- Otherwise use {"result":"failed","note":"bounded per-field outcome and blocker"}.',
    '- Trusted runtime code delivers this result. Do not make HTTP calls or run callback commands.',
  ].filter(Boolean).join('\n');
}

/**
 * @description Stages assets, atomically binds a new capability generation, then enqueues the exact
 * selected node. Missing assets fail while still approved; enqueue failure revokes that generation.
 * @param input - Approved plan, store boundary, caller asset root, and optional node preference.
 * @returns Durable dispatch outcome; never exposes capability material.
 */
export async function dispatchProfileUpdate(input: ProfileDispatchInput): Promise<ProfileDispatchResult> {
  const { plan } = input;
  if (plan.state !== 'approved') return { ok: false, error: 'plan is not approved' };
  const client = pickApplyClient(input.preferredClientId, { sub: plan.userSub });
  if (!client) return { ok: false, error: NO_AUTHORIZED_BROWSER_WORKER_ERROR };
  const callbackUrl = profileCallbackUrl(client);
  if (!callbackUrl) return { ok: false, error: 'The selected desktop has no valid registered control plane.' };
  const taskId = `liprofile-${plan.id}-${randomUUID()}`;
  let staged: StagedProfileAssets | null = null;
  try {
    staged = await stageProfileAssets(taskId, input.assetRoot, plan);
    return await authorizeAndEnqueue(input, client, callbackUrl, taskId, staged);
  } catch (error) {
    logger.error({ err: error, planId: plan.id, taskId }, 'profile dispatch preparation failed');
    if (staged?.folder) await removeWorkspace(staged.folder, taskId);
    return { ok: false, error: 'Could not securely prepare the approved profile assets.' };
  }
}

/**
 * @description Removes the unique Profile Studio task workspace after an accepted result.
 * @param taskId - Exact consumed task id.
 * @returns Resolves after cleanup; logs and retains evidence if filesystem removal fails.
 */
export async function cleanupProfileDispatchWorkspace(taskId: string): Promise<void> {
  const folder = taskWorkspaceFolder(taskId);
  if (folder) await removeWorkspace(folder, taskId);
}

/** @description Performs the state CAS and enqueue after every asset is safely staged. */
async function authorizeAndEnqueue(
  input: ProfileDispatchInput,
  client: RemoteClientRecord,
  callbackUrl: string,
  taskId: string,
  staged: StagedProfileAssets,
): Promise<ProfileDispatchResult> {
  const capability = mintProfileDispatchCapability();
  const generation = await input.store.beginDispatch(
    input.plan.userSub,
    input.plan.id,
    taskId,
    client.clientId,
    capability.tokenHash,
    capability.expiresAt,
  );
  if (generation === null) {
    if (staged.folder) await removeWorkspace(staged.folder, taskId);
    return { ok: false, error: 'plan is no longer approved' };
  }
  const result = await enqueueAuthorized(input, client, callbackUrl, taskId, generation, capability.token, staged);
  if (!result.ok) await failAuthorizedDispatch(input, client.clientId, taskId, generation, staged, result.error);
  return result;
}

/** @description Builds the trusted callback envelope and hands it to the generic browser rail. */
async function enqueueAuthorized(
  input: ProfileDispatchInput,
  client: RemoteClientRecord,
  callbackUrl: string,
  taskId: string,
  generation: number,
  token: string,
  staged: StagedProfileAssets,
): Promise<ProfileDispatchResult> {
  const result = await dispatchBrowserTask({
    taskId,
    fromAgentId: PROFILE_OPERATOR_AGENT_ID,
    userSub: input.plan.userSub,
    preferredClientId: client.clientId,
    workspacePath: staged.workspacePath,
    prompt: buildProfilePrompt(input.plan, staged.names),
    completionCallback: {
      kind: 'trusted-http-json-v1',
      url: callbackUrl,
      capability: token,
      context: {
        userSub: input.plan.userSub,
        generation,
        clientId: client.clientId,
        operation: PROFILE_CALLBACK_OPERATION,
      },
    },
  });
  if (result.ok) logger.info({ clientId: result.clientId, taskId, planId: input.plan.id, generation }, 'profile update dispatched');
  return result;
}

/** @description Revokes an unqueued generation and removes its never-consumed staged workspace. */
async function failAuthorizedDispatch(
  input: ProfileDispatchInput,
  clientId: string,
  taskId: string,
  generation: number,
  staged: StagedProfileAssets,
  error?: string,
): Promise<void> {
  const note = String(error || 'desktop enqueue failed').slice(0, 4000);
  await input.store.failDispatch(input.plan.userSub, generation, taskId, clientId, note);
  if (staged.folder) await removeWorkspace(staged.folder, taskId);
}

/** @description Derives the callback only from the selected client's registered control plane. */
function profileCallbackUrl(client: RemoteClientRecord): string | null {
  try {
    const registered = new URL(client.controlPlaneUrl);
    if (!['http:', 'https:'].includes(registered.protocol) || registered.username || registered.password) return null;
    return new URL('/api/profile-studio/ingest', registered).toString();
  } catch (error) {
    logger.error({ err: error, clientId: client.clientId }, 'selected profile client has invalid control-plane URL');
    return null;
  }
}

/** @description Stages every referenced asset transactionally into one restrictive unique folder. */
async function stageProfileAssets(
  taskId: string,
  assetRoot: string,
  plan: LinkedInProfilePlan,
): Promise<StagedProfileAssets> {
  const specs = profileAssetSpecs(plan);
  if (specs.length === 0) return { folder: null, names: {} };
  const folder = taskWorkspaceFolder(taskId);
  if (!folder) throw new Error('unsafe profile task workspace id');
  await fsp.mkdir(path.dirname(folder), { recursive: true });
  await fsp.mkdir(folder, { recursive: false, mode: 0o700 });
  await fsp.chmod(folder, 0o700);
  const names: ProfileStagedAssetNames = {};
  try {
    for (const spec of specs) names[spec.field] = await stageOneAsset(assetRoot, folder, spec);
    return { folder, workspacePath: taskId, names };
  } catch (error) {
    await removeWorkspace(folder, taskId);
    throw error;
  }
}

/** @description Converts non-null plan paths to a bounded three-file staging manifest. */
function profileAssetSpecs(plan: LinkedInProfilePlan): AssetSpec[] {
  const specs: Array<AssetSpec | null> = [
    plan.photoPath ? { source: plan.photoPath, field: 'photo', baseName: 'profile-photo', limit: IMAGE_LIMIT, kind: 'image' } : null,
    plan.backgroundImagePath ? { source: plan.backgroundImagePath, field: 'background', baseName: 'background', limit: IMAGE_LIMIT, kind: 'image' } : null,
    plan.resumePath ? { source: plan.resumePath, field: 'resume', baseName: 'featured-resume', limit: RESUME_LIMIT, kind: 'pdf' } : null,
  ];
  return specs.filter((spec): spec is AssetSpec => spec !== null);
}

/** @description Reads one contained regular file and creates one exclusive mode-0600 staged copy. */
async function stageOneAsset(root: string, folder: string, spec: AssetSpec): Promise<string> {
  const extension = validatedAssetExtension(spec.source, spec.kind);
  const bytes = await readContainedAsset(root, spec.source, spec.limit);
  assertAssetMagic(bytes, extension, spec.kind);
  const relativeName = `${spec.baseName}${extension}`;
  const destination = path.join(folder, relativeName);
  const handle = await fsp.open(destination, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await fsp.chmod(destination, 0o600);
  return relativeName;
}

/** @description Opens a contained non-link regular file and reads exactly its bounded snapshot. */
async function readContainedAsset(root: string, source: string, limit: number): Promise<Buffer> {
  const rootPath = path.resolve(root);
  const sourcePath = path.resolve(source);
  assertLexicallyContained(rootPath, sourcePath);
  await assertNoLinks(rootPath, sourcePath);
  const rootReal = await fsp.realpath(rootPath);
  const sourceReal = await fsp.realpath(sourcePath);
  assertLexicallyContained(rootReal, sourceReal);
  const handle = await fsp.open(sourceReal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('profile asset is not a bounded regular file');
    return await readExactFile(handle, stat.size);
  } finally { await handle.close(); }
}

/** @description Reads exactly the validated size and rejects concurrent growth or truncation. */
async function readExactFile(handle: FileHandle, size: number): Promise<Buffer> {
  const output = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(output, offset, size - offset, offset);
    if (read.bytesRead === 0) throw new Error('profile asset changed while staging');
    offset += read.bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error('profile asset grew while staging');
  return output;
}

/** @description Rejects lexical escapes before any filesystem traversal. */
function assertLexicallyContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('profile asset is outside its caller store');
  }
}

/** @description Rejects symlink or junction components from the caller root through the asset. */
async function assertNoLinks(root: string, source: string): Promise<void> {
  let cursor = root;
  const segments = path.relative(root, source).split(path.sep);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('profile asset root is not a regular directory');
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('profile asset path contains a link');
  }
}

/** @description Whitelists asset extensions before a relative staged filename is formed. */
function validatedAssetExtension(source: string, kind: AssetSpec['kind']): string {
  const extension = path.extname(source).toLowerCase();
  if (kind === 'pdf' && extension === '.pdf') return extension;
  if (kind === 'image' && ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return extension;
  throw new Error('profile asset extension is not allowed');
}

/** @description Verifies staged bytes match their approved image/PDF extension. */
function assertAssetMagic(bytes: Buffer, extension: string, kind: AssetSpec['kind']): void {
  if (kind === 'pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return;
  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  if (['.jpg', '.jpeg'].includes(extension) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return;
  if (extension === '.webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return;
  throw new Error('profile asset content does not match its approved type');
}

/** @description Removes only the already-resolved unique task folder and logs any refusal. */
async function removeWorkspace(folder: string, taskId: string): Promise<void> {
  try { await fsp.rm(folder, { recursive: true, force: true }); }
  catch (error) { logger.error({ err: error, taskId }, 'profile task workspace cleanup failed'); }
}

/** @description Produces exact profile field instructions using relative staged assets only. */
function profileFieldInstructions(plan: LinkedInProfilePlan, assets: ProfileStagedAssetNames): string[] {
  return [
    assets.photo ? `- PROFILE PHOTO: upload ./${assets.photo}; save and verify the avatar.` : '',
    plan.headline ? `- HEADLINE (replace whole field): ${JSON.stringify(plan.headline)}` : '',
    plan.about ? `- ABOUT (replace whole field): ${JSON.stringify(plan.about)}` : '',
    plan.skills.length ? `- SKILLS (add only missing entries): ${JSON.stringify(plan.skills)}` : '',
    plan.customUrl ? `- CUSTOM URL: set the slug to ${JSON.stringify(plan.customUrl)}` : '',
    assets.background ? `- BACKGROUND PHOTO: upload ./${assets.background}; apply, save, and verify.` : '',
    assets.resume ? `- FEATURED RESUME: upload ./${assets.resume} as Featured media titled "Resume".` : '',
  ].filter(Boolean);
}

/** @description Lists trusted staged files without generating filesystem or callback commands. */
function assetInstructions(assets: ProfileStagedAssetNames): string[] {
  const files = Object.values(assets).map((name) => `./${name}`);
  return files.length ? [
    'TRUSTED STAGED ASSETS: use only these relative files from the current task workspace:',
    ...files.map((name) => `- ${name}`),
  ] : [];
}
