# SonarCloud connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `sonarcloud` |
| **Version** | 1.0.0 |
| **Base URL** | `https://sonarcloud.io/api` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | SonarCloud (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `projects` | `sonarcloud-projects` | read | GET | `/projects/search` | `organization` |
| `issues` | `sonarcloud-issues` | read | GET | `/issues/search` | `componentKeys` |
| `measures` | `sonarcloud-measures` | read | GET | `/measures/component` | `component`, `metricKeys` |
| `quality-gate-status` | `sonarcloud-quality-gate-status` | read | GET | `/qualitygates/project_status` | `projectKey` |
| `metrics` | `sonarcloud-metrics` | read | GET | `/metrics/search` | - |

## Tools Exposed

- `sonarcloud-projects`
- `sonarcloud-issues`
- `sonarcloud-measures`
- `sonarcloud-quality-gate-status`
- `sonarcloud-metrics`
