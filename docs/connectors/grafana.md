# Grafana connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `grafana` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-org.grafana.net/api` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Grafana dashboards and folders, data sources, provisioned alert rules, and annotations. |
| **Icon** | Grafana (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `dashboards-search` | `grafana-dashboards-search` | read | GET | `/search` | - |
| `datasources` | `grafana-datasources` | read | GET | `/datasources` | - |
| `alert-rules` | `grafana-alert-rules` | read | GET | `/v1/provisioning/alert-rules` | - |
| `folders` | `grafana-folders` | read | GET | `/folders` | - |
| `org` | `grafana-org` | read | GET | `/org` | - |
| `annotations` | `grafana-annotations` | read | GET | `/annotations` | - |

## Tools Exposed

- `grafana-dashboards-search`
- `grafana-datasources`
- `grafana-alert-rules`
- `grafana-folders`
- `grafana-org`
- `grafana-annotations`
