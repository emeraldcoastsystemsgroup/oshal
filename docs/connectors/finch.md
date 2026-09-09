# Finch connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `finch` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.tryfinch.com/employer` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Finch — reads directory, company, individual, employment via api.tryfinch.com. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `directory` | `finch-directory` | read | GET | `/directory` | - |
| `company` | `finch-company` | read | GET | `/company` | - |
| `individual` | `finch-individual` | read | GET | `/individual/{individualId}` | `individualId` |
| `employment` | `finch-employment` | read | GET | `/employment/{individualId}` | `individualId` |

## Tools Exposed

- `finch-directory`
- `finch-company`
- `finch-individual`
- `finch-employment`
