# LinkedIn Content Swarm Workflow Design

Last updated: 2026-06-15

## Intent

Design the LinkedIn AI content assistant as a real OSHAL workflow, not a one-off chatbot. The workflow should use the queue manager, mesh dispatch, the existing email swarm capabilities, and an approval gate before anything reaches LinkedIn.

The user-facing result is a content queue:

- email and web signals come in
- the system proposes topics to comment on
- the user records or types their point of view
- the system drafts a LinkedIn-style post
- the user approves, revises, schedules, or rejects it
- only approved posts are published through LinkedIn OAuth

## Runtime Shape

### Swarm App

Target app name:

```text
linkedin-content-assistant
```

Target ticket type:

```text
linkedin-content-post
```

Target workflow:

```yaml
ticketType: linkedin-content-post
workflow:
  name: LinkedIn Content Creation Queue
  pipeline: linkedin-content
  workerBot: linkedin-content-orchestrator
  reviewerBot: queue-bot
  phases:
    - signal-intake
    - topic-selection
    - user-commentary
    - draft-generation
    - approval
    - publish
```

Current OSHAL note: app-contributed workflows are queue-routed through `WorkflowPipelineRegistry`, and the runtime dispatches app workflows as manifest-worker jobs. Multi-agent phases in the YAML are the design contract. The first executable version should use a single orchestrator worker that writes phase artifacts and requests help from other bots through mesh tasks or child tickets.

## Participating Bots

### `linkedin-content-orchestrator`

Owns the workflow state machine for a content item.

Responsibilities:

- create and update `linkedin-content-post` tickets
- request email context from the email swarm
- request research summaries
- prepare topic cards
- wait for user commentary
- invoke drafting and review steps
- move approved items to publishing
- preserve audit records

### `email-summarizer`

Existing communications bot used for read-only Gmail/email context.

Responsibilities:

- fetch or reason over connected email data
- return only emails matching a focus query, for example `LinkedIn`, `AI`, `agents`, `OpenAI`, `Anthropic`, `enterprise AI`, or a user-provided `xxxx`
- summarize email signals without exposing unnecessary private data
- identify LinkedIn notification emails, newsletters, and article links

### `email-bot`

Existing email integration bot used for outbound notifications.

Responsibilities:

- send alerts when topic cards or drafts need user action
- send daily or weekly content queue digests
- send "approval needed" reminders

### `research-bot` or `news-aggregator-bot`

Used for web discovery.

Responsibilities:

- scan the web for articles related to the user's configured focus query
- prefer primary sources where possible
- summarize article claims and attach source URLs
- flag stale, duplicate, or low-trust sources

### `writing-coach` or `pr-communications-bot`

Used for LinkedIn post drafting.

Responsibilities:

- convert user commentary into LinkedIn-style drafts
- preserve the user's point of view
- produce tone variants
- avoid spam, unsupported claims, and generic filler

### `queue-bot`

Reviewer and governance bot.

Responsibilities:

- review compliance warnings
- confirm approval requirements are satisfied
- block publishing if the item has unresolved risk

## Queue Model

Each content opportunity becomes a queue-managed ticket.

```text
ticketType: linkedin-content-post
status: approved
priority: medium
metadata:
  focusQuery: "AI agents in software delivery"
  sourceKinds: ["email", "web", "manual"]
  requestedBy: "<user-id>"
  linkedInAccountId: "<connected-account-id>"
```

The queue manager claims approved tickets, creates a workspace, and dispatches the orchestrator through the mesh. The orchestrator stores phase artifacts in the ticket workspace so every step is inspectable.

## Workflow States

| State | Meaning | Owner |
|---|---|---|
| `queued_signal_intake` | Item is waiting for email/web/manual signal collection. | queue manager |
| `email_context_requested` | Orchestrator asked email swarm for matching emails. | orchestrator |
| `research_context_requested` | Orchestrator asked research/news bot for article candidates. | orchestrator |
| `topic_review_ready` | Topic cards are ready for the user to inspect. | orchestrator |
| `awaiting_user_commentary` | User must type or record their take. | user |
| `transcribing_audio` | Audio commentary is being converted to text. | transcription service |
| `drafting_post` | Draft writer is generating LinkedIn post options. | writing bot |
| `draft_review_ready` | Drafts are available for edit/rewrite/reject. | user |
| `approval_required` | Final draft needs explicit approval before publish. | user/queue-bot |
| `approved_for_publish` | Approval record exists and publish job can run. | orchestrator |
| `publishing` | Publisher is calling LinkedIn API. | publisher |
| `published` | LinkedIn returned success and post record is stored. | publisher |
| `needs_revision` | User or reviewer requested changes. | orchestrator |
| `rejected` | User rejected the item. | user |
| `blocked` | Missing token, missing email connection, policy risk, or API error. | orchestrator |

