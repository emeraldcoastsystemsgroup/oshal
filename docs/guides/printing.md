# Printing to the swarm — user guide (as-built)

Print a document from a Windows PC to an oshal printer and its text lands in your **Print Inbox**
with a suggested place to file it: private to you, a bot's knowledge, or the swarm's shared
knowledge. Nothing is written to any knowledge collection until you press **Approve**.

**Where:** open **`/cockpit/?app=print-ingest`** and click **Print Inbox** in the bottom section of
the ribbon. In the Intelligent Career group (`/cockpit/?app=intelligent-career`) the same screen is
the **Print Inbox** tile under *Documents*, and the group's **Setup** page opens it from its last
step, *Subscribe to the print service*.

Print Inbox is the store app **Print Ingest**, and it installs **inactive**: until an operator
switches it on, the screen and every printer delivering to it get `Application inactive` back. The
switch is the **Activate** button on the Print Ingest row of **`/applications`** (operators only).

## How a document gets in

Three ways, and they differ in whose inbox the document lands in.

| Way in | Set up by | Lands in the inbox of |
|---|---|---|
| A printer that runs with a worker node | whoever runs the node, once | the person that computer is registered to |
| A standalone print-to-rag printer | whoever runs it, once | the person whose access token the printer holds — **everyone who prints to it fills that one inbox** |
| **Send to… → File in the print inbox** on a PDF, Word or text file | nobody | you |

Whatever the route, the swarm receives the document's **recovered text** and the print job's
details — never the file itself. The PC you print from holds no credential and installs nothing: it
sees a printer named **`oshal print to rag - <address>`**, and the process behind that printer holds
the credential. The address is in the name on purpose (see *Adding the printer on a Windows PC*).

### A printer that runs with a worker node

A computer set up as a worker node ([Get oshal on your devices](./devices.md)) can advertise a
print-to-rag printer on its own network while it runs. It is **off by default**, because it is a
service other machines on that network can reach.

1. On that computer, set `"printServiceEnabled": true` in the node app's `config.json` (in the
   OSHAL Node app's user-data folder), or start the app once with `OSHAL_PRINT_SERVICE=true` in its
   environment. `printServicePort` (`OSHAL_PRINT_SERVICE_PORT`, default 631, the IPP standard) moves
   it when another printer already holds that port; `printServiceSpoolDir`
   (`OSHAL_PRINT_SERVICE_DIR`) chooses where documents wait until they are delivered.
2. The node must find the print-drop package beside it: `node_modules/@oshal/print-drop`, the
   `packages/oshal-print-drop` folder of a checkout next to `packages/oshal-chat` (run `npm install`
   in it once), or the full path of its `bin/print-drop.js` in `OSHAL_PRINT_DROP_ENTRY`. The node
   that the Get oshal installer puts on a PC does **not** include it, so on that node the printer does
   not start until you provide one of these.
3. Restart the node app. The printer starts with the node — even while the swarm is refusing the
   node, since it only needs the swarm to deliver — and stops when the node disconnects. Documents
   wait in `print-spool` beside the node app unless `printServiceSpoolDir` names another folder.

The node app does not display the printer's own messages yet: each one lands in its *Swarm tasks on
this machine* list as a row marked **✕ failed** with no text. Those rows are the printer talking, not
swarm tasks that failed.

The swarm files each document for the person the computer is registered to, read from its own
device registry, never from anything the printer sends. A computer registered to nobody is refused.

### A standalone print-to-rag printer

Any machine on the swarm's network can run one from `packages/oshal-print-drop` (`npm install` there
once). It needs an address to deliver to and a personal access token:

```bash
# mint a token from your own signed-in session; the response shows its "token" once
curl -fsS -b "$OSHAL_COOKIE_JAR" -X POST -H 'content-type: application/json' \
  -d '{"label":"print-to-rag printer"}' <swarm-url>/api/cli-tokens

OSHAL_PRINT_INTAKE_TOKEN=oshal_pat_... node bin/print-drop.js --target swarm \
  --intake-url <swarm-url>/api/print-ingest/documents
```

`<swarm-url>` is the address you open the cockpit on. Every document printed to this printer is
filed for the token's owner, whoever pressed Print; revoking the token
(`DELETE /api/cli-tokens/<id>`, as in the devices guide) stops it delivering. A printer given only
half a destination — no `--intake-url`, or no token — refuses to start rather than keep documents
to itself. The [print-drop README](../../packages/oshal-print-drop/README.md) covers running it at
boot (`scripts/install-startup-task.ps1 -AtStartup`) and the firewall rules its host needs: inbound
TCP 631 for printing, UDP 5353 (mDNS) and UDP 3702 (WSD) for discovery. `npm run diagnose` in that
folder checks the whole chain and prints PASS/WARN/FAIL per step.

### Send to…

