# Turso connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `turso` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.turso.tech/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Turso (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `databases` | `turso-databases` | read | GET | `/organizations/{organization}/databases` | `organization` |
| `database` | `turso-database` | read | GET | `/organizations/{organization}/databases/{database}` | `organization`, `database` |
| `groups` | `turso-groups` | read | GET | `/organizations/{organization}/groups` | `organization` |

## Tools Exposed

- `turso-databases`
- `turso-database`
- `turso-groups`
