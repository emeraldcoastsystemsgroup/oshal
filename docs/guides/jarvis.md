# Jarvis — user guide (as-built)

Open **`/cockpit/?app=jarvis`** (or the sparkle icon labeled *Assistant* on the ribbon). On every
*other* cockpit page the same assistant is a floating orb button in the corner — click it and the
Jarvis page opens in a docked panel headed *Jarvis — Your assistant, everywhere*, with **⤢** (expand
to a wider panel) and **×** (close) in that header. Drag the orb anywhere you like; right-click it
for **Hide the orb** / **Reset position**, and add `?orb=show` to any cockpit URL to bring a hidden
one back — that restores *your* hide only, so an app whose ribbon suppresses the assistant still
shows no orb on its own pages. The page also answers directly at `/api/jarvis/`, which is what to
open when voice is blocked inside the panel.

This is the one place you can ask for anything in plain language. You talk (or type, or attach a
photo); Jarvis works out what you are asking for, hands the real work to whichever specialist bot
owns that subject, and comes back with one answer in its own voice. Some answers arrive
immediately in the conversation; longer work goes to your **Work queue** on the right and Jarvis
tells you when it lands.

## What you see

The page is one center column with a rail down the right side. Top to bottom:

- **The orb** — the glowing shape in the middle. Click it (or press Enter/Space while it is
  focused) to start and stop recording. It reacts to your voice while you speak and to Jarvis's
  voice while it answers.
- **Always listening: OFF** — a small control just under the orb, with a **⚙ settings** button at
  its lower right. Off by default. See *Hands-free listening* below.
- **The status line** — starts at *Tap the orb and start talking* and then narrates what is
  happening: *Recording… tap Stop & send when done*, *Transcribing…*, *Thinking…*, *Speaking…*. It
  turns red when something failed.
- **Suggestions** — occasionally a row or two appears here when Jarvis has noticed something worth
  following up on. **Review** opens a conversation about it with an explicit instruction that
  nothing may be created until you confirm; **×** dismisses it. Neither button creates anything.
- **The center line** — your last request on one line (`You: …`) and Jarvis's answer under it while
  it is being spoken.
- **Latest result** — the panel holding the newest complete answer, with three controls in its
  header: **A A** cycles the text size (Normal → Large → Larger → Largest, and the change carries to
  every other OSHAL surface you have open), **Print** opens a plain black-on-white copy of the
  conversation in a new window for printing or *Save as PDF* — it needs pop-ups allowed for this
  site, and says *Allow pop-ups to print the conversation* if they are blocked — and **Full
  discussion** opens the archive drawer.
- **Tap to talk** — the main microphone button. It becomes **Stop & send** while recording.
- **The control row** — see the table below.
- **The attachment strip** — thumbnails of the photos and documents attached to your *next*
  message, each with an **✕** to remove it. It clears when the message is sent.
- **The type box** — *Ask me anything…* with an **Ask** button. Hidden until you press **⌨ Type**,
  attach something, or the microphone gets blocked.
- **Starter chips** — three one-click prompts: *Summarize my inbox*, *Jobs worth a look*, and
  *Map it as a diagram*.

The right rail holds three sections:

- **Conversations** — your open chat threads. Click one to resume it: the status line confirms
  *Resumed conversation — keep going*, new messages go back into that thread, and its saved turns are
  replayed into **Full discussion** — the centre of the page stays empty until your next turn, so
  open the drawer if you want to see the history you just reloaded. The thread you are in is
  highlighted.
- **Work queue** — the background work Jarvis filed for you, newest first. Click a finished item to
  hear and read it. A still-running row answers *still working on that one…*. The **×** on a row
  clears it from the list, but a filed work item is stored against your account and comes back on the
  next refresh — treat the queue as the record of what was filed, not a list you can empty.
- **Status** — four live rows with a **↻** refresh button: **Swarm** (bots online / total),
  **Comms** (how many inbox signals, with the first one as the tooltip), **Work** (how many tickets
  are open), and **Next** (your next calendar item).

Two more surfaces appear only when needed:

- **The visual stage** — when an answer comes with a picture, the background particles gather into
  that image, Jarvis narrates it, and two buttons appear: **Back to Jarvis** returns to the orb,
  **Full result** opens the discussion drawer.
- **Full discussion** — the drawer behind the **☰ Discussion** button, subtitled *Text, sources, and
  replayable visual answers*. It holds the whole conversation. A saved picture appears there as a
  thumbnail with a **Rematerialize visual** button, which replays the exact stored image rather than
  asking a model to redraw it. **Escape** or the **×** closes the drawer.

### The control row

