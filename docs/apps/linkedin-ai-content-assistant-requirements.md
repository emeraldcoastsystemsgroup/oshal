# LinkedIn AI Content Assistant Requirements

Last updated: 2026-06-15

## Purpose

Build an AI-assisted LinkedIn workflow that helps a user grow relevant visibility around AI by finding timely article ideas, eliciting the user's point of view, drafting original LinkedIn posts, and publishing only after explicit approval.

The assistant should help the user talk about what they are building, learning, and thinking about in AI. It should not pretend to be the user without review, scrape LinkedIn, or automate private LinkedIn messages.

## Product Goals

- Help the user publish consistent, relevant LinkedIn posts about AI, agents, automation, OSHAL, software delivery, and related work.
- Surface useful web articles and ask the user for their take before drafting a post.
- Convert the user's raw notes, projects, experiments, and reactions into LinkedIn-ready posts.
- Notify the user when LinkedIn-related email signals arrive, such as new message alerts or engagement notifications.
- Keep LinkedIn access compliant by using OAuth and approved API products only.

## Non-Goals

- Do not read or send personal LinkedIn direct messages through unauthorized APIs, cookies, browser automation, or scraping.
- Do not store LinkedIn usernames or passwords.
- Do not auto-reply to LinkedIn messages.
- Do not mass-message, mass-connect, scrape profiles, or build lead lists.
- Do not publish posts without an explicit user approval event.
- Do not copy article text into posts beyond short attributed references.

## LinkedIn Access Model

### Required LinkedIn Products

- Sign In with LinkedIn using OpenID Connect
- Share on LinkedIn

### Required OAuth Scopes

- `openid`
- `profile`
- `email`
- `w_member_social`

### Allowed Capabilities

- Authenticate a LinkedIn member.
- Retrieve basic member identity from LinkedIn OIDC claims.
- Publish member posts through LinkedIn's approved posting API after user approval.
- Create text posts, URL/article shares, and later image posts if media upload support is implemented.

### Restricted Capabilities

- Personal LinkedIn inbox read/write is not part of the normal open API product set.
- Message awareness must use safe fallbacks, such as user-authorized email notification monitoring.
- Any future LinkedIn messaging integration must require explicit LinkedIn partner/restricted API approval before implementation.

## Core User Workflow

1. User connects their LinkedIn account through OAuth.
2. User configures topics, voice, preferred sources, and posting cadence.
3. System scans configured web sources for relevant AI articles and trends.
4. System scores and clusters candidate articles.
5. System asks the user targeted questions about high-value candidates.
6. User responds with thoughts, experiences, agreement, disagreement, or examples.
7. System drafts one or more LinkedIn post options.
8. System performs a quality and compliance review.
9. User edits, rejects, schedules, or approves the draft.
10. System publishes approved content through LinkedIn OAuth.
11. System records the published post and optionally prompts for follow-up ideas.

## Swarm Workflow Requirement

This feature must be implemented as a queue-backed swarm workflow, not only as a direct chat action.

The target workflow is `linkedin-content-post`, owned by a `linkedin-content-orchestrator` worker. Each content opportunity should become a ticket that the queue manager can claim, inspect, retry, pause, approve, or mark blocked.

The orchestrator must connect over the mesh with the existing email swarm:

- use `email-summarizer` for read-only email context matching a user-defined focus query such as `xxxx`
- use `email-bot` for outbound action-needed alerts and approval reminders
- use research/news agents for web article candidates
- use writing/review agents for draft generation and compliance review

The content review surface must include both a text commentary area and an audio commentary section. User commentary is the primary source for the final post. Article summaries and email signals provide context, but the system must ask for the user's view before creating a publishable draft.

Detailed architecture: [architecture/linkedin-content-swarm-workflow.md](../architecture/linkedin-content-swarm-workflow.md).

## Functional Requirements

### Account Connection

- LI-001: The system must let a user connect a LinkedIn account through OAuth Authorization Code Flow.
- LI-002: The system must request the minimum scopes required for the current feature set.
- LI-003: The system must store access tokens encrypted at rest.
- LI-004: The system must never store a LinkedIn password, session cookie, or browser fingerprint.
- LI-005: The system must show LinkedIn connection status, granted scopes, token expiry when known, and reconnect actions.
- LI-006: The system must support disconnecting a LinkedIn account and deleting stored tokens.
- LI-007: The system must handle expired or revoked LinkedIn tokens by requiring reauthorization.

### Topic and Voice Configuration

