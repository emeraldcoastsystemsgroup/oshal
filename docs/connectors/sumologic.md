# Sumo Logic connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sumologic` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.sumologic.com/api/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | Sumo Logic (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `collectors` | `sumologic-collectors` | read | GET | `/collectors` | - |
| `search-job` | `sumologic-search-job` | read | GET | `/search/jobs/{jobId}` | `jobId` |
| `monitors` | `sumologic-monitors` | read | GET | `/monitors/root` | - |
| `dashboards` | `sumologic-dashboards` | read | GET | `/dashboards/{dashboardId}` | `dashboardId` |
| `fields` | `sumologic-fields` | read | GET | `/fields` | - |
| `partitions` | `sumologic-partitions` | read | GET | `/partitions` | - |

## Tools Exposed

- `sumologic-collectors`
- `sumologic-search-job`
- `sumologic-monitors`
- `sumologic-dashboards`
- `sumologic-fields`
- `sumologic-partitions`
