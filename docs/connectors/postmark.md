# Postmark connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `postmark` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.postmarkapp.com` |
| **Auth** | API key in header `X-Postmark-Server-Token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`offset`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `server` | `postmark-server` | read | GET | `/server` | - |
| `outbound` | `postmark-outbound` | read | GET | `/messages/outbound` | `offset` |
| `inbound` | `postmark-inbound` | read | GET | `/messages/inbound` | `offset` |
| `stats` | `postmark-stats` | read | GET | `/stats/outbound` | - |

## Tools Exposed

- `postmark-server`
- `postmark-outbound`
- `postmark-inbound`
- `postmark-stats`