- LI-010: The user must be able to configure target topics, including AI agents, coding agents, automation, LLM apps, software architecture, enterprise AI, security, data privacy, and OSHAL-related work.
- LI-011: The user must be able to configure avoided topics, sensitive topics, and sources to ignore.
- LI-012: The user must be able to define voice preferences, such as direct, curious, technical, founder-style, reflective, skeptical, or practical.
- LI-013: The user must be able to save recurring content lanes, such as "what I built", "what I learned", "article reaction", "technical breakdown", "hot take", "question to network", and "weekly build log".
- LI-014: The system must maintain a lightweight profile of user opinions, recurring themes, and preferred wording based only on approved or user-provided material.

### Web and Article Scanning

- LI-020: The system must scan configured web sources for AI-related articles on a scheduled cadence.
- LI-021: The system must support source types including RSS feeds, curated URLs, search queries, newsletters forwarded by email, and manually pasted links.
- LI-022: Each article candidate must include title, source, URL, author when available, publish date when available, discovered date, summary, topic tags, and relevance score.
- LI-023: The system must deduplicate articles by canonical URL, normalized title, and semantic similarity.
- LI-024: The system must score candidates by relevance to the user's topics, recency, source quality, novelty, and discussion potential.
- LI-025: The system must flag uncertain claims and prefer primary sources when available, such as official company posts, research papers, standards documents, or original announcements.
- LI-026: The system must not generate posts from article headlines alone when the claim is specific or potentially controversial.
- LI-027: The system must keep a source allowlist and blocklist.
- LI-028: The system must retain article metadata and short summaries, not full copyrighted article bodies unless the source license allows it.

### Thought Elicitation

- LI-030: For each strong article candidate, the system must ask the user for their point of view before creating a publishable post.
- LI-031: The system must ask concise questions, usually 1 to 4 prompts per article.
- LI-032: Questions should draw out the user's lived context, such as "Where have you seen this show up in your own AI work?" or "Do you agree with this claim?"
- LI-033: The user must be able to answer in rough notes, voice transcript, bullet points, or pasted context.
- LI-034: The system must support "skip", "save for later", "not my lane", and "draft anyway as a neutral share" actions.
- LI-035: The system must attach the user's responses to the content draft as source material.
- LI-036: The system must provide an audio commentary control for recording the user's take on a topic.
- LI-037: The system must transcribe audio commentary and let the user edit the transcript before drafting.
- LI-038: The system must let the user mark commentary details as private or publishable before draft generation.

### Draft Generation

- LI-040: The system must generate original LinkedIn post drafts from user thoughts, article metadata, and project context.
- LI-041: The system must support multiple draft formats: short post, long-form post, article reaction, build log, lesson learned, question post, carousel outline, and poll.
- LI-042: Drafts must include a clear hook, main insight, concrete detail, and optional conversation prompt.
- LI-043: Drafts must avoid fake certainty, invented metrics, fake personal stories, and claims not supported by the source material.
- LI-044: Drafts must attribute linked articles when they materially influence the post.
- LI-045: Drafts must avoid engagement bait, spammy hashtags, excessive self-promotion, and automated-message vibes.
- LI-046: Drafts must preserve the user's voice and make it clear when the post is opinion, observation, or firsthand experience.
- LI-047: The system must provide at least one "more direct", "more technical", or "more casual" rewrite option.
- LI-048: The system must support saving reusable snippets, phrases, and content angles.

### Human Approval

- LI-050: The system must require explicit approval before publishing any LinkedIn post.
- LI-051: The approval screen must show the final post body, article link, visibility, target account, scheduled time, and any media.
- LI-052: The user must be able to edit the final text before approval.
- LI-053: The system must record approval timestamp, approver identity, post version, and target account.
- LI-054: The system must block publishing if the draft has unresolved compliance warnings.
- LI-055: The system must support "approve and post now" and "approve and schedule".

### Publishing

- LI-060: The system must publish approved posts through LinkedIn's official OAuth-backed API.
- LI-061: The system must support text-only posts for MVP.
- LI-062: The system should support URL/article shares after MVP if the LinkedIn API account has the required access.
- LI-063: The system should support image posts after media upload handling is implemented.
- LI-064: The system must store the LinkedIn post ID or response identifier when LinkedIn returns one.
- LI-065: The system must show clear errors for invalid scopes, expired tokens, rate limits, and rejected API requests.
- LI-066: The system must never fall back to browser automation when the API call fails.
- LI-067: If native LinkedIn scheduling is unavailable, the system must schedule internally and publish at the chosen time using a still-valid token.

