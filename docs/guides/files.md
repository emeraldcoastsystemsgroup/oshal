# Files — user guide (as-built)

Click the folder icon labeled **Files** on the cockpit ribbon — it sits in the **Connections** group
on the default ribbon, in **Start here** on the starter ribbon, and on the Storage app's ribbon. The
same page is served at **`/api/files`** if you prefer a full browser tab (locally,
`http://localhost:35457/api/files`). You must be signed in: every listing, preview and download on
this screen is scoped to your own login, and an unauthenticated request gets nothing back.

Files is one browser over every storage place oshal can reach on your behalf — the private folder
oshal keeps for you on the box, plus your own Dropbox, Google Drive and GitHub once you've connected
them. You drill into folders, preview a file without downloading it, download anything, and upload or
delete on the backends that allow it. It is a view over storage you own; it is not a second copy of
your files.

## Where your files live

The rail on the left is the list of sources you can open. It is built for you at page load, so what
appears depends on what you have connected.

| Source | What it is | When it appears | Upload / delete here |
|---|---|---|---|
| **OSHAL Storage** 🗄️ | A private per-user folder on the oshal box. This is where things land when an app saves for you and no cloud backend is set, and where assistant attachments are captured. It has a 250 MB cap. | Always — it needs no connection. | No |
| **Career** 💼 | Your own career-hunter store: `applications` (generated résumé/cover packets), `uploads` (what you supplied), `career-library`. Other internal folders in that store stay hidden. | When the Career Hunter app is installed *and* your store already has at least one of those three folders. | No |
| **Dropbox** 📦 | The folder tree your connected Dropbox account exposes to oshal, starting at its root. | When Dropbox is connected. | Yes |
| **Google Drive** 🟢 | Your Drive, starting at My Drive. Rides your Google connection, so it needs a Google connection whose access covers Drive. | When Google is connected. | Yes |
| **GitHub** 🐙 | Repositories you own, listed as folders in alphabetical order (the 100 most recently updated ones), then the files inside them. | When GitHub is connected. | No — read and download |

Connect a backend from the **Cloud** tile on the ribbon (`/utilities`). New connections show up in
the rail the next time this page loads.

**This is not the swarm workspace.** When a bot works a ticket it writes into that ticket's workspace,
and you reach those files from the ticket itself — its artifacts list and the **Open in Code Server**
button. Those working folders do not appear in Files. What appears in **OSHAL Storage** is the
per-user folder: files apps saved on your behalf, and assistant deliverables, which are captured into
a `jarvis/<task id>` folder so a chat answer's attachment stays downloadable.

## What you see

The page is three columns: the source rail, the file list, and a preview pane that opens when you
pick a file.

- **Storage** (left rail) — one row per source, each with its icon and label. Click one to open it at
  its root. The first source in the list opens automatically when the page loads, so you always land
  somewhere. The active source is highlighted.
- **Breadcrumb** (top of the middle column) — the trail from the source root to the folder you are in.
  Every segment is a link; click the source name to jump back to the root, or any middle segment to
  climb partway. On Google Drive the crumb shows the readable folder name.
- **↻** — reloads the folder you are looking at. Use it after something has been saved elsewhere.
- **⬆ Upload** — appears for Dropbox and Google Drive and is hidden for every other source. Clicking
  it opens your file picker; the file lands in the folder you currently have open.
- **Message strip** — a one-line result banner under the top bar that clears itself after a few
  seconds. Green covers both progress ("Uploading …") and success, red means it failed. A failed
  upload quotes the backend's reason; a failed delete just says **Delete failed** with no reason.
- **File list** — one row per entry, folders first, then files, alphabetical within each group. (The
  Career root is the exception: its folders always appear in the same fixed order.) Each row shows an
  icon that reflects the file type, the name, the size, and its actions. Folders show no size. Clicking a folder row opens it; clicking a file row previews it. On a narrow phone screen the
  rail becomes a horizontal strip across the top and the size column is hidden.
  - **⬇** on a file row downloads it directly, without opening the preview.
  - **✕** on a file row deletes it. It appears on Dropbox and Google Drive rows.
