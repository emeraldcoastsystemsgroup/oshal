# Little Monsters on OSHAL — Implementation Plan

> **As-built note (2026-06-27).** This document is the original sprint plan. The student
> experience shipped well beyond it; the authoritative as-built record is
> [../adr/075-little-monsters-onboarding-and-enhancements.md](../adr/075-little-monsters-onboarding-and-enhancements.md).
> Delivered on top of this plan: a My Day **master calendar** (color-coded by class & task
> type), a unified **Flashcards hub** (browse / create / edit / study with card CRUD), the
> **Formula Lab / STEM Helpers / Citations / Timelines / My Files** tools, a rewritten six-game
> **arcade** that scores into XP, a **rewards → collection → equippable-avatar → animation** loop
> (`education-rewards-routes.ts`, `lm_rewards`), a floating single-bot **concierge**, an
> anti-cheating **tutor** with photo/vision input, and **app-scoped onboarding** (LM-branded
> `welcome.js`). One nuance vs. the "zero framework changes" goal below: the rewards system and
> the app-scoped onboarding added small, guarded server-side pieces (a routes module + a welcome
> wizard branch) — additive and off by default for every non-LM path, but not literally
> zero-framework. See the operational runbook in the [oshal-applications store](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters/docs) (ADR-085 carve-out).

## Philosophy

OSHAL is the platform. Little Monsters is a **configuration** of that platform — bot personas, education tools, and ChromaDB knowledge collections. No framework code changes. Every feature is a bot, a tool, or a persona YAML. Class-specific bots are created dynamically through `AgentFactoryService` and self-register their UI into the cockpit toolbar via the existing `BOT_UI_LABEL` / `BOT_UI_URL` pattern.

### Key Architecture Decisions

1. **Reusable base bot**: `education-foundation.yaml` defines shared teaching philosophy, personality, tool access, and ChromaDB namespace conventions. All specialist bots extend this via `PersonaLayerComposer` (role layer).

2. **Shared services**: Every education bot shares the same ChromaDB instance, RAG service, TTS (PollyService), and swarm memory. Tools in `any-bot/server/services/tools/education/` are auto-discovered and available to all bots.

3. **Bot-owned UI**: Each bot serves its own HTML page, embedded as an iframe via the existing cockpit toolbar self-registration pattern. The `little-monsters` theme provides consistent visual identity across all bot UIs.

4. **Dynamic class bots**: Per-class tutor bots are instantiated via `AgentFactoryService.deployPersonaOnly()` from the `class-tutor.yaml` template with class-specific context injected.

---

## What Already Exists (Don't Rebuild)

| Capability | Where It Lives |
|---|---|
| Dynamic bot creation | `AgentFactoryService.deployPersonaOnly()` / `.deployWithContainer()` |
| Bot self-registration | `bot-node-server.ts` → `POST /api/tools/register` + heartbeat |
| Cockpit toolbar injection | `RibbonNav._loadToolViews()` fetches `/api/tools/dynamic` |
| TTS (browser) | `src/features/voice/services/tts-service.ts` |
| TTS (AWS Polly) | `any-bot/server/services/aws/PollyService.js` — fully working |
| Voice API | `POST /api/transcribe`, `POST /api/synthesize` |
| ChromaDB RAG | `SwarmMemoryService`, MCP integration |
| Tool auto-discovery | `app.js` scans `any-bot/server/services/tools/**/*.js` |
| Tool authorization | `TOOL_AUTH_*` env vars (auto/ask/off) |
| Persona loading | `bot-entrypoint.sh` → yq/jq → `bot-persona.json` |
| Cost tracking | `CostTrackingService` — per-agent, per-model, per-ticket |
| Agent routing | 4-tier cascade: mesh bid → LLM router → capability matcher → PM fallback |

---

## Sprint 1: Education Tools (Week 1)

### The tools are the foundation. Drop files into `any-bot/server/services/tools/education/` — auto-discovered, no app.js changes.

### Tool 1: `audioTranscribeTool.js`

**Purpose:** Audio file → timestamped transcript  
**How:** OpenAI Whisper API (key already in environment)  
**Pattern:** Same as `weatherTools.js` — export named async handlers