### Email-Based LinkedIn Notifications

- LI-070: The system must support an opt-in email notification monitor as the safe fallback for personal LinkedIn message awareness.
- LI-071: The user must explicitly connect an email account or configure a forwarding address before email monitoring starts.
- LI-072: The monitor must only process emails matching configured LinkedIn sender domains, subjects, labels, or forwarding rules.
- LI-073: The system must detect likely LinkedIn events from email notifications, including new message alert, connection request, comment, mention, reaction, repost, profile view digest, and newsletter/article engagement.
- LI-074: The system must deduplicate repeated LinkedIn notification emails.
- LI-075: The system must create a notification event with event type, sender email, subject, received time, extracted LinkedIn actor name when available, LinkedIn URL when available, and short preview when available.
- LI-076: The system must not claim it has read the LinkedIn message unless the email notification actually includes the message content.
- LI-077: The system must not auto-reply to LinkedIn messages based on email notifications.
- LI-078: The system may draft a suggested response for the user, but the user must send it manually in LinkedIn unless future approved messaging API access exists.
- LI-079: The system must support urgent alerts for new message notifications and daily digests for lower-priority engagement.
- LI-080: The system must let the user choose notification channels, including in-app, outbound email, and future SMS/push integrations.
- LI-081: The system must include unsubscribe, pause, and quiet-hours controls.
- LI-082: The system must redact or minimize personal data in logs.

### Content Calendar

- LI-090: The system must show drafts, scheduled posts, published posts, skipped articles, and pending thought prompts in one calendar/work queue.
- LI-091: The user must be able to set a target cadence, such as 3 posts per week.
- LI-092: The system must warn when too many similar posts are scheduled close together.
- LI-093: The system must support follow-up prompts after high-interest posts, such as "turn this into a thread of related ideas" or "write the practical version".

### Swarm Queue

- LI-110: Each content opportunity must be represented as a `linkedin-content-post` ticket or equivalent queue item.
- LI-111: Queue items must preserve source signals, user commentary, drafts, approval status, publish status, and errors.
- LI-112: The queue must expose states for signal intake, topic review, awaiting commentary, drafting, approval required, scheduled, published, rejected, and blocked.
- LI-113: The orchestrator must request email context through mesh handoff instead of directly reading email internals when an email bot already owns that capability.
- LI-114: The workflow must be resumable after the user pauses, records audio later, requests revision, or reconnects LinkedIn.
- LI-115: The approval queue must be visible separately from raw topic discovery so publishable items are easy to review.

### Analytics

- LI-100: MVP analytics may be manually entered or based on data returned by available LinkedIn APIs.
- LI-101: The system must track post topic, format, source article, approval path, publish time, and known performance metrics.
- LI-102: The system should learn which topics and formats perform well for the user.
- LI-103: The system must not scrape LinkedIn analytics pages.
- LI-104: If analytics API access is unavailable, the system should support manual metric entry.

## Data Requirements

### Main Entities

- `LinkedInAccount`: user id, LinkedIn subject/member id, display name, email, scopes, token reference, connection status.
- `SourceProfile`: source type, URL/query/feed, trust tier, enabled flag, topic tags.
- `ArticleCandidate`: title, URL, canonical URL, source, author, published date, discovered date, summary, tags, score, status.
- `ThoughtPrompt`: article id, question text, answer, answer source, created date, answered date.
- `ContentDraft`: draft body, source article ids, user thought ids, format, tone, compliance status, version history.
- `ApprovalRecord`: draft id, approver id, approved body, approved time, schedule time, target account.
- `PublishedPost`: LinkedIn account id, post id, published URL when available, published time, source draft id, status.
- `EmailSignal`: email account id, provider message id, subject, sender, received time, extracted event type, LinkedIn URL, dedupe key.
- `NotificationEvent`: event type, priority, payload, delivery channel, delivery status, user acknowledgement.

## Agent Responsibilities

### Research Scout

- Runs web scans.
- Deduplicates and scores article candidates.
- Flags primary sources and questionable claims.

### Interviewer

- Converts candidate articles into short prompts for the user.
- Captures the user's thoughts and follow-up notes.

### Draft Writer

- Produces LinkedIn-ready post options using the user's voice.
- Generates rewrites for tone and format.

### Compliance Reviewer

- Checks for unsupported claims, unsafe LinkedIn automation, private data leakage, copyright risk, and missing attribution.
- Blocks drafts that should not be published.

