# Little Monsters — Feature Backlog

> **Shipped + open work for the current class configuration** (SSO identity, Class Bank, private materials, OCR) lives in [lm-class-config-open-work.md](lm-class-config-open-work.md) — start there for what's live vs. deferred with done-when criteria. This file is the longer-horizon wishlist.

## Tier 0: Platform — Swarm Application Manifests (HIGHEST PRIORITY)

**ADR:** [033b-swarm-application-manifests.md](../adr/033b-swarm-application-manifests.md)  
**Target:** Weekend of 2026-04-25/26  
**Scope:** Framework-level change (requires ADR approval)

A YAML manifest (`swarm-apps/little-monsters.yaml`) that declares an application as a unit — bots, tools, UI surfaces, ticket workflows. Toggle the whole application on/off via `PATCH /api/swarm/apps/:name/toggle`. When off: bots deactivate, ribbon icons disappear, tickets stop. When on: everything restores.

**Why Tier 0:** This is infrastructure that every future application depends on. Without it, each app is a pile of individually-managed bots with no coherent lifecycle. With it, OSHAL becomes a true application platform — install an app, toggle it, uninstall it.

**Key deliverables:**
- `swarm-apps/` directory with YAML manifest schema
- `swarm_applications` DB table
- `SwarmAppService` with load/unload/toggle
- API: `GET/POST/PATCH/DELETE /api/swarm/apps`
- Tool deregistration (`DELETE /api/tools/dynamic/:toolName`)
- Dynamic workflow pipeline registry (replace hardcoded `WORKFLOW_PIPELINES`)
- Conditional route loading from app manifests

---

## Tier 1: Personal Assistant (highest impact for ADHD student)

### Daily Briefing Bot
- Morning summary: "Good morning! You have 2 things due today, a quiz tomorrow, and your streak is at 5 days."
- Spoken aloud via TTS on page load
- Proactive nudges: "You haven't reviewed Chemistry flashcards in 3 days"

### Smart Reminders (SMS/Email/Push)
- Text message reminders: "Algebra homework due tomorrow at 5pm"
- Email digest: weekly summary of what's due, what was completed, streak status
- Phone call reminder (Twilio): for high-priority deadlines
- Integration: start with email (SendGrid/SES), add SMS (Twilio), then push (web push API)

### Homework Companion Mode
- Student says "I'm working on my algebra homework"
- Bot enters companion mode: stays available, checks in every 10 min
- "How's it going? Need help with any problems?"
- Tracks time spent per subject for study analytics

### Morning/Evening Routine
- Morning: "Here's your day" + read aloud schedule
- Evening: "What did you learn today?" + quick voice reflection
- Auto-generates study plan for tomorrow based on what's due

---

## Tier 2: Content & Knowledge

### ISBN Integration
- Enter textbook ISBN → auto-fetch metadata (title, author, chapters, cover image)
- Link to OpenStax/LibreTexts if free version exists
- Pre-populate class materials from ISBN lookup
- API: Google Books API (free), Open Library API (free)

### Education Content Search
- Khan Academy video links by topic
- OpenStax free textbook chapters
- CK-12 FlexBooks
- YouTube Crash Course links
- PhET simulations for science
- Desmos activities for math
- Quizlet public flashcard sets

### Curriculum Mapping
- Map class topics to Common Core / state standards
- Suggest resources aligned to what's being taught
- Track coverage: "You've studied 60% of the Chapter 3 topics"

---

## Tier 3: Teacher Collaboration

### Teacher Dashboard
- View student engagement (who's studying, who isn't)
- Upload materials (textbooks, handouts, links) to class knowledge base
- Create assignments that auto-generate calendar events
- Review auto-generated flashcards and quizzes for accuracy
- Share notes/announcements with all students in a class

### Teacher-Student Messaging
- In-app messaging between teacher and student
- Teacher can send encouragement: "Great job on the quiz!"
- Student can ask questions that get routed to the tutor first, escalate to teacher if needed

### Parent Portal
- View child's activity: streak, XP, quiz scores, study time
- Receive weekly email digest
- Set notification preferences

---

## Tier 4: Platform Integration

### LMS Integration
- Google Classroom: sync assignments, grades, roster
- Canvas: import syllabus, sync due dates
- Schoology: roster sync
- Pattern: OAuth + API polling, two-way sync

### Calendar Integration
- Google Calendar: export events, import class schedule
- Apple Calendar: .ics export
- Outlook: .ics export
- Auto-sync assignments as calendar events

### Communication Integration
- Slack/Discord: study group channels
- Email: SendGrid for notifications
- SMS: Twilio for urgent reminders
- Web Push: browser notifications for due items

---

## Tier 5: Advanced Features

### Study Analytics Dashboard
- Time spent per subject per week (chart)
- Flashcard accuracy over time (trend line)
- Quiz score progression
- Streak history
- "Your strongest subject is Chemistry (88% avg), weakest is Algebra (62% avg)"

### Swarm Canvas / Visual Study Spaces
- Mind map builder for topics
- Collaborative whiteboard (real-time)
- Concept connection diagrams
- Visual note-taking with drawing

### Scripted Data Building
- Auto-generate flashcard sets from any URL (paste a Wikipedia article)
- Auto-generate quizzes from pasted text
- Bulk import flashcards from CSV/Quizlet export

### Accessibility
- Dyslexia-friendly font option (OpenDyslexic)
- High contrast mode
- Adjustable text size
- Screen reader optimization
- Keyboard navigation for all features

### Gamification Expansion
- Achievement badges (10-day streak, 100 flashcards, first quiz 90%+)
- XP leaderboard (opt-in, class-level)
- Custom avatar/mascot customization
- Study challenges between classmates

---

## What's Missing (Critical for ADHD)

1. **Body doubling** — "Study with me" mode where the bot is present and checking in, not just answering questions
2. **Task breakdown** — "This assignment seems big. Let's break it into 3 smaller steps."
3. **Transition support** — "You've been on math for 30 min. Want to switch to chemistry or take a break?"
4. **Emotional check-in** — "How are you feeling about this assignment? Frustrated? Let's try a different approach."
5. **Fidget/movement breaks** — "Stand up and stretch for 30 seconds. I'll wait."
6. **Reward visibility** — XP and streaks need to be MORE visible, not less. Dopamine feedback loop.
7. **Reduce friction** — Every feature should be reachable in 1-2 taps. No deep menus.
8. **Time blindness support** — Visual countdown timers on EVERYTHING (assignments, study sessions, breaks)