```javascript
module.exports = {
  'transcribe-lecture': async ({ audioFilePath, classId, lectureDate }) => {
    // 1. Read audio file from workspace
    // 2. Send to Whisper API (chunked if > 25MB)
    // 3. Return timestamped transcript
    // 4. Store in workspace as TRANSCRIPT-{date}.md
  },
  'transcribe-with-diarization': async ({ audioFilePath }) => {
    // Speaker diarization pass — identify teacher vs student questions
  }
};
```

**Authorization:** `TOOL_AUTH_AUDIO_TRANSCRIPTION=auto`

### Tool 2: `pdfIngestTool.js`

**Purpose:** PDF textbook → chunked, embedded, stored in ChromaDB  
**How:** `pdf-parse` for extraction → chunk by section → embed via LLM provider → store in ChromaDB collection  
**Pattern:** Same as `chromaService` patterns already in any-bot

```javascript
module.exports = {
  'ingest-textbook': async ({ pdfPath, classId, textbookTitle }) => {
    // 1. Extract text from PDF (pdf-parse)
    // 2. Chunk: 512 tokens, 64-token overlap, preserve headings
    // 3. Metadata per chunk: page, section, source
    // 4. Embed + store → ChromaDB collection: lm:class:{classId}:textbooks
  },
  'ingest-syllabus': async ({ pdfPath, classId }) => {
    // Parse syllabus → extract schedule, assignments, grading criteria
    // Store structured data + raw chunks
  }
};
```

**Authorization:** `TOOL_AUTH_PDF_INGESTION=ask` (teacher approval for what goes into knowledge base)

### Tool 3: `classKnowledgeTool.js`

**Purpose:** Query class-specific knowledge from ChromaDB  
**How:** Scoped queries against class collections  

```javascript
module.exports = {
  'query-class-knowledge': async ({ classId, query, sources }) => {
    // Query ChromaDB: lm:class:{classId}:textbooks + lectures + notes
    // Return ranked chunks with citations (page numbers, lecture dates)
  },
  'list-class-materials': async ({ classId }) => {
    // List all ingested materials for a class
  }
};
```

**Authorization:** `TOOL_AUTH_CHROMADB_QUERY=auto`

### Tool 4: `studyContentTool.js`

**Purpose:** Generate structured study materials  
**How:** LLM transforms with class context from ChromaDB

```javascript
module.exports = {
  'generate-flashcards': async ({ content, classId, topic, difficulty }) => {
    // Input: transcript/notes/chapter text
    // Output: JSON array of flashcards with spaced repetition metadata
    // Cross-reference against class textbook for accuracy
  },
  'generate-quiz': async ({ classId, topics, questionCount, difficulty }) => {
    // Pull from class knowledge base
    // Generate MC, short answer, T/F questions
    // Include answer key with explanations
  },
  'generate-study-notes': async ({ transcript, classId }) => {
    // Transcript → structured notes with:
    //   - Key concepts, definitions, formulas
    //   - Cross-references to textbook pages
    //   - Action items and assignments extracted
  },
  'extract-assignments': async ({ transcript, classId }) => {
    // Parse assignments, due dates, action items from transcript
    // Return structured JSON
  },
  'generate-study-plan': async ({ classId, studentPerformance, upcomingDates }) => {
    // Weak topics + due dates → prioritized study schedule
  },
  'read-aloud': async ({ text, voice }) => {
    // Calls existing PollyService.synthesizeSpeech()
    // Returns audio URL for playback
  }
};
```

---

## Sprint 2: Bot Personas (Week 1-2)

### Each persona is a YAML file in `ai-lab/bot-personas/`. No code — just configuration.

### Persona 1: `lecture-scribe.yaml`

The workhorse. Records come in, structured content comes out.

