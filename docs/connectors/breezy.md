# Breezy HR connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `breezy` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.breezy.hr/v3` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `companies` | `breezy-companies` | read | GET | `/companies` | - |
| `positions` | `breezy-positions` | read | GET | `/company/{company_id}/positions` | `company_id` |

## Tools Exposed

- `breezy-companies`
- `breezy-positions`
