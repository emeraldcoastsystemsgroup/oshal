# Klaviyo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `klaviyo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://a.klaviyo.com/api` |
| **Auth** | API key in header `Authorization` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `profiles` | `klaviyo-profiles` | read | GET | `/profiles` | - |
| `lists` | `klaviyo-lists` | read | GET | `/lists` | - |
| `segments` | `klaviyo-segments` | read | GET | `/segments` | - |
| `campaigns` | `klaviyo-campaigns` | read | GET | `/campaigns` | - |
| `flows` | `klaviyo-flows` | read | GET | `/flows` | - |
| `metrics` | `klaviyo-metrics` | read | GET | `/metrics` | - |

## Tools Exposed

- `klaviyo-profiles`
- `klaviyo-lists`
- `klaviyo-segments`
- `klaviyo-campaigns`
- `klaviyo-flows`
- `klaviyo-metrics`
