# Datadog connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `datadog` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.datadoghq.com` |
| **Auth** | API key in header `DD-API-KEY` |
| **Description** | Read Datadog monitors, incidents, and events, and search monitors and hosts. |
| **Icon** | Datadog (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `monitors` | `datadog-monitors` | read | GET | `/api/v1/monitor` | - |
| `monitor` | `datadog-monitor` | read | GET | `/api/v1/monitor/{monitorId}` | `monitorId` |
| `incidents` | `datadog-incidents` | read | GET | `/api/v2/incidents` | - |
| `events` | `datadog-events` | read | GET | `/api/v1/events` | `start`, `end` |
| `metric-search` | `datadog-metric-search` | read | GET | `/api/v1/search` | `q` |

## Tools Exposed

- `datadog-monitors`
- `datadog-monitor`
- `datadog-incidents`
- `datadog-events`
- `datadog-metric-search`