- **Preview pane** (right) — the file's name, a **Download** button, and **×** to close. Its body
  shows the file when it can, and tells you to download it when it cannot.

### What the preview shows

| File | What you get |
|---|---|
| Text-ish files — `.txt`, `.md`, `.json`, `.yaml`, `.csv`, `.log`, source code, `.html`, `.css`, `.xml`, and similar | The contents rendered as wrapped monospace text. |
| `.svg` | Its markup as text, not the drawn image. |
| Images — `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.ico` | The picture, rendered inline. |
| PDFs, Office documents, archives, and anything else binary | "No inline preview for this file", with its size. Use **Download** to open it in a real application. |
| Anything larger than 2 MB, whatever its type | The same download-instead message. The size cap is checked before the file is fetched, so a huge file does not stall the page. |
| **Anything on Google Drive**, whatever its type | The same download-instead message — always. A Drive entry is addressed by an internal id rather than a filename, so the preview cannot tell a text file from a binary and does not try. Use **Download**. (A Google Doc or Sheet also has no byte size to report, so the message reads "0 B".) |

## What you can do

**Browse a source.** Click a source in the rail, then click folders to drill in and breadcrumb
segments to come back out. GitHub starts with your repositories as the top-level folders; the repo
name is the first step of the path.

**Preview a file.** Click the file's row. The pane opens on the right and loads. Clicking a second
file while the first is still loading is fine — the newer selection wins and the older result is
discarded.

**Download a file.** Either the **⬇** on its row or the **Download** button in the preview pane. It
streams through oshal using your own connection to that backend, so you get the bytes without ever
handling a token. Google-native documents are converted on the way out: a Sheet arrives as CSV, a
Slides deck as PDF, and other Google-native documents as plain text. They keep their Drive name,
which usually carries no file extension — add the matching one (`.csv`, `.pdf`, `.txt`) if your
computer refuses to open the download.

**Upload a file** (Dropbox or Google Drive):

1. Open the source, then navigate to the folder you want the file in.
2. Click **⬆ Upload** and pick a file. The limit is 25 MB; a larger file is refused before anything is
   sent.
3. Watch the message strip. On success it names the stored file and the list refreshes.

The stored name is cleaned first: letters, digits, spaces, `.`, `-` and `_` survive, anything else
becomes `_`, and the name is cut at 120 characters. Uploading a name that already exists in that
Dropbox folder replaces the existing file. Google Drive creates a new file each time, so two files can
share a name in the same folder.

**Delete a file** (Dropbox or Google Drive): click **✕** on its row and confirm the browser prompt.
The list refreshes and the preview closes if you were looking at that file. **On Google Drive this
delete is permanent — the file does not go to Drive's Trash.** A Dropbox delete goes to Dropbox's own
deleted files, where Dropbox's normal recovery rules apply.

## Choosing where new things get saved

This screen browses; it does not decide where an app's output goes. That choice lives on the
**Storage Settings** screen, which belongs to the **Storage** app — Files itself is part of the
framework and is always there once you sign in, but Storage Settings only exists if the Storage app
is installed on your box. Install it from the app store if it isn't on your ribbon.

Storage Settings keeps two buckets — **💻 Generated code** and **📄 Generated files** — and one
backend per bucket. The **Backend** picker offers **OSHAL (local, limited 250 MB)**, **Dropbox** and
**GitHub**, and marks anything you have not connected as *(not connected)*. Choose Dropbox and you
pick the destination from a dropdown of folders that already exist in your Dropbox (you don't type a
name); choose GitHub and you pick the repo from a dropdown — with a **+ New repo** button that
creates one on the spot — plus an optional **Folder in repo** you do type. Press **Save** and the
next thing an app generates follows the new setting.

Until you set one, a sensible default applies from what you have connected: generated code goes to
GitHub when GitHub is connected, generated files go to Dropbox when Dropbox is connected and to Google
Drive when Google is, and otherwise both fall back to OSHAL Storage.

