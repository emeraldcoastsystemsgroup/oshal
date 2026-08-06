/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a reusable exact-subject workspace lease around the common scoped-file writer so concurrent CLI invocations cannot observe each other's identity files.
 */

import path from 'node:path';
import { optionalExactUserSubject } from './exact-user-subject';
import {
  assertLinkFreeScopedDirectory,
  removeOwnedScopedFile,
  writeScopedFile,
  type ScopedFileIdentity,
} from './scoped-file-writer';

const SUBJECT_SCOPE_TAILS = new Map<string, Promise<void>>();

/** One serialized, invocation-owned subject-file scope. */
export interface ScopedSubjectLease {
  directory: string;
  userSub: string | undefined;
  release(): void;
}

/** Wait for the prior holder and install this invocation as the workspace tail. */
async function waitForSubjectScope(directory: string): Promise<{
  tail: Promise<void>;
  unlock(): void;
}> {
  const previous = SUBJECT_SCOPE_TAILS.get(directory) ?? Promise.resolve();
  let unlock: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  SUBJECT_SCOPE_TAILS.set(directory, tail);
  await previous.catch(() => undefined);
  return { tail, unlock };
}

/**
 * Serialize one link-free workspace while its exact invocation-owned subject file is visible.
 * Release is idempotent and removes the entry only if its lossless filesystem identity still
 * matches, so a replacement from a newer publisher survives cleanup.
 */
export async function acquireScopedSubjectLease(
  workspacePath: string,
  userSub: string | undefined,
  label = 'userSub',
): Promise<ScopedSubjectLease> {
  const exactSub = optionalExactUserSubject(userSub, label);
  const directory = assertLinkFreeScopedDirectory(workspacePath);
  const { tail, unlock } = await waitForSubjectScope(directory);
  let owned: ScopedFileIdentity | undefined;
  try {
    if (exactSub !== undefined) {
      owned = writeScopedFile(path.join(directory, '.oshal-user-sub'), exactSub);
    }
  } catch (error) {
    unlock();
    if (SUBJECT_SCOPE_TAILS.get(directory) === tail) SUBJECT_SCOPE_TAILS.delete(directory);
    throw error;
  }
  let released = false;
  return {
    directory,
    userSub: exactSub,
    release: () => {
      if (released) return;
      released = true;
      removeOwnedScopedFile(owned);
      unlock();
      if (SUBJECT_SCOPE_TAILS.get(directory) === tail) SUBJECT_SCOPE_TAILS.delete(directory);
    },
  };
}
