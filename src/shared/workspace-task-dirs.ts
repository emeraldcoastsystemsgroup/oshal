/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared resolver for a task's on-disk folders. ADR-060 moved bot WRITES under a per-user namespace (<wsRoot>/users/<owner>/<task>) and an ownerless <wsRoot>/_shared/<task>, but READERS (verifier, handover/deliverable collectors) still assumed the legacy flat <wsRoot>/<task>, so they found nothing and failed every ticket. This centralizes the lookup so a reader finds a task's files wherever the bot wrote them — flat, per-user, or shared, including agent variants (<task>__*).
 */

import fs from 'fs';
import path from 'path';

/**
 * @description All candidate "task roots" a task folder may live under (ADR-060):
 * the legacy flat root, each per-user namespace, and the ownerless _shared bucket.
 */
function taskRootsFor(wsRoot: string): string[] {
  const roots: string[] = [wsRoot];
  try {
    const usersRoot = path.join(wsRoot, 'users');
    if (fs.existsSync(usersRoot)) {
      for (const owner of fs.readdirSync(usersRoot)) roots.push(path.join(usersRoot, owner));
    }
  } catch { /* users/ unreadable */ }
  const sharedRoot = path.join(wsRoot, '_shared');
  if (fs.existsSync(sharedRoot)) roots.push(sharedRoot);
  return roots;
}

/**
 * @description Every EXISTING `<taskFolder|variant>/<subdir>` directory for a task, across all
 * storage layouts and agent variants (`<taskFolder>__*`). Use this anywhere code reads a task's
 * deliverables / developer-handovers / notes, so it finds them regardless of where the bot wrote.
 * @param wsRoot - the shared workspace root
 * @param taskFolder - the ticket/task folder name (externalId / workspaceTaskId)
 * @param subdir - the subdirectory to collect (e.g. 'deliverables', 'developer-handovers')
 * @returns absolute paths of every matching directory that exists
 */
export function taskSubdirs(wsRoot: string, taskFolder: string, subdir: string): string[] {
  const out: string[] = [];
  for (const root of taskRootsFor(wsRoot)) {
    const primary = path.join(root, taskFolder, subdir);
    if (fs.existsSync(primary)) out.push(primary);
    try {
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith(`${taskFolder}__`)) {
          const variant = path.join(root, entry, subdir);
          if (fs.existsSync(variant)) out.push(variant);
        }
      }
    } catch { /* root unreadable */ }
  }
  return out;
}
