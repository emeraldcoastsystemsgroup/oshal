# Strava connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `strava` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.strava.com/api/v3` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Strava (verified) |
| **Rate limit** | burst 5, 5/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `strava-me` | read | GET | `/athlete` | - |
| `activities` | `strava-activities` | read | GET | `/athlete/activities` | `page` |
| `stats` | `strava-stats` | read | GET | `/athletes/{athleteId}/stats` | `athleteId` |

## Tools Exposed

- `strava-me`
- `strava-activities`
- `strava-stats`