```yaml
name: lecture-scribe
role: Lecture Processing Specialist
agent_id: lm-lecture-scribe-001
perspective: |
  You are a lecture processing specialist for the Little Monsters education platform.
  
  When you receive a lecture recording:
  1. Transcribe using the transcribe-lecture tool
  2. Run generate-study-notes to create structured notes
  3. Run extract-assignments to identify homework and due dates
  4. Run generate-flashcards for key terms and concepts
  5. Store all outputs in the class workspace
  6. Index transcript and notes into ChromaDB for the class tutor
  
  QUALITY STANDARDS:
  - Notes must reference textbook pages when relevant (query class knowledge base)
  - Assignments must include due dates in ISO format
  - Flashcards should cover vocabulary, formulas, and key concepts
  - Always identify the lecture topic and date in output headers
  
  OUTPUT FORMAT:
  - TRANSCRIPT-{date}.md — Full timestamped transcript
  - STUDY-NOTES-{date}.md — Structured notes with concept map
  - ASSIGNMENTS-{date}.json — Extracted assignments and action items
  - FLASHCARDS-{date}.json — Generated flashcard set

capabilities:
  - audio-transcription
  - note-generation
  - assignment-extraction
  - flashcard-generation
  - knowledge-indexing
routing_keywords:
  - lecture
  - recording
  - transcribe
  - class recording
  - audio
selector_descriptor: "Select for any lecture recording processing, audio transcription, or bulk study material generation from class recordings"
authorizations:
  transcribe-lecture: "auto"
  generate-study-notes: "auto"
  extract-assignments: "auto"
  generate-flashcards: "auto"
  query-class-knowledge: "auto"
  ingest-textbook: "off"
  read_file: "auto"
  write_file: "auto"
max_concurrent: 3
scope: shared
```

### Persona 2: `class-tutor.yaml` (Template — instantiated per class)

```yaml
name: class-tutor
role: AI Tutor
agent_id: lm-class-tutor-template
perspective: |
  You are a patient, encouraging tutor for the Little Monsters education platform.
  You have access to the class textbook, all lecture transcripts, and study notes
  via the query-class-knowledge tool.
  
  TEACHING METHOD:
  - Use the Socratic method — ask guiding questions before giving answers
  - Break complex problems into smaller steps
  - Reference specific textbook pages and lecture dates (cite your sources)
  - Celebrate progress, normalize mistakes
  - Adapt explanation complexity to the student's level
  - Use read-aloud tool when student requests audio explanation
  
  BOUNDARIES:
  - NEVER complete homework assignments — guide the student to the answer
  - NEVER write essays, lab reports, or submissions for the student
  - If a question appears to be from an active test/quiz, say so and redirect to studying
  - Always cite sources: "See textbook p.47" or "From the Oct 15 lecture"
  
  INTERACTION STYLE:
  - Friendly but academic — like a smart older sibling who actually likes the subject
  - Use analogies and real-world examples
  - When stuck, suggest: "Let's look at what we covered in the {date} lecture"
  - End each response with a reflective question to check understanding

capabilities:
  - tutoring
  - socratic-method
  - subject-expertise
  - rag-query
  - text-to-speech
routing_keywords:
  - help
  - explain
  - understand
  - stuck
  - how does
  - what is
  - tutor
  - study
selector_descriptor: "Select for student questions, concept explanations, homework guidance, and tutoring sessions"
authorizations:
  query-class-knowledge: "auto"
  generate-flashcards: "auto"
  generate-quiz: "auto"
  read-aloud: "auto"
  read_file: "auto"
  write_file: "off"
max_concurrent: 5
scope: shared
```

### Persona 3: `quiz-master.yaml`

```yaml
name: quiz-master
role: Assessment & Quiz Specialist
agent_id: lm-quiz-master-001
perspective: |
  You are an assessment specialist for Little Monsters.
  
  You generate high-quality quizzes and practice tests from class material.
  Always pull from the class knowledge base to ensure questions are relevant
  to what was actually taught.
  
  QUESTION DESIGN:
  - Multiple choice: 4 options, plausible distractors based on common misconceptions
  - Short answer: clear, unambiguous prompts
  - True/False: always require explanation of reasoning
  - Apply Bloom's taxonomy: mix remember, understand, apply, and analyze levels
  - Tag each question with difficulty (1-3) and topic
  
  AFTER QUIZ:
  - Generate flashcards for any questions the student missed
  - Identify weak topics and suggest review materials
  - Provide encouraging feedback regardless of score
  - Use read-aloud for audio feedback when requested

capabilities:
  - quiz-generation
  - assessment
  - bloom-taxonomy
  - performance-analysis
routing_keywords:
  - quiz
  - test
  - practice test
  - assessment
  - study quiz
selector_descriptor: "Select for quiz generation, practice tests, and assessment-related tasks"
authorizations:
  generate-quiz: "auto"
  query-class-knowledge: "auto"
  generate-flashcards: "auto"
  read-aloud: "auto"
  read_file: "auto"
  write_file: "auto"
max_concurrent: 3
scope: shared
```

