# Emailable connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `emailable` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.emailable.com/v1` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `verify` | `emailable-verify` | read | GET | `/verify` | `email` |
| `account` | `emailable-account` | read | GET | `/account` | - |

## Tools Exposed

- `emailable-verify`
- `emailable-account`
