/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read Antigravity's vendor-owned Windows Credential Manager entry without ever placing the secret on argv, disk, or in a log. The returned JSON is handed directly to the existing authenticated login-push rail.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { buildLocalNodeProcessEnv } from './process-environment';

export const ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET = 'gemini:antigravity';
export const ANTIGRAVITY_TOKEN_RELATIVE_PATH = '.gemini/antigravity-cli/antigravity-oauth-token';

const CRED_READ_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OshalWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)] static extern void CredFree(IntPtr buffer);
  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] blob = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, blob, 0, (int)credential.CredentialBlobSize);
      return blob;
    } finally { CredFree(pointer); }
  }
}
'@
$blob = [OshalWinCred]::Read('${ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET}')
if ($null -eq $blob) { exit 2 }
[Console]::OpenStandardOutput().Write($blob, 0, $blob.Length)
`;

/** Reads the JSON credential Antigravity itself stored for the current OS user. */
export function readAntigravityCredential(): string | null {
  const fallback = join(homedir(), ...ANTIGRAVITY_TOKEN_RELATIVE_PATH.split('/'));
  if (process.platform !== 'win32') {
    try { return readFileSync(fallback, 'utf8'); } catch { return null; }
  }

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CRED_READ_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
    env: buildLocalNodeProcessEnv(),
    maxBuffer: 64 * 1024,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout;

  if (existsSync(fallback)) {
    try { return readFileSync(fallback, 'utf8'); } catch { return null; }
  }
  return null;
}

export function antigravityCredentialPresent(): boolean {
  const raw = readAntigravityCredential();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { token?: { refresh_token?: unknown } };
    return typeof parsed?.token?.refresh_token === 'string' && parsed.token.refresh_token.trim().length > 0;
  } catch {
    return false;
  }
}