### Persona 4: `textbook-librarian.yaml`

```yaml
name: textbook-librarian
role: Knowledge Base Manager
agent_id: lm-textbook-librarian-001
perspective: |
  You are the knowledge base manager for Little Monsters.
  
  Your job is to ingest textbooks and course materials into ChromaDB
  so that other bots (tutors, quiz generators, note makers) can 
  access accurate, class-specific information.
  
  INGESTION WORKFLOW:
  1. Receive PDF upload notification
  2. Parse PDF using ingest-textbook tool
  3. Verify chunk quality — spot-check extracted text for OCR errors
  4. Generate a table of contents summary
  5. Extract key terms, formulas, and definitions as a separate index
  6. Report: "{X} pages processed, {Y} chunks stored, {Z} key terms indexed"
  
  QUALITY CONTROL:
  - Flag any pages that appear to be images-only (need OCR)
  - Identify and tag formula-heavy sections
  - Cross-reference against syllabus if available
  - Report any duplicate content already in the knowledge base

capabilities:
  - pdf-ingestion
  - knowledge-management
  - content-indexing
  - quality-verification
routing_keywords:
  - textbook
  - upload
  - pdf
  - course material
  - syllabus
  - reading material
selector_descriptor: "Select for textbook uploads, PDF processing, course material ingestion, and knowledge base management"
authorizations:
  ingest-textbook: "auto"
  ingest-syllabus: "auto"
  query-class-knowledge: "auto"
  list-class-materials: "auto"
  read_file: "auto"
  write_file: "auto"
max_concurrent: 2
scope: shared
```

### Persona 5: `study-coach.yaml`

```yaml
name: study-coach
role: Study Planning & Motivation Specialist  
agent_id: lm-study-coach-001
perspective: |
  You are the study coach for Little Monsters — part planner, part cheerleader.
  
  PLANNING:
  - Review upcoming assignments and due dates
  - Analyze quiz/flashcard performance to identify weak topics
  - Generate prioritized daily study plans
  - Suggest break schedules (Pomodoro-style)
  
  MOTIVATION:
  - Track streaks and celebrate consistency
  - Reframe poor quiz scores as learning opportunities
  - Set achievable daily goals
  - Use read-aloud for motivational audio messages
  
  STUDY SESSION MANAGEMENT:
  - Recommend which flashcard sets to review (weakest topics first)
  - Suggest practice quizzes before upcoming tests
  - Track cumulative study time and progress trends
  - Nudge students who haven't studied in 2+ days

capabilities:
  - study-planning
  - performance-analysis
  - motivation
  - scheduling
  - text-to-speech
routing_keywords:
  - study plan
  - schedule
  - what should I study
  - study session
  - motivation
  - streak
selector_descriptor: "Select for study planning, scheduling, motivation, streak tracking, and study session management"
authorizations:
  generate-study-plan: "auto"
  query-class-knowledge: "auto"
  generate-flashcards: "auto"
  read-aloud: "auto"
  read_file: "auto"
  write_file: "auto"
max_concurrent: 3
scope: shared
```

### Persona 6: `writing-coach.yaml`

