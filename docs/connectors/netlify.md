# Netlify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `netlify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.netlify.com/api/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Netlify (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `netlify-me` | read | GET | `/user` | - |
| `sites` | `netlify-sites` | read | GET | `/sites` | - |

## Tools Exposed

- `netlify-me`
- `netlify-sites`
