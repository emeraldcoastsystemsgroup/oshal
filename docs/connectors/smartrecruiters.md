# SmartRecruiters connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `smartrecruiters` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.smartrecruiters.com` |
| **Auth** | API key in header `X-SmartToken` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `jobs` | `smartrecruiters-jobs` | read | GET | `/jobs` | - |
| `candidates` | `smartrecruiters-candidates` | read | GET | `/candidates` | - |
| `postings` | `smartrecruiters-postings` | read | GET | `/postings` | - |

## Tools Exposed

- `smartrecruiters-jobs`
- `smartrecruiters-candidates`
- `smartrecruiters-postings`
