# PlanetScale connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `planetscale` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.planetscale.com/v1` |
| **Auth** | HTTP Basic (username/password) |
| **Icon** | PlanetScale (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `organizations` | `planetscale-organizations` | read | GET | `/organizations` | - |
| `databases` | `planetscale-databases` | read | GET | `/organizations/{organization}/databases` | `organization` |
| `database` | `planetscale-database` | read | GET | `/organizations/{organization}/databases/{database}` | `organization`, `database` |
| `branches` | `planetscale-branches` | read | GET | `/organizations/{organization}/databases/{database}/branches` | `organization`, `database` |

## Tools Exposed

- `planetscale-organizations`
- `planetscale-databases`
- `planetscale-database`
- `planetscale-branches`