**Google Drive can be a default but is not one of the three choices.** If your Files bucket is
defaulting to Google Drive, the picker cannot show it and falls back to displaying **OSHAL (local,
limited 250 MB)** — so pressing **Save** on that screen turns the displayed value into your real
setting and moves generated files to OSHAL Storage. If you want the Drive default to stand, don't
save over it.

Two consequences worth knowing:

- If your Files bucket points at Dropbox, a deck an app generates for you shows up under **Dropbox**
  here, not under OSHAL Storage.
- Apps often write into a folder of their own rather than the root of the target, so a freshly
  generated file may be one level down. Assistant attachments are the concrete case: they always go to
  OSHAL Storage, under `jarvis/<task id>`, regardless of the bucket setting.

## What this screen does NOT do

- **No uploading into OSHAL Storage, Career, or GitHub.** The **⬆ Upload** button is hidden for those
  sources and the request is refused if it is attempted. Content reaches OSHAL Storage by an app
  saving it there; a GitHub repo takes new content from a push or a generator writing to it, not from
  this browser.
- **No deleting from OSHAL Storage, Career, or GitHub.** The **✕** appears on Dropbox and Google Drive
  rows.
- **No rename, no move, no copy, no new folder, no multi-select.** One file at a time, in place.
- **No search.** There is no query box; you navigate by folder.
- **No quota display.** OSHAL Storage is capped at 250 MB per user and the cap is enforced when
  something is written there, but this screen does not show how much of it you have used. You find out
  when a save fails with a quota message.
- **No sharing, no links, no permissions.** Everything is scoped to your login; there is no control
  here for giving anyone else access.
- **Repos you do not own are not listed.** The GitHub source lists repositories you own, so a repo you
  only collaborate on will not appear.
- **Shortcuts and symbolic links are skipped** in OSHAL Storage and Career, so a linked entry is not
  listed and not readable.
- **Editing is elsewhere.** Preview is read-only; there is no save button.

## If something looks wrong

**"No storage available." in the rail.** The source list came back empty, which in practice means the
request was not accepted — usually a sign-in that has lapsed. Reload the cockpit, sign in again, and
reopen Files. OSHAL Storage is always in the list when the request succeeds.

**A source you expect is missing.** Dropbox, Google Drive and GitHub appear when their connection is
present. Open the **Cloud** tile (`/utilities`), connect the account, then reload this page — the rail
is built once at load and will not notice a connection made in another tab.

**Google Drive is empty, or errors when you open it.** The message "No Drive files available to OSHAL
yet — upload one above or reconnect Google with Drive scope" and any error mentioning reconnecting
both point to the same thing: your stored Google connection does not carry Drive access. Reconnect
Google from the Cloud tile and open Files again.

**"Nothing saved here yet — swarms drop artifacts in OSHAL Storage." in OSHAL Storage.** Nothing has
been written to your per-user folder. That is normal on a new account: it fills when an app saves
output there or an assistant answer produces an attachment. Read the second half of that hint
loosely — a bot working a ticket writes into the ticket's own workspace, not here. For those files,
open the ticket and use its artifacts view.

**The preview says there is nothing to show.** The file is either binary (a PDF, a deck, a
spreadsheet, an archive) or over the 2 MB inline cap. Use **Download** and open it locally. An `.svg`
deliberately shows its markup rather than the image.

**The uploaded file has a different name.** Characters outside letters, digits, spaces, `.`, `-` and
`_` are replaced with `_`, and names longer than 120 characters are shortened. The name in the list is
the name that was stored.

**"Couldn't load" or "Couldn't preview" with a message.** The backend refused the call, and the
reason is quoted verbatim after the colon. These are not message-strip banners: *Couldn't load*
replaces the file list, and *Couldn't preview* appears inside the preview pane. A message about not
being connected means the token for that
provider is gone or expired — reconnect it from the Cloud tile. Otherwise press **↻** and retry; the
backend may simply have been briefly unavailable.

---

The two-bucket storage model behind this screen — how a target is resolved and what each backend
costs you — is written up in [ADR-041](../adr/041-per-user-storage-targets.md).
