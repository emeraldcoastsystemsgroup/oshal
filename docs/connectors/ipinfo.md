# IPinfo connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `ipinfo` |
| **Version** | 1.0.0 |
| **Base URL** | `https://ipinfo.io` |
| **Auth** | API key in query param `token` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `lookup-json` | `ipinfo-lookup-json` | read | GET | `/{ip}/json` | `ip` |
| `lookup` | `ipinfo-lookup` | read | GET | `/{ip}` | `ip` |

## Tools Exposed

- `ipinfo-lookup-json`
- `ipinfo-lookup`
