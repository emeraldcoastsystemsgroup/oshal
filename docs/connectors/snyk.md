# Snyk connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `snyk` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.snyk.io/rest` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Snyk (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `orgs` | `snyk-orgs` | read | GET | `/orgs` | `version` |
| `org` | `snyk-org` | read | GET | `/orgs/{orgId}` | `orgId`, `version` |
| `projects` | `snyk-projects` | read | GET | `/orgs/{orgId}/projects` | `orgId`, `version` |
| `project` | `snyk-project` | read | GET | `/orgs/{orgId}/projects/{projectId}` | `orgId`, `projectId`, `version` |
| `issues` | `snyk-issues` | read | GET | `/orgs/{orgId}/issues` | `orgId`, `version` |

## Tools Exposed

- `snyk-orgs`
- `snyk-org`
- `snyk-projects`
- `snyk-project`
- `snyk-issues`
