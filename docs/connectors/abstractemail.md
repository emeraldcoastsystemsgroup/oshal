# Abstract Email Validation connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `abstractemail` |
| **Version** | 1.0.0 |
| **Base URL** | `https://emailvalidation.abstractapi.com/v1` |
| **Auth** | API key in query param `api_key` |
| **Description** | Abstract Email Validation — reads validate via emailvalidation.abstractapi.com. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | Abstract (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `validate` | `abstractemail-validate` | read | GET | `/` | `email` |

## Tools Exposed

- `abstractemail-validate`
