# LocationIQ connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `locationiq` |
| **Version** | 1.0.0 |
| **Base URL** | `https://us1.locationiq.com/v1` |
| **Auth** | API key in query param `key` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search` | `locationiq-search` | read | GET | `/search` | `q` |
| `reverse` | `locationiq-reverse` | read | GET | `/reverse` | `lat`, `lon` |
| `autocomplete` | `locationiq-autocomplete` | read | GET | `/autocomplete` | `q` |

## Tools Exposed

- `locationiq-search`
- `locationiq-reverse`
- `locationiq-autocomplete`
