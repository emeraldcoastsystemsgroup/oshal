# ADR-108: Office delivery adapters — vendor-generic landing zones for AI Office

**Status:** Accepted (2026-07-18)
**Relates to:** ADR-103 (AI Office), ADR-041 (storage targets), ADR-042 (connector tokens)

## Context

AI Office (ADR-103) renders one outline into `.pptx` / `.docx` / `.xlsx`. The operator's
direction: integration must be vendor-generic — "there is Google office stuff, and OpenOffice,
and MS Office… AI Office needs to integrate with any of it generically", including treating
Teams/Slack/SMS as office-communication delivery. And explicitly: work around needing a new
Microsoft 365 sign-in.

Two facts make this cheap. First, the artifacts are standard OOXML — Google Docs/Slides/Sheets
import them and LibreOffice/OpenOffice open them natively, so *format* compatibility already
exists; only the *landing zone* varies by vendor. Second, the platform already has the adapter
seam: `StorageTarget`/`saveContent()` (ADR-041) with per-user connector tokens (ADR-042).

## Decision

1. **The storage target IS the delivery adapter.** No new abstraction. AI Office ships to
   whatever `saveContent()` supports; adding a vendor = adding a provider branch + a connector
   token, never touching a renderer.
2. **`google-drive` adapter (live now).** Rides the existing `google` connector token
   (`credProvider: google`, `drive.file` scope — the app manages only files it created).
   Drive is path-blind, so `ensureDrivePath()` walks/creates the folder chain by
   (name, parent). Smart default: Files → Dropbox, then Google Drive, then local.
3. **`onedrive` adapter (dormant by design).** Microsoft Graph `PUT /me/drive/root:/…:/content`,
   token from a `microsoft` (or Files-scoped `outlook`) connection. No such connection exists
   today, so it throws a clear "connect Microsoft 365" error and is never a smart default —
   zero operator action required until someone actually connects 365.
4. **ODF (.odp/.odt/.ods) is NOT a projection we build.** LibreOffice/OpenOffice open OOXML
   natively; a fourth format tripled test surface for users who already have a working path.
   Revisit only on a real user report of OOXML fidelity problems in LibreOffice.
5. **Comms delivery (Slack / Teams / SMS / email) is the same seam, later.** "Deliver the
   artifact to a channel" is one more adapter family (Slack is already connected; Twilio bot
   exists uncredentialed). BACKLOG'd with done-when — not built here, because delivery-to-chat
   wants an approval gate (nothing posts without one, per the Content Studio rule) that
   deserves its own design pass.

## Consequences

- "Generate → lands in your Google Drive → opens in Google Slides" works today with zero new
  OAuth; the identical flow lights up for OneDrive/Office-online the day a Microsoft
  connection is added, because the adapter is already shipped.
- The presentations router's per-save override whitelist grows with each adapter — it is the
  single gate for what a caller may name as a target.
- `oshal_presentations.provider` now takes new values (`google-drive`, `onedrive`); the
  "My decks" elsewhere-branch (ADR-043) already displays rows whose provider differs from the
  scanned target, so mixed-vendor histories render without UI changes.
