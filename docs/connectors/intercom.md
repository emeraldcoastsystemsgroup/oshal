# Intercom connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `intercom` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.intercom.io` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read the connected Intercom workspace admin identity and its contacts. |
| **Icon** | Intercom (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | cursor (`starting_after`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `intercom-me` | read | GET | `/me` | - |
| `contacts` | `intercom-contacts` | read | GET | `/contacts` | - |

## Tools Exposed

- `intercom-me`
- `intercom-contacts`
