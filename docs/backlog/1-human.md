# Operator Backlog: Human Actionable Checklist

*Status: Updated 2026-09-30*  
*Scope: External Credentials, Hardware, Accounts, and Governance Decisions.*

---

## 1. Confirmed & Live-Verified (Completed)

The following items previously listed as needing operator action or tokens have been **verified against live upstream vendor APIs and operational databases**:

| Integration / Service | Scope / Feature | Verification Proof | Operational Status |
|---|---|---|---|
| **Google Calendar** | **Create, Read, Update, Delete** | `https://oauth2.googleapis.com/tokeninfo` (200 OK) + `calendar.events` scope + `/api/calendar/events` API | **ACTIVE & WRITE-CAPABLE** — Bots and UI can list, get, create, patch, and delete calendar meetings. |
| **Google Drive** | Story delivery, document upload (`drive.file`) | Decrypted operator DEK + Google OAuth2 token inspection | **ACTIVE** — File creation and personal workspace storage operational. |
| **Google Mail (Gmail)** | Send & Read (`gmail.readonly`, `gmail.send`) | OAuth token active with offline auto-renewal (`access_type: offline`) | **ACTIVE** — Inbound read and outbound send operational. |
| **Telegram** | Inbound/outbound bot dispatch | `api.telegram.org/bot<TOKEN>/getMe` (200 OK) | **ACTIVE** — Bot registered as `@The_oshal_bot` (ID: `8835788991`). |
| **Twilio** | SMS text notifications and inbound alerts | `api.twilio.com/2010-04-01/Accounts/<SID>.json` (200 OK) | **ACTIVE** — Sender and operator mobile configured. Trial tier handles all SMS/text alerts. |
| **Charles Schwab API** | Live order execution & position tracking | Real order fill receipt today (MSFT & SMCI sells filled; account equity $94,863.37) | **ACTIVE** — 1 account actively transacting (`...6771`), 2 accounts watched/monitored. `TRADING_STREAM_ENABLED` clarified as stream mode toggle. |
| **Congressional Trades** | STOCK Act disclosures feed | Daily House/Senate Financial Disclosure XML pipeline ingested into `world_congress_trades` | **ACTIVE & FREE** — Ingests directly from primary government sources. Trading Cockpit displays sorting/filtering/charts. No paid Quiver Quantitative key needed. |

---

## 2. Google Calendar Read/Write Implementation Details

* **OAuth Scopes:** Default Google connector scopes expanded to include `https://www.googleapis.com/auth/calendar.events` alongside `calendar.readonly`.
* **Client Service:** [`GoogleCalendarService`](file:///c:/Projects/oshal/src/features/google-calendar/services/google-calendar-service.ts) updated with:
  * `createEvent(input)`: Timed meetings (with location and attendees) or all-day events.
  * `getEvent(eventId, calendarId?)`: Normalizes and returns event summary, time, location, and attendees.
  * `updateEvent(eventId, input, calendarId?)`: Supports `PATCH` updates for summary, time, date, location, attendees, or reminders.
  * `deleteEvent(eventId, calendarId?)`: Idempotent event removal.
  * `listUpcoming(opts)`: Time-window queries with event normalization.
* **REST API Endpoints:** Mounted behind `requiresAuth` at `/api/calendar`:
  * `GET /api/calendar/events` — List upcoming events
  * `GET /api/calendar/events/:id` — Retrieve single meeting
  * `POST /api/calendar/events` — Create new meeting on Google Calendar
  * `PATCH /api/calendar/events/:id` — Update existing meeting
  * `DELETE /api/calendar/events/:id` — Delete meeting
* **Test Verification:** 27/27 unit tests passing across `calendar-routes.spec.ts`, `google-calendar-service.spec.ts`, and `experience-availability-routes.spec.ts`.

---

## 3. Remaining Operator Items (Pending External Action)

The remaining items genuinely require external human accounts, hardware, or third-party paid subscriptions:

### A. Third-Party Service Keys (External Signups)
* [ ] **Plaid Production Access:** Production credentials for live consumer bank linking (sandbox/mock suite currently handles local tests).
* [ ] **HashiCorp Vault:** Production server URL and unseal tokens if migrating away from PostgreSQL envelope DEK storage (`oshal_user_deks`).
* [ ] **Hugging Face / Gemini Live:** Production paid tier keys if opting out of local inference router / open-tier fallbacks.

### B. Carrier Account Tier
* [ ] **Twilio Voice:** Upgrade Twilio account from trial tier to full tier whenever outbound voice phone calling / IVR is required (SMS text messaging is already live).

### C. Physical Hardware & Edge Devices
* [ ] **Drones & Cameras:** Physical RTSP camera hardware or drone edge controller for live payload verification.
* [ ] **Radio / SDR:** Physical RTL-SDR USB dongle for live RF/spectrum signal ingestion.
* [ ] **Edge Microcontrollers:** Physical Raspberry Pi / ESP32 serial connections for animatronics and robotics lab.

### D. Governance & Corporate Policy
* [ ] **PteroSim License:** Explicit decision to accept proprietary simulator EULA (`PTEROSIM_ACCEPT_EULA=Y`) or close item as declined.
* [ ] **Paid News/Bias Ratings:** Decision on whether to purchase commercial Ad Fontes / AllSides datasets or rely on public media data feeds.
