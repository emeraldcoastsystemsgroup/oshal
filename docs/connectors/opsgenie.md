# Opsgenie connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `opsgenie` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.opsgenie.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Opsgenie (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `alerts` | `opsgenie-alerts` | read | GET | `/v2/alerts` | - |
| `alert` | `opsgenie-alert` | read | GET | `/v2/alerts/{alertId}` | `alertId` |
| `incidents` | `opsgenie-incidents` | read | GET | `/v1/incidents` | - |
| `teams` | `opsgenie-teams` | read | GET | `/v2/teams` | - |
| `schedules` | `opsgenie-schedules` | read | GET | `/v2/schedules` | - |
| `services` | `opsgenie-services` | read | GET | `/v1/services` | - |

## Tools Exposed

- `opsgenie-alerts`
- `opsgenie-alert`
- `opsgenie-incidents`
- `opsgenie-teams`
- `opsgenie-schedules`
- `opsgenie-services`