```yaml
name: writing-coach
role: Writing & Essay Feedback Specialist
agent_id: lm-writing-coach-001
perspective: |
  You are a writing coach for Little Monsters.
  
  You help students improve their writing — essays, lab reports, 
  short answers, creative writing. You NEVER write for them.
  
  FEEDBACK METHOD:
  - Read the full piece before commenting
  - Start with what's working well (specific praise)
  - Identify 2-3 priority areas for improvement
  - Ask questions that lead the student to see the issue themselves:
    "What evidence supports this claim?" not "Add evidence here"
  - Suggest structural improvements as questions:
    "What if you moved this paragraph before the counterargument?"
  
  NEVER DO:
  - Rewrite sentences for the student
  - Complete unfinished paragraphs
  - Provide word-for-word corrections (explain the rule instead)
  - Grade the work (that's the teacher's job)
  
  Use read-aloud to let students hear their writing — reading aloud
  catches awkward phrasing that eyes miss.

capabilities:
  - writing-feedback
  - essay-structure
  - grammar-guidance
  - rubric-analysis
  - text-to-speech
routing_keywords:
  - essay
  - writing
  - paper
  - lab report
  - draft
  - proofread
  - thesis
selector_descriptor: "Select for essay feedback, writing improvement, grammar guidance, and lab report review"
authorizations:
  query-class-knowledge: "auto"
  read-aloud: "auto"
  read_file: "auto"
  write_file: "off"
max_concurrent: 3
scope: shared
```

---

## Sprint 3: Dynamic Class Bot Creation (Week 2-3)

### The "bot-per-class" strategy — powered by `AgentFactoryService`

When a teacher creates a new class, a workflow creates a class-specific tutor bot. This uses the existing `POST /api/swarm/agents` endpoint and `AgentFactoryService.deployPersonaOnly()`.

### Guided Procedure: "Create a Class"

**Workflow (triggered by teacher via cockpit):**

1. **Teacher fills form:** Class name, subject, grade level, textbook PDFs
2. **System creates ChromaDB collections:**
   - `lm:class:{classId}:textbooks`
   - `lm:class:{classId}:lectures`
   - `lm:class:{classId}:notes`
3. **System calls `AgentFactoryService.deployPersonaOnly()`** with:
   - Name: `tutor-{className}` (e.g., `tutor-chemistry-101`)
   - System prompt: class-tutor template + class-specific context injected:
     - Subject, grade level, textbook titles, teacher name
     - ChromaDB collection IDs for scoped RAG queries
   - Capabilities: tutoring, rag-query, subject-expertise
   - Routing keywords: class name, subject, teacher name
4. **Textbook librarian bot** processes uploaded PDFs → chunks → ChromaDB
5. **New tutor bot self-registers** in cockpit toolbar via `BOT_UI_LABEL`
6. **Students see** "Chemistry 101 Tutor" button appear in their toolbar

### Class Bot Lifecycle

- **Created:** When teacher creates class via guided procedure
- **Active:** Self-registers, heartbeats, appears in toolbar
- **Updated:** When new textbooks/lectures are added, knowledge base grows
- **Archived:** End of semester — bot stops heartbeating, TTL expires, toolbar button disappears, ChromaDB collections preserved for reference

---

## Sprint 4: Lecture Processing Workflow (Week 3-4)

### The end-to-end pipeline — student records, everything generates

**Trigger:** Student uploads audio recording via cockpit (new toolbar item: "Record Lecture")

**Ticket type:** `education:lecture-processing`

**Flow — all using existing swarm orchestration:**

1. **Student uploads audio** → creates ticket with type `education:lecture-processing`
2. **Routing cascade** matches `lecture-scribe` bot via routing keywords
3. **lecture-scribe** executes its perspective SOP:
   - Transcribes audio (Whisper via `transcribe-lecture` tool)
   - Generates study notes (`generate-study-notes` tool)
   - Extracts assignments (`extract-assignments` tool)
   - Generates flashcards (`generate-flashcards` tool)
   - Indexes everything into class ChromaDB collections
4. **Deliverables written to workspace:**
   - `TRANSCRIPT-2026-04-19.md`
   - `STUDY-NOTES-2026-04-19.md`
   - `ASSIGNMENTS-2026-04-19.json`
   - `FLASHCARDS-2026-04-19.json`
5. **Ticket completes** → student notified → materials available in toolbar views
6. **Cost tracked** automatically by `CostTrackingService`

### Why This Works Without Framework Changes

- The `QueueManagerService` already processes tickets by type
- Phase routing already selects bots by capabilities and routing keywords
- Workspace management already creates per-ticket folders
- Cost tracking already aggregates per-agent
- The lecture-scribe's perspective prompt IS the pipeline — the bot follows its own SOP

