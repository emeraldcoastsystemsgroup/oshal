# Harvest connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `harvest` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.harvestapp.com/v2` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `time-entries` | `harvest-time-entries` | read | GET | `/time_entries` | - |
| `projects` | `harvest-projects` | read | GET | `/projects` | - |
| `clients` | `harvest-clients` | read | GET | `/clients` | - |
| `me` | `harvest-me` | read | GET | `/users/me` | - |

## Tools Exposed

- `harvest-time-entries`
- `harvest-projects`
- `harvest-clients`
- `harvest-me`
