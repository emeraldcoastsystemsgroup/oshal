# Dynatrace connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `dynatrace` |
| **Version** | 1.0.0 |
| **Base URL** | `https://YOUR-ENV-ID.live.dynatrace.com/api/v2` |
| **Auth** | API key in header `Authorization` |
| **Description** | Read Dynatrace problems, monitored entities, metric definitions and queries, and events. |
| **Icon** | Dynatrace (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`nextPageKey`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `problems` | `dynatrace-problems` | read | GET | `/problems` | `from`, `to`, `problemSelector` |
| `problem` | `dynatrace-problem` | read | GET | `/problems/{problemId}` | `problemId` |
| `entities` | `dynatrace-entities` | read | GET | `/entities` | `entitySelector`, `from`, `to` |
| `metrics` | `dynatrace-metrics` | read | GET | `/metrics` | `metricSelector` |
| `metric-query` | `dynatrace-metric-query` | read | GET | `/metrics/query` | `metricSelector`, `from`, `to`, `resolution` |
| `events` | `dynatrace-events` | read | GET | `/events` | `from`, `to`, `eventSelector` |

## Tools Exposed

- `dynatrace-problems`
- `dynatrace-problem`
- `dynatrace-entities`
- `dynatrace-metrics`
- `dynatrace-metric-query`
- `dynatrace-events`