## Mesh Handoffs

### Email Context Request

The orchestrator sends a direct mesh task to `email-summarizer`.

```json
{
  "type": "LINKEDIN_CONTENT_EMAIL_CONTEXT_REQUEST",
  "ticketType": "linkedin-content-post",
  "ticketId": "<ticket-id>",
  "workspaceTaskId": "<root-workspace-id>",
  "focusQuery": "xxxx",
  "timeWindow": "14d",
  "includeKinds": [
    "linkedin-notification",
    "ai-newsletter",
    "article-link",
    "direct-user-forward"
  ],
  "privacyMode": "metadata-and-snippets"
}
```

Expected response artifact:

```json
{
  "type": "LINKEDIN_CONTENT_EMAIL_CONTEXT_RESPONSE",
  "ticketId": "<ticket-id>",
  "signals": [
    {
      "signalId": "email:<provider-message-id>",
      "kind": "ai-newsletter",
      "from": "masked sender",
      "subject": "subject line",
      "receivedAt": "2026-06-15T13:00:00Z",
      "snippet": "short snippet",
      "urls": ["https://example.com/article"],
      "whyRelevant": "Mentions AI coding agents and enterprise adoption."
    }
  ]
}
```

Rules:

- Email bot returns signal packets, not full inbox dumps.
- Email snippets are minimized.
- Personal LinkedIn message bodies are not claimed unless the email itself contains that content.
- The email swarm does not send or reply to LinkedIn messages.

### Research Context Request

The orchestrator sends a mesh task to `research-bot` or `news-aggregator-bot`.

```json
{
  "type": "LINKEDIN_CONTENT_RESEARCH_REQUEST",
  "ticketId": "<ticket-id>",
  "focusQuery": "xxxx",
  "sourcePolicy": {
    "preferPrimarySources": true,
    "maxAgeDays": 21,
    "blockedDomains": []
  },
  "desiredCount": 10
}
```

Expected response artifact:

```json
{
  "type": "LINKEDIN_CONTENT_RESEARCH_RESPONSE",
  "ticketId": "<ticket-id>",
  "articles": [
    {
      "title": "Article title",
      "url": "https://example.com",
      "source": "Example",
      "publishedAt": "2026-06-14",
      "summary": "Short factual summary.",
      "claims": ["Claim 1", "Claim 2"],
      "discussionAngles": ["What this changes for builders", "Where this is overhyped"],
      "trustNotes": "Primary source or reputable coverage."
    }
  ]
}
```

## Topic Cards

The orchestrator merges email and web signals into topic cards.

Each topic card must include:

- title
- source links
- why it matters
- suggested angle
- suggested question for the user
- risks or uncertainty
- candidate post type
- queue action buttons

Example topic card:

```text
Title: AI agents are moving from demos into workflow queues
Why it matters: This connects directly to OSHAL's queue-managed swarm model.
Prompt: Where have you seen agents fail when they do not have state, queues, or approval gates?
Post type: Build-log / opinion
Actions: Comment by audio, Comment by text, Skip, Save, Draft neutral share
```

## User Commentary Capture

The review UI must have an audio section and a text section.

Audio requirements:

- record browser audio
- show recording state and duration
- allow playback before submission
- upload audio as a ticket artifact
- transcribe audio into editable text
- attach transcript to the content item
- preserve original audio only if the user enables retention

Text requirements:

- support rough notes
- support bullets
- support pasted context from current projects
- let user mark details as private or publishable

The post must be based on user commentary, not just the article summary.

## Drafting Flow

Inputs:

- selected topic card
- user audio transcript
- user text notes
- email signal summaries
- article summaries and links
- user voice profile
- LinkedIn account target

Outputs:

- 3 draft options
- 1 recommended version
- tone rewrites
- compliance notes
- missing-context questions if needed

Draft formats:

- short reaction post
- practical builder take
- contrarian or skeptical take
- build-log post
- question-to-network post
- article share with commentary

