# ZeroBounce connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `zerobounce` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.zerobounce.net/v2` |
| **Auth** | API key in query param `api_key` |
| **Description** | ZeroBounce — reads validate, getcredits, getapiusage via api.zerobounce.net. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `validate` | `zerobounce-validate` | read | GET | `/validate` | `email` |
| `getcredits` | `zerobounce-getcredits` | read | GET | `/getcredits` | - |
| `getapiusage` | `zerobounce-getapiusage` | read | GET | `/getapiusage` | `start_date`, `end_date` |

## Tools Exposed

- `zerobounce-validate`
- `zerobounce-getcredits`
- `zerobounce-getapiusage`
