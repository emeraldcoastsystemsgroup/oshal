# Google Calendar connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `google-calendar` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.googleapis.com/calendar/v3` |
| **Auth** | OAuth2 (bearer) |
| **Description** | List Google Calendar calendars and their events, with a resource to create events. |
| **Icon** | Google Calendar (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`pageToken`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-events` | `gcal-list-events` | read | GET | `/calendars/{calendarId}/events` | `calendarId`, `timeMin` |
| `list-calendars` | `gcal-list-calendars` | read | GET | `/users/me/calendarList` | - |
| `create-event` | `gcal-create-event` | read | POST | `/calendars/{calendarId}/events` | `calendarId`, `event` |

## Tools Exposed

- `gcal-list-events`
- `gcal-list-calendars`
- `gcal-create-event`