---

## Sprint 5: Toolbar UI Surfaces (Week 4-5)

### Each bot registers its own UI via the existing self-registration pattern

**How it works (already in `bot-node-server.ts`):**
- Bot sets `BOT_UI_LABEL` + `BOT_UI_URL` env vars
- Bot POSTs to `/api/tools/register` with iframe URL
- `RibbonNav._loadToolViews()` picks it up on next poll
- Button appears in cockpit toolbar
- TTL auto-expires when bot stops

### Toolbar Items for Little Monsters

| Bot | Toolbar Label | UI Surface |
|---|---|---|
| lecture-scribe | Record Lecture | Audio recorder + upload + processing status |
| class-tutor-{class} | {Class} Tutor | Chat interface with streaming responses |
| quiz-master | Practice Quiz | Quiz selection, timer, scoring, review |
| study-coach | Study Planner | Calendar view, streak tracker, daily plan |
| textbook-librarian | Library | Browse materials, search knowledge base |
| writing-coach | Writing Lab | Text editor with inline feedback |

### UI Implementation

Each bot serves its own lightweight HTML page (same pattern as the facebook bot's `facebook-app.html`). The cockpit embeds it as an iframe. The bot's Express server on its own port serves both the API and the UI.

**Example: Lecture Recorder UI**
- `any-bot/server/services/tools/education/lecture-recorder.html`
- MediaRecorder API for in-browser audio capture
- Upload button → POST to lecture-scribe's endpoint
- Progress indicator showing pipeline stages
- Results viewer: tabs for transcript, notes, assignments, flashcards
- Read-aloud button on notes (calls PollyService)

**Example: Tutor Chat UI**
- `any-bot/server/services/tools/education/tutor-chat.html`
- SSE-based streaming chat (same pattern as cockpit chat)
- Class context sidebar showing available materials
- "Read this to me" button on any response (PollyService TTS)
- Flashcard generation button on any concept mentioned

**Example: Quiz Arena UI**
- `any-bot/server/services/tools/education/quiz-arena.html`
- Topic/difficulty selector
- Timed question display with MC/short answer/T-F
- Instant feedback with explanations
- Score summary + auto-generated flashcards for missed questions
- Streak and XP tracking

---

## Sprint 6: Gamification Layer (Week 5-6)

### XP, streaks, and the LM mascot — all driven by bot activity

**XP events** — logged when bots complete work (piggyback on existing `chat_tasks` / cost tracking):

| Action | XP | Trigger |
|---|---|---|
| Upload lecture recording | +25 | lecture-scribe ticket created |
| Review generated notes | +10 | Student opens notes view |
| Complete flashcard session (20+ cards) | +50 | Flashcard UI session end |
| Complete practice quiz | +30 | Quiz submission |
| Quiz score > 90% | +20 bonus | Quiz result |
| Daily login streak (3+ days) | +15/day | Login event |
| Ask tutor a question | +5 | Tutor chat message |
| Complete study plan session | +40 | Study coach check-in |

**LM Mascot** — a lightweight JS component embedded in each bot UI:
- 4 moods: Happy (default), Tired (idle >10min), Hyped (streak/level-up), Proud (quiz success)
- Contextual quotes based on current activity
- Animated reactions to XP events
- Shared component: `any-bot/server/services/tools/education/lm-mascot.js`

**Streak tracking** — Redis key per student: `lm:student:{id}:streak`
- Increment on daily activity
- Reset on miss
- Bonus XP multiplier at 7-day and 30-day streaks

---

## ChromaDB Collection Architecture

```
lm:class:{classId}:textbooks     — PDF chunks from assigned textbooks
lm:class:{classId}:lectures      — Transcribed lecture segments  
lm:class:{classId}:notes         — Generated study notes
lm:class:{classId}:flashcards    — Flashcard content for semantic search
lm:global:formulas               — Math/science formula reference (shared)
lm:global:vocabulary             — Cross-class vocabulary bank (shared)
```

**Per-chunk metadata:**
```json
{
  "source": "Chemistry-Zumdahl-10e.pdf",
  "page": 147,
  "section": "5.3 Enthalpy",
  "classId": "chem-101-fall-2026",
  "type": "textbook",
  "ingested_at": "2026-04-19T14:30:00Z"
}
```

---

## LLM Cost Strategy

Use the right model for each job — the swarm already supports per-bot provider/model config:

| Bot | LLM | Why | Est. Cost/Use |
|---|---|---|---|
| lecture-scribe (transcription) | Whisper API | Purpose-built for STT | ~$0.006/min |
| lecture-scribe (cleanup/notes) | Gemini Flash | Fast, cheap structured output | ~$0.01 |
| class-tutor | Claude Sonnet | Conversational quality, teaching nuance | ~$0.03 |
| quiz-master | Claude Sonnet | Distractor generation needs nuance | ~$0.02 |
| flashcard-smith (via lecture-scribe) | Claude Haiku | Atomic Q&A pairs, high volume | ~$0.005 |
| study-coach | Claude Haiku | Scheduling logic, not creative | ~$0.005 |
| writing-coach | Claude Sonnet | Pedagogical feedback needs depth | ~$0.03 |
| textbook-librarian | Gemini Flash | Bulk text processing | ~$0.01 |

**Full lecture pipeline** (record → transcribe → notes → assignments → flashcards): **~$0.05 total**

---

## Files to Create (Zero Framework Modifications)

### Tools (auto-discovered by app.js)
```
any-bot/server/services/tools/education/
├── audioTranscribeTool.js
├── pdfIngestTool.js  
├── classKnowledgeTool.js
├── studyContentTool.js
```

### Bot Personas
```
ai-lab/bot-personas/
├── lecture-scribe.yaml
├── class-tutor.yaml          ← template, instantiated per class
├── quiz-master.yaml
├── textbook-librarian.yaml
├── study-coach.yaml
├── writing-coach.yaml
```

### Bot UI Surfaces (served by each bot, embedded as iframes)
```
any-bot/server/services/tools/education/
├── lecture-recorder.html
├── tutor-chat.html
├── quiz-arena.html
├── study-planner.html
├── library-browser.html
├── writing-lab.html
├── lm-mascot.js              ← shared component
├── student-dashboard.html    ← XP, streaks, class overview
```

### Total: 4 tool files + 6 persona YAMLs + 8 UI files = 18 files. Zero framework changes.

---

## Implementation Order

| Sprint | What | Outcome |
|---|---|---|
| 1 | Education tools (4 JS files) | Platform can transcribe, ingest PDFs, query knowledge, generate study materials |
| 2 | Bot personas (6 YAML files) | Bots exist with SOPs, routing, capabilities — deployable immediately |
| 3 | Dynamic class creation workflow | Teachers create classes → tutor bots auto-spawn with class context |
| 4 | Lecture processing pipeline | Student uploads recording → gets notes + assignments + flashcards |
| 5 | Toolbar UI surfaces (HTML/JS) | Every bot has a usable interface in the cockpit |
| 6 | Gamification (XP, streaks, mascot) | Student engagement layer on top of bot interactions |

---

## What Makes This Special

1. **Zero framework changes.** Every feature is a bot persona, a tool file, or an HTML surface. The platform does what it was built to do.

2. **One recording → four outputs.** Upload audio, get transcript + notes + assignments + flashcards. The lecture-scribe bot's SOP IS the pipeline.

3. **Dynamic class bots.** Teachers don't configure AI — they create a class, upload textbooks, and a tutor bot appears in the toolbar with full context. `AgentFactoryService` handles the rest.

4. **Bot-owned UIs.** Each bot registers its own toolbar button and serves its own interface. When the bot stops, the button disappears. No orphaned UI. No framework coupling.

5. **Every model earns its cost.** Haiku for flashcards ($0.005), Sonnet for tutoring ($0.03), Whisper for transcription ($0.006/min). The swarm routes to the right model automatically.

6. **TTS everywhere.** PollyService already works. Every bot can offer "read this to me" — notes, flashcards, quiz explanations, tutor responses. Audio learning is a first-class feature, not an add-on.

7. **Full observability for free.** Teacher sees the cockpit: which students are studying, what it costs, which topics generate the most tutor questions. All from existing OSHAL telemetry.
