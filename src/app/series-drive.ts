/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the storyboard-frame Drive upload here so the route and the orchestrator can both use it without importing each other (circular).
 */
/**
 * @description Storyboard frames land in the CALLER's Drive, and the render node fetches them by id —
 * the LAN between controller and node is firewalled both directions, so Drive is the bridge.
 *
 * Lives in its own module because both the surface route (`bot-video-routes`) and the orchestrator
 * (`series-orchestrator`) need it, and having either import the other would be circular.
 *
 * @module app/series-drive
 */

/**
 * @description Upload one storyboard still to the caller's Drive and return its file id.
 * @param {Buffer} png the still
 * @param {string} name the file name
 * @param {string} token the caller's Google access token
 * @returns {Promise<string>} the Drive file id
 */
export async function uploadFrameToDrive(png: Buffer, name: string, token: string): Promise<string> {
  const boundary = `oshal-${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name, mimeType: 'image/png' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    // A Buffer IS a Uint8Array — fetch takes it directly. (`BodyInit` is a DOM type the server tsconfig has no lib for.)
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`drive upload ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 140)}`);
  const j = await res.json() as { id?: string };
  if (!j.id) throw new Error(`drive upload ${name}: no file id returned`);
  return j.id;
}
