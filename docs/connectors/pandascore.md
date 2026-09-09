# PandaScore connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pandascore` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pandascore.co` |
| **Auth** | OAuth2 (bearer) |
| **Description** | PandaScore — reads matches, teams, players, tournaments via api.pandascore.co. OAuth: the operator registers the provider app once, then each user connects their own account. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `matches` | `pandascore-matches` | read | GET | `/matches` | - |
| `teams` | `pandascore-teams` | read | GET | `/teams` | `q` |
| `players` | `pandascore-players` | read | GET | `/players` | `q` |
| `tournaments` | `pandascore-tournaments` | read | GET | `/tournaments` | - |

## Tools Exposed

- `pandascore-matches`
- `pandascore-teams`
- `pandascore-players`
- `pandascore-tournaments`
