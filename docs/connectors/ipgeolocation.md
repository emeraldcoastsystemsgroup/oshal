# IPGeolocation connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ipgeolocation` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.ipgeolocation.io` |
| **Auth** | API key in query param `apiKey` |
| **Description** | IPGeolocation — reads ipgeo, timezone, astronomy via api.ipgeolocation.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `ipgeo` | `ipgeolocation-ipgeo` | read | GET | `/ipgeo` | `ip` |
| `timezone` | `ipgeolocation-timezone` | read | GET | `/timezone` | `q` |
| `astronomy` | `ipgeolocation-astronomy` | read | GET | `/astronomy` | `q` |

## Tools Exposed

- `ipgeolocation-ipgeo`
- `ipgeolocation-timezone`
- `ipgeolocation-astronomy`