On a screen with a 📤 button ([Send to…](./send-to.md)), a PDF, a Word document or a text file offers
**File in the print inbox**. The swarm extracts its text and files it for approval exactly like a
printed page. This is the way in for a document that already carries real text — a PDF made on a
Mac, say — which a printer cannot pass on (next section).

## Will my document arrive?

Only if the printer can recover its text, and today it recovers text from one format: **XPS**,
Windows' own print format. The PDF that the Windows IPP class driver produces is a picture of the
page with no characters in it.

| Printed from | Arrives at the printer as | Reaches the inbox |
|---|---|---|
| Windows, through a queue installed by WSD discovery | XPS | yes |
| Windows, through an IPP queue, printer advertising PDF first (the default) | a picture-only PDF | **no** |
| Windows, through an IPP queue, printer advertising XPS first | XPS | yes |
| macOS or Linux | PDF | **no** — text is read only from XPS |
| A scan, a photo, any page that is only an image | no text layer | **no** — there is no OCR |

The printer's host makes an IPP queue deliver text by listing an XPS type first in `--formats`
(`OSHAL_PRINT_FORMATS`, or `formats` in `print-drop.config.json`); the printer recognises
`application/vnd.ms-xpsdocument` and `application/oxps`. A node's printer takes only the node's own
settings, so for it the config file beside the print-drop package is the place. The measurements
behind this are in [ADR-135 Amendment A](../adr/135-print-to-swarm-and-print-to-rag.md#amendment-a--printed-pdfs-have-no-text-layer-xps-does).

A document with no recoverable text is never sent: it stays in the printer's spool folder and the
printer logs *not delivered - no recoverable text in this document*.

## The Print Inbox, top to bottom

The heading **Print Inbox**, then *Documents printed to the swarm. Nothing is filed until you approve
it.*

**Two tabs.** **Awaiting approval** — where the screen opens — holds what still needs a decision;
**All** adds everything already approved or rejected. The list is yours alone: nobody else's
documents appear in it.

**One card per document**, newest first:

- **The title** — the print job's name, or, when that is a generic name such as *document* or
  *Untitled*, the first line of the text.
- **A details line** — the computer it was printed from (*unknown machine* when the printer did not
  say), the printer, how many characters were recovered, when it arrived, and its state. The
  computer and user name are what the printing machine *claimed*; they are shown as hints and never
  decide whose document it is.
- **A rule banner**, only when an administrator rule matched the source: *Matched the rule "…",
  which pre-ticked destinations. It cannot approve on its own.*
- **A title box.** What it says when you approve is the title the document is filed under.
- **One row per destination you may use**, the ones not suggested included. Each row shows the
  destination's name, a confidence (*high*, *medium* or *low*), the reason, and *Readable by …*.
  Suggested rows arrive ticked and highlighted.
- **Approve** writes a copy into every ticked destination. **Reject** files nothing and keeps the
  decision.

A decided card (under **All**) lists where each copy went — *<destination> — filed*, or
*<destination> — failed: <reason>*; a rejected one says *No copies were written.* A tab with nothing
in it says *Nothing here. Print something to the swarm printer and it will appear.*

### The destinations

| Destination | Who can read what you file there | Offered |
|---|---|---|
| **Private to me** | you — and an operator, who can see every owner's private documents | always |
| **Swarm knowledge** | everyone signed in to this swarm | only to operators |
| **A bot's knowledge**, e.g. *Maintenance bot* | everyone signed in — **a bot's corpus is routing, not privacy** | only when an operator has configured it |

"Operator" here means an identity on the swarm's operator allowlist. Bot destinations come from
`PRINT_INGEST_BOT_DESTINATIONS` in the environment of the swarm's API service —
`id|Label|collection|topic,topic` entries separated by `;`, documented in the
[package README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/print-ingest).

Ticking more than one is deliberate, not waste: search ranks a document against the others in the
same collection, so the same page is near the top of a small bot corpus and can be buried in the
large shared one. Every copy carries the same document id (`print:` followed by a hash of the text),
and the card records every place a copy went.

### How the suggestion is made

By fixed rules in the app, not by a model — building a suggestion costs no model call.

- **Private to me** is ticked by default (*the safe default — only you can retrieve it*) unless an
  administrator rule matched.
- **A bot's knowledge** is ticked when the text mentions two or more of that bot's configured
  subjects — the reason quotes them (*mentions heat exchanger, service interval*). A single mention
  shows as *medium* and stays unticked.
- **Swarm knowledge** is never ticked unless a rule says so (*everyone in this swarm would be able
  to retrieve it — tick only if that is intended*).
- **An administrator rule** matches a source — the sending IP, the computer name or the printer —
  and pre-ticks its destinations. Rules live in the app's `print_intake_rule` table; nothing in the
  cockpit creates one yet, and no rule approves anything.

## After you approve

- **Finding it.** In Settings → **Knowledge**, *Knowledge Visibility* lists it under the collection
  you chose, and *Test Retrieval* finds it by its words under your own permissions — see
  [Settings](./settings.md#knowledge).
- **Taking it back.** You cannot: no screen deletes a filed document, which is why the card keeps the
  list of every copy.
- **Partially filed.** Some copies were written and some failed; the card names which. There is no
  retry button, on purpose — repeating the whole approval would duplicate the copies that succeeded.

## What it does not do

- **It files nothing by itself.** Every document waits for a person to press **Approve**.
- **It does not open a ticket.** A printed document waits in this inbox; it will not appear on the
  Tickets screen.
- **It does not read pictures.** No OCR — a scan or a photo never arrives.
- **It does not reopen a rejected document.** Printing the identical text again returns the earlier
  entry and its decision; a document whose text changed arrives as a new entry.
- **It does not take the printer's word for who you are.** The computer and user name in a print job
  are recorded and shown, never used to pick an owner or a private destination.
- **It does not make a printer appear across networks.** Discovery (mDNS and WSD) stays on one
  network segment; an overlay such as Headscale or Tailscale carries the printing but not the
  discovery. Add the printer by address, or run a node printer on that network.
- **iPhone and iPad cannot print to it** — AirPrint needs a raster format the printer does not
  accept.

## Adding the printer on a Windows PC

- **Same network:** Settings → Bluetooth & devices → Printers & scanners → **Add device**, then pick
  `oshal print to rag - <address>`. Windows installs it with its built-in driver; there is nothing to
  download.
- **It does not appear** (another network, or discovery blocked): **Add device** → *Add a new device
  manually* → *Add a printer using an IP address or hostname* → device type **IPP Device** → the
  address from the printer's name. Or *Select a shared printer by name* with
  `http://<address>:<port>/ipp/print` (port 631 unless the host moved it). A queue added this way
  is an IPP queue — check *Will my document arrive?* above.
- **"The specified printer already exists"** — Windows kept a phantom of the printer from earlier
  discovery; the print-drop README has the recipe that clears it.

## If something looks wrong

| What you see | What it means |
|---|---|
| The screen shows `Application inactive` | Print Ingest is installed but switched off. An operator presses **Activate** on its row at `/applications`. |
| There is no Print Inbox tile anywhere | Print Ingest is not installed on this swarm. An operator installs it from the catalog at `/applications`, then activates it. |
| I printed to a standalone printer and nothing arrived | A document still in the printer's spool folder was not delivered, and the printer says why in its output (`logs/print-drop.log` beside the package when it runs as the startup task): *not delivered - no recoverable text in this document* means the job carried no text (see *Will my document arrive?*); *swarm delivery failed - the document is kept locally for retry* means the swarm refused or did not answer, and the reason follows — `Application inactive`, a revoked token, a timeout. |
| I printed to a node's printer and nothing arrived | The node app does not show the printer's messages yet, so check the causes in turn: Print Ingest is switched off or not installed (the rows above); the computer is registered to nobody in the swarm, which then has no one to file for — re-run enrollment from the node; or the job carried no text (see *Will my document arrive?*). A document still in the spool folder was not delivered. |
| The node's printer never appeared | It refuses to start without a device id and a credential (the node has not been enrolled) or without print-drop beside the node, and it gives up after a few restarts when another printer holds its port — set `printServicePort` to a free one. The node app does not show which yet (the reason is in its *Print service not started: …* and *Check whether another print-drop instance holds the port* messages). |
| My node's settings reset after I edited `config.json` | The file stopped being valid JSON — a byte-order mark at the start is enough — so the node app replaced it with defaults. Save it as plain UTF-8. |
| *Swarm knowledge* is not offered | You are not on the operator allowlist. Only operators may file where everyone can read. |
| No bot destinations are offered | None are configured. On the `docker-compose.oshal-local.yml` stack the API service's environment is an explicit list that does not carry `PRINT_INGEST_BOT_DESTINATIONS`, so setting it in `.env` alone does not reach the app. |
| I printed the same page again and nothing new appeared | Identical text is one entry. Look under **All** — it may already be filed or rejected. |
| *approve at least one destination, or reject* | **Approve** was pressed with nothing ticked. |
| The Intelligent Career setup step says to install the printer from Get oshal | Get oshal has no printer tile; set one up as described above. The step turns done once any document reaches your inbox, a *Send to…* included. |

Design record: [ADR-135](../adr/135-print-to-swarm-and-print-to-rag.md). The printer itself:
[print-drop README](../../packages/oshal-print-drop/README.md). The app's API, intake states and
rule bounds: the [package README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/print-ingest).
The public page: [oshal.ai/product/apps/print-ingest](https://oshal.ai/product/apps/print-ingest/).