## Approval Gate

No post can publish until an approval record exists.

Approval record fields:

- ticket id
- draft id
- final approved text
- approver user id
- approval timestamp
- target LinkedIn account
- scheduled time or publish-now flag
- source links
- compliance status

Allowed user actions:

- approve and post now
- approve and schedule
- request rewrite
- edit manually
- reject
- save for later

## Publishing

Publishing uses the official LinkedIn OAuth-backed API.

Rules:

- Use `w_member_social` for member posts.
- Use the connected LinkedIn account selected during approval.
- Never publish via browser automation.
- Never use a LinkedIn password, cookie, or scraped session.
- If the LinkedIn token is expired or revoked, move the ticket to `blocked` with reconnect instructions.

## UI Surfaces

### Content Queue

Shows all `linkedin-content-post` tickets grouped by state:

- new signals
- needs commentary
- drafts ready
- needs approval
- scheduled
- published
- blocked

### Topic Review

Shows topic cards built from email and web signals.

Primary actions:

- record audio take
- write text take
- skip
- save for later
- create draft

### Draft Studio

Shows:

- source topic
- transcript and notes
- draft variants
- rewrite controls
- compliance warnings
- final editable post body

### Approval Queue

Shows:

- final post preview
- LinkedIn account
- schedule/publish controls
- approval audit details

## Workspace Artifacts

Each ticket workspace should contain:

```text
TASK-BRIEF.md
SIGNALS/email-context.json
SIGNALS/research-context.json
TOPICS/topic-cards.json
COMMENTARY/audio/<recording-id>.webm
COMMENTARY/transcript.md
DRAFTS/draft-options.md
REVIEW/compliance-review.md
APPROVAL/approval-record.json
PUBLISH/publish-result.json
```

## Data Model Additions

Minimum tables or equivalent persisted records:

- `linkedin_content_items`
- `linkedin_content_signals`
- `linkedin_topic_cards`
- `linkedin_commentary_artifacts`
- `linkedin_post_drafts`
- `linkedin_post_approvals`
- `linkedin_published_posts`

These can begin as ticket metadata plus workspace artifacts, then move to dedicated tables once the workflow stabilizes.

## Queue Creation Triggers

### Manual Topic

User enters a topic such as `AI agents for enterprise workflow queues`.

Creates one `linkedin-content-post` ticket.

### Scheduled Discovery

Cron or scheduler runs a configured focus query.

Creates one parent discovery ticket and child content tickets for high-value topic cards.

### Email Signal

Email monitor detects a LinkedIn notification, AI newsletter, or forwarded article matching `xxxx`.

Creates or updates a content ticket.

### Web Signal

Research scan finds a strong article.

Creates or updates a content ticket.

## MVP Execution Plan

### Phase 1: Queue-backed Manual Flow

- Create `linkedin-content-post` ticket manually.
- Orchestrator creates topic card from manual URL/topic.
- User adds text commentary.
- Draft options are generated.
- User approves.
- Publishing is stubbed or manual until LinkedIn OAuth is wired.

### Phase 2: Email Mesh Context

- Orchestrator requests matching email context from `email-summarizer`.
- Email signals become topic cards.
- `email-bot` sends action-needed alerts.

### Phase 3: Audio Commentary

- Add audio recorder UI.
- Store audio as workspace artifact.
- Transcribe and attach transcript.
- Drafts use transcript as primary opinion source.

### Phase 4: Web Research

- Add source configuration.
- Research bot returns article candidates.
- Topic cards merge email and web context.

### Phase 5: LinkedIn Publish

- Add LinkedIn OAuth connection.
- Add final approval record.
- Publish approved text posts through official LinkedIn API.

## Acceptance Criteria

- Creating a content opportunity creates a `linkedin-content-post` ticket visible in the queue.
- Queue manager dispatches the ticket to `linkedin-content-orchestrator`.
- Orchestrator can request email context through the mesh using a focus query.
- Email context is reduced to relevant signal packets.
- The UI shows topic cards with "comment by audio" and "comment by text" actions.
- Audio commentary is transcribed and attached to the ticket.
- Drafts are generated from the user's commentary and source context.
- A draft cannot publish unless an approval record exists.
- Publishing uses LinkedIn OAuth and never browser automation.
- All workflow artifacts are inspectable in the ticket workspace.