| Button | What it does when clicked |
|---|---|
| **✎ New** | Starts a fresh conversation thread. Clears the screen; the next message opens a new chat ticket. |
| **⌨ Type** | Shows or hides the type box. |
| **＋ Add** | Opens the attach menu: **📷 Take photo**, **🖼️ Upload photo**, **📄 Add document**. |
| **■ Stop** | Stops the current speech, cancels recording, and returns the stage to the orb. |
| **◎ Eye** | Cycles the orb's look: Halo → Pulse → Wave → Bars → Eye. The button is labelled with the style you are *currently* on, so it reads **◎ Eye** until you change it. The choice sticks in this browser. |
| **🔊 Voice** | Cycles your browser's own reading voice and previews it (*"This is how I'll sound."*); the label shows the current one. Answers are normally read by the deployment's speech service, and the voice you pick here is the fallback used when that service is unavailable or the browser blocks autoplay. Browsers with no built-in speech don't show this button at all. |
| **☰ Discussion** | Opens the Full discussion drawer. |
| **✕ Close** | Marks this conversation's ticket complete and rolls you into a new thread. A thread you have not posted to since the server last restarted stays listed under **Conversations** — send it one message first if you want it closed for good. |

## What you can do

### Ask by voice

Click **Tap to talk** (or the orb), speak, then click **Stop & send**. Your speech is transcribed
and sent as a message. If the browser refuses the microphone, the type box opens automatically —
and when you are in the docked panel you get an *open full-page* link, because browsers frequently
refuse continuous recognition inside an embedded panel even when the microphone is otherwise
allowed.

### Ask by typing

Press **⌨ Type**, write in the *Ask me anything…* box, and press **Ask** or Enter.

### Attach a photo or a document

