# DocuSeal connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `docuseal` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.docuseal.co` |
| **Auth** | API key in header `X-Auth-Token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `list-templates` | `docuseal-list-templates` | read | GET | `/templates` | - |
| `list-submissions` | `docuseal-list-submissions` | read | GET | `/submissions` | - |
| `list-submitters` | `docuseal-list-submitters` | read | GET | `/submitters` | - |

## Tools Exposed

- `docuseal-list-templates`
- `docuseal-list-submissions`
- `docuseal-list-submitters`
