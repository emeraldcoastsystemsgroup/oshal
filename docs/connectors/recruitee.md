# Recruitee connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `recruitee` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.recruitee.com/c/companyid` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `offers` | `recruitee-offers` | read | GET | `/offers` | - |
| `candidates` | `recruitee-candidates` | read | GET | `/candidates` | - |
| `departments` | `recruitee-departments` | read | GET | `/departments` | - |

## Tools Exposed

- `recruitee-offers`
- `recruitee-candidates`
- `recruitee-departments`