Use **＋ Add**. Photos are shrunk in your browser and then described in words before the message is
sent, so Jarvis reasons about the description; documents are read as text. A file that cannot be
read is still attached and labeled *(couldn't read)* rather than quietly dropped, so the answer
never pretends to have seen it.

| Attachment | Limit |
|---|---|
| Total attachments on one message | 6 |
| Photos on one message | 4 |
| Photo size | resized to 1024 px on the long edge before sending |
| Text-based document (.txt, .md, .csv, .json, .log, .yml, .xml, .html…) | 2 MB, read in your browser |
| PDF or Word (.pdf, .docx) | 8 MB, extracted on the server |

A message with attachments always goes to a normal Jarvis turn — the shortcut paths described below
are skipped, so "what's in this photo?" is never mistaken for a weather question.

### Watch what happens after you ask

1. Your message is posted and the conversation shows **Thinking…**.
2. Jarvis decides: answer you directly, or write up the request as a job.
3. A job goes onto the queue with no bot named — the specialists themselves bid on it, and the one
   that owns the subject picks it up. Jarvis replies with a short acknowledgement in the meantime.
4. When the job finishes, Jarvis reads the result and re-narrates it, and the item lands in your
   **Work queue** marked **NEW**.

Some requests take a shorter, fixed route:

- **Weather, priority inbox, and Walmart product look-ups** are handed straight to the worker that
  holds the live connection, so the answer is fetched rather than remembered. You get
  *"I'll check the live weather data and report back here."* (or the inbox/Walmart equivalent), then
  the real answer. If you asked for weather without saying where, Jarvis first asks
  *"What city or ZIP code should I use for the live weather check?"* and uses your next reply.
- **Reminders — where the operator enabled the scheduler.** "Remind me on Tuesday to order flowers",
  "every weekday at 9am summarize my inbox". On a deployment running the scheduler
  (`ENABLE_AGENT_SCHEDULER=true`; it is off by default) these are read straight into a real schedule
  and confirmed on the spot, and when the reminder fires it comes back through Jarvis — with anything
  that would act outward still stopping to ask you first. With the scheduler off, Jarvis will not
  confirm a reminder it has no way to fire: the sentence falls through to an ordinary turn instead.
- **Requests spanning several apps** compile into a numbered plan, and the acknowledgement shows it:
  *Here's the plan (N steps):* with each app, in order, and any step that acts outward marked
  *(I'll ask you before this one runs)*.

### Follow work that is still running

Everything Jarvis filed for you is listed in **Work queue** and survives reloads and restarts.

| Row shows | Meaning |
|---|---|
| a spinner and a time (*just now*, *12m*, *3h*) | still queued, running, or being summarized. Clicking says *still working on that one…* |
| **NEW** | finished, and you have not heard it yet — the row is highlighted |
| **read** | finished, and you have already opened it |
| **failed** | the run stopped. Jarvis says the run did not finish and points you at the ticket rather than inventing an outcome |

When something finishes, Jarvis says *"I have your results ready for …"* and offers a **Read it ↗**
chip. You can also just say (or type):

- **"read it"** — reads the offered result, or the newest unread one.
- **"yes"** — accepts the offer immediately after Jarvis makes it.
- **"read all my backlog"** — reads every unread result, oldest first.

An opened result may also carry **Saved to your files:** download links (real files copied into your
own folder) and an **Open workspace ↗** chip into the work item.

### Get a picture instead of only words

| You ask | What you get |
|---|---|
| "show this as a timeline", "draw me a diagram" | that exact kind, built only from facts already in the written answer |
| an answer that comes back as a table, a checklist, labelled numbers, or a handful of bullet points | a matching picture assembled from the same words |
| finished background work with a live weather, priority-inbox, or Walmart-catalog reading | a picture rebuilt from the captured provider record, not from the wording |
| an ordinary conversational answer — prose with no table, list or figures in it | text and voice, no picture — this is deliberate |

Whatever appears on the stage is also saved into **Full discussion**, so you can replay the same
image later.

### Hands-free listening

The **Always listening** control turns on wake-word listening while this page is open and visible.
Behind its **⚙** are **Assistant name**, **Wake phrases**, **Recognition language**, **Keep
transcript text**, **Daily review time**, **Separate speakers with the local voice engine**,
**Remember encrypted voice profiles across conversations**, and **Spoken voice** (with **Preview**);
**Read transcript** replays a chosen day and **Review now** runs the action-item scan immediately.
Changes take effect when you press **Save settings**. Raw audio is never stored. Renaming the
assistant renames it everywhere on the page.

Once there are transcripts, you can also just ask about them — *"what did Dana say about the roof?"*,
*"how many times has she mentioned it?"* — and the count and quotes come straight out of your own
saved text rather than a model's recollection.

## What this screen does NOT do

- **Jarvis does not run your tools itself.** It converses and hands work off. You cannot pick which
  bot gets a job from this screen, and Jarvis never names one — the queue decides.
- **It will not act outward on its own.** In a multi-step plan, every step that reaches outside
  stops and asks you first, and a reminder that fires later hits the same gates.
- **Nothing here works signed out.** Every panel is per-user; the Status rail shows *Sign in to see
  status* instead of guessing.
- **A deployment can ship with no model at all.** If the operator set `OSHAL_NO_AI=true`, asking
  returns *"AI features are disabled on this deployment. Connect a model or remove
  OSHAL_NO_AI=true."* rather than a fake answer.
- **Photos need image understanding to be configured.** Without an OpenRouter credential on the
  deployment, attaching a photo answers *"No OpenRouter credential is configured for image
  understanding."* Text and documents still work.
- **Voice input can be unconfigured.** If no transcription service is set up you are told *"Voice
  input isn't set up on this deployment — type your question instead"*, rather than being left to
  blame your own diction.
- **Always-listening is not a background service.** It is off by default, it pauses when Jarvis
  speaks, when you use push-to-talk, and when the tab is hidden, and it stops when you leave the
  page. (Windows has a separate desktop wake helper for when the page is closed; that is not this
  screen.)
- **Remembering voice profiles is unavailable on guest and public sessions** — the option turns
  itself back off and says so.
- **Images inside an answer's text never load.** A model-written image link renders as an inert
  *Image link not loaded* note; only the authenticated visual stage shows pictures.
- **Diagrams drawn in an answer need the diagram library to load.** It is fetched from a public CDN,
  so on a deployment with no outbound internet — or where the content policy blocks it — the diagram
  stays as readable text rather than failing.
- **The daily transcript review proposes, it never creates.** Reminders and follow-ups it spots
  appear as suggestions you have to confirm.

## If something looks wrong

**"Microphone blocked here" inside the docked panel.** The panel is an embedded frame and browsers
often refuse continuous speech recognition there. Use the *open full-page* link in the message (or
go to `/api/jarvis/` directly), or type — the type box opens for you automatically.

**Jarvis said "That's a bigger build — I've handed it to the team" and nothing appeared.** That is
what happens when the decision turn runs long: rather than leave you waiting, the request is filed
as a job. Watch the **Work queue**; the answer arrives there and Jarvis announces it.

**A job's ticket looks finished but the row still spins.** A finished job is held as running until
Jarvis has actually read the deliverable and written the summary. It is deliberate — the row never
flips to done before there is something to tell you.

**The conversation says a result is taking unusually long.** After about five minutes the screen
stops waiting on that turn and says so. The work is not cancelled; check the **Work queue**.

**The answer was spoken but no picture appeared.** Most answers are text and voice by design. A
picture appears only in the cases in the table above, and if validation or rendering fails the
written answer is still complete and usable.

**Your old conversation is gone.** Threads are listed under **Conversations** in the rail — click
one to resume it. **✎ New** deliberately starts a separate thread, and **✕ Close** ends the current
one.

**"Rate limit exceeded for this operation; slow down."** Some deployments cap how many assistant
turns one network address may spend per minute (`OSHAL_RATE_LIMIT_EXPENSIVE=on`, off by default).
Wait a minute and ask again; nothing already running is lost.

---

For the design rationale behind the classify → delegate → synthesize flow, see
[Jarvis — architecture and flow](../architecture/jarvis-architecture-and-flow.md).
