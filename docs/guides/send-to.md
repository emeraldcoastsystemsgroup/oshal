# Send to… — moving a file between apps

Most screens that show you a file, an image or a video have a **📤** button on it, and a
**right-click** menu behind it. That is *Send to…*: it hands the thing you are looking at to another
app in the swarm, without downloading it and uploading it again.

## Using it

1. Find the 📤 on the item — a row in Files, a photo in the gallery, a card in Video Studio. On a
   tight row there may be no button; **right-click the item** instead.
2. Pick a destination. The menu only lists apps that accept *that kind of file*, so a PDF and a
   video offer different lists.
3. What happens next depends on the destination:
   - Some **open**, with your file already loaded and waiting.
   - Some **do the work in place** and tell you when it is done, without leaving the screen.
   - Some open a **small panel over the screen you are on** — emailing is one of these, so you can
     write a note and send without losing your place.

## What you can always send to

Four destinations come with the platform and appear for anything they can read:

| Destination | What it does |
|---|---|
| **Email it…** | Attaches the file to a message sent from *your own* connected mailbox |
| **Save to OSHAL Storage** | Files a copy in your own storage |
| **Ingest to RAG** | Adds the document to a knowledge collection you pick, so the swarm can cite it |
| **Summarize with Jarvis** | Pulls the text out and hands it to Jarvis to summarize |

Everything else in the menu is an installed app that registered for that file type — Portrait Studio
for images, Kid Lens for a Takeout export, the print inbox for documents, and so on. Install more
apps and the menu grows on its own; you do not configure anything.

## Things worth knowing

- **Nothing is shared with anyone.** Sending a file hands it to *another app of yours*, still under
  your account. The claim ticket the swarm creates is tied to you, expires in about fifteen minutes,
  and cannot be redeemed by another user.
- **Sending is never automatic.** Every send is a deliberate click, and a destination that acts
  outward — email above all — still asks you to confirm before anything leaves.
- **An empty menu is an honest answer.** "Nothing accepts *this type* yet" means exactly that. It is
  not an error, and no app is broken.
- **Not every screen has it yet.** The button appears only where a screen has been wired up. If you
  are looking at a file with no 📤 and no right-click menu, that screen has not joined yet — see the
  [coverage list](../apps/artifact-exchange-coverage.md) for where it stands.
- **A cut-off preview cannot be sent.** Where a screen shows only the first part of a long file, the
  send option is deliberately withheld — sending half a document into a knowledge collection would
  quietly poison it.

## If something goes wrong

| What you see | What it means |
|---|---|
| The menu says nothing accepts this type | No installed app registered for it. Installing the right app adds it |
| "Connect Google or Microsoft 365…" when emailing | No mailbox is connected — see [Cloud — connections](./cloud-and-connections.md) |
| The send fails after a long wait | The claim ticket may have expired (about fifteen minutes). Just send it again |
| A destination opens empty | It was reached without the file. Go back and re-send from the 📤 |

How it works underneath, and how an app joins:
[ADR-139](../adr/139-artifact-exchange-send-to-registry.md).
