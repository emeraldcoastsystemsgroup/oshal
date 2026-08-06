/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Validate a bounded, link-free PNG/JPEG from the exact Apply task workspace and publish one immutable copy inside the exact Career user store before provenance can be marked verified.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Return the retained artifact's SHA-256 beside its path so Apply V2 can atomically require exact confirmation evidence before submitted_verified.
 *
 * @module app/apply-confirmation-artifact
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { taskWorkspaceFolder } from '@/app/routes/remote-client-workspace-routes';
import { findCareerUserStoreLayout } from '@/shared/career-user-store-path';
import { assertLinkFreeScopedDirectory } from '@/shared/security/scoped-file-writer';

const APPLY_TASK_ID = /^apply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g)$/i;
const MAX_CONFIRMATION_BYTES = 8 * 1024 * 1024;

interface ValidatedImage { data: Buffer; extension: '.png' | '.jpg' }
export interface PersistedApplyConfirmation { path: string; sha256: string }

/** True only for a complete PNG or JPEG payload matching the requested filename extension. */
function validatedImage(data: Buffer, filename: string): ValidatedImage | null {
  const png = data.length >= 12 && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ) && data.subarray(-8).equals(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  const jpeg = data.length >= 4 && data[0] === 0xff && data[1] === 0xd8
    && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
  if (png && filename.toLowerCase().endsWith('.png')) return { data, extension: '.png' };
  if (jpeg && /\.jpe?g$/i.test(filename)) return { data, extension: '.jpg' };
  return null;
}

/** Read one ordinary, single-link file through a no-follow descriptor and recheck its identity. */
function readValidatedImage(filePath: string, filename: string): ValidatedImage | null {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 4n || before.size > BigInt(MAX_CONFIRMATION_BYTES)) return null;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = fs.openSync(filePath, flags);
  try {
    const opened = fs.fstatSync(handle, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const data = fs.readFileSync(handle);
    const after = fs.lstatSync(filePath, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.nlink !== 1n) return null;
    return validatedImage(data, filename);
  } finally { fs.closeSync(handle); }
}

/** Publish one exclusive private file, or reuse an already-valid idempotent task copy. */
function publishImage(
  directory: string,
  taskId: string,
  image: ValidatedImage,
): PersistedApplyConfirmation | null {
  const target = path.join(directory, `${taskId}${image.extension}`);
  let created: { dev: bigint; ino: bigint } | null = null;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0);
    const handle = fs.openSync(target, flags, 0o600);
    try {
      const stat = fs.fstatSync(handle, { bigint: true });
      created = { dev: stat.dev, ino: stat.ino };
      fs.writeFileSync(handle, image.data);
      fs.fsyncSync(handle);
    }
    finally { fs.closeSync(handle); }
  } catch (error) {
    if (created) {
      try {
        const current = fs.lstatSync(target, { bigint: true });
        if (current.isFile() && current.dev === created.dev && current.ino === created.ino) {
          fs.unlinkSync(target);
        }
      } catch { /* retain a raced replacement */ }
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  const retained = readValidatedImage(target, path.basename(target));
  return retained ? {
    path: target,
    sha256: createHash('sha256').update(retained.data).digest('hex'),
  } : null;
}

/**
 * @description Retain a callback-named confirmation image only when it is a direct child of the
 * exact task workspace and can be copied into the exact user's existing Career store link-free.
 * @returns Absolute retained path and SHA-256 for the ledger, or null on every refusal/absence.
 */
export function persistApplyConfirmationArtifact(
  userSub: string,
  taskId: string,
  confirmationFile: string | undefined,
): PersistedApplyConfirmation | null {
  if (!APPLY_TASK_ID.test(taskId) || !confirmationFile || !SAFE_IMAGE_NAME.test(confirmationFile)
    || path.basename(confirmationFile) !== confirmationFile) return null;
  try {
    const workspace = taskWorkspaceFolder(taskId);
    const layout = findCareerUserStoreLayout(userSub);
    if (!workspace || !layout) return null;
    const sourceDir = assertLinkFreeScopedDirectory(workspace);
    const image = readValidatedImage(path.join(sourceDir, confirmationFile), confirmationFile);
    if (!image) return null;
    const applications = assertLinkFreeScopedDirectory(path.join(layout.userDir, 'applications'));
    const destination = path.join(applications, 'confirmations');
    try { fs.mkdirSync(destination, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null; }
    return publishImage(assertLinkFreeScopedDirectory(destination), taskId, image);
  } catch { return null; }
}