### Publisher

- Publishes only approved posts through LinkedIn OAuth.
- Records API responses and publishing errors.

### Notification Monitor

- Watches connected or forwarded email for LinkedIn notification signals.
- Creates alerts and digests without attempting to access LinkedIn messages directly.

## Security and Privacy Requirements

- Tokens must be encrypted at rest and never exposed to frontend logs.
- Email bodies must be minimized; store metadata and short extracted previews only when needed.
- User can delete connected accounts, drafts, prompts, article history, email signals, and published-post records.
- System logs must not contain OAuth tokens, email content, LinkedIn private URLs with sensitive parameters, or full message bodies.
- Admin/debug views must mask tokens and personal identifiers.
- Any generated post based on private project context must pass a confidentiality check before approval.

## MVP Scope

### In Scope

- LinkedIn OAuth connection.
- Manual or scheduled article discovery using RSS/search/manual URLs.
- Article scoring and queue.
- User thought prompts.
- Draft generation.
- Human approval workflow.
- Text-only LinkedIn publishing through `w_member_social`.
- Email notification monitor for LinkedIn notification emails.
- In-app and outbound email alerts for new LinkedIn email signals.
- Content calendar for drafts, scheduled posts, and published posts.
- Queue-backed `linkedin-content-post` workflow with topic review, audio commentary, drafting, approval, and publishing states.

### Out of Scope for MVP

- Personal LinkedIn inbox API access.
- Auto-replies to LinkedIn messages.
- Browser automation against LinkedIn.
- LinkedIn profile scraping.
- Automated connection requests.
- Paid ad management.
- Company Page management.
- Advanced analytics unless approved API access is already available.

## Future Scope

- Image generation and image-post publishing.
- Carousel outline generation.
- Company Page posting through Community Management API if approved.
- Team approval workflows.
- A/B style learning from post performance.
- Mobile push notifications.
- CRM capture from manually approved LinkedIn interactions.
- Approved restricted messaging API integration if LinkedIn grants access.

## Acceptance Criteria

- A user can connect LinkedIn using OAuth without sharing a password.
- The system can discover at least 10 relevant AI article candidates from configured sources.
- The user can answer thought prompts attached to an article candidate.
- The system can create at least 3 distinct LinkedIn post drafts from the user's thoughts.
- The user can approve a draft and publish it to LinkedIn through the official API.
- The system never publishes without an approval record.
- The system can detect a LinkedIn notification email and create a notification event.
- The system can alert the user that a LinkedIn email notification arrived without claiming direct LinkedIn inbox access.
- The system can create a queue-visible `linkedin-content-post` item from a manual topic, email signal, or article candidate.
- The system can record or ingest user audio commentary, transcribe it, and attach it to a draft.
- The user can pause or disconnect LinkedIn and email monitoring.
- Logs and stored records do not expose OAuth tokens, email credentials, or full private message bodies.

## Open Questions

- Which email provider should be supported first: Gmail, Microsoft 365, generic IMAP, or forwarding-only?
- Should outbound alerts go through the existing email bot runtime, a new notification service, or both?
- What default source list should seed AI article discovery?
- Should the first version post only for the owner account, or support multiple connected LinkedIn members?
- What cadence should the assistant optimize for: daily lightweight posts, 3 strong posts per week, or a weekly essay-style cadence?
- Should drafts be stored as internal tickets/work items in OSHAL or in a dedicated content table?
- Should the assistant ask for thoughts in chat, email, or a dedicated content review screen first?

## Implementation Milestones

### Milestone 1: Foundations

- Add LinkedIn OAuth configuration.
- Store connected-account metadata and encrypted tokens.
- Add reconnect and disconnect flows.

### Milestone 2: Research Queue

- Add source configuration.
- Ingest RSS/search/manual URL candidates.
- Score, deduplicate, and summarize article candidates.

### Milestone 3: Thought Capture and Drafting

- Generate prompts from article candidates.
- Capture user responses.
- Generate drafts and rewrites.
- Add compliance review.

### Milestone 4: Approval and Publishing

- Build approval screen or workflow.
- Publish approved text posts through LinkedIn.
- Store published-post records and publishing errors.

### Milestone 5: Email Notifications

- Connect or forward email notifications.
- Detect LinkedIn notification types.
- Create notification events.
- Send urgent alerts and daily digests.

### Milestone 6: Calendar and Feedback Loop

- Add content calendar.
- Track post status and manual performance metrics.
- Recommend follow-up topics based on published posts and user preferences.
