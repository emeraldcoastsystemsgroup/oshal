# Hunter connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `hunter` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.hunter.io/v2` |
| **Auth** | API key in query param `api_key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `domain-search` | `hunter-domain-search` | read | GET | `/domain-search` | `domain` |
| `email-finder` | `hunter-email-finder` | read | GET | `/email-finder` | `domain`, `first_name`, `last_name` |
| `email-verifier` | `hunter-email-verifier` | read | GET | `/email-verifier` | `email` |
| `account` | `hunter-account` | read | GET | `/account` | - |

## Tools Exposed

- `hunter-domain-search`
- `hunter-email-finder`
- `hunter-email-verifier`
- `hunter-account`
