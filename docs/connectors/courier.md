# Courier connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `courier` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.courier.com` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `messages` | `courier-messages` | read | GET | `/messages` | `cursor` |
| `lists` | `courier-lists` | read | GET | `/lists` | `cursor` |
| `brands` | `courier-brands` | read | GET | `/brands` | `cursor` |

## Tools Exposed

- `courier-messages`
- `courier-lists`
- `courier-brands`
