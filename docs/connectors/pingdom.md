# Pingdom connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `pingdom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.pingdom.com/api/3.1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Pingdom (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `checks` | `pingdom-checks` | read | GET | `/checks` | - |
| `check` | `pingdom-check` | read | GET | `/checks/{checkid}` | `checkid` |
| `outage-summary` | `pingdom-outage-summary` | read | GET | `/summary.outage/{checkid}` | `checkid`, `from`, `to` |

## Tools Exposed

- `pingdom-checks`
- `pingdom-check`
- `pingdom-outage-summary`
