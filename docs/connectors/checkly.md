# Checkly connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `checkly` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.checklyhq.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `checks` | `checkly-checks` | read | GET | `/checks` | `limit`, `page` |
| `check-groups` | `checkly-check-groups` | read | GET | `/check-groups` | `limit`, `page` |
| `check-results` | `checkly-check-results` | read | GET | `/check-results` | `limit`, `page` |

## Tools Exposed

- `checkly-checks`
- `checkly-check-groups`
- `checkly-check-results`
