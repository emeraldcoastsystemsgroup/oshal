# REST Countries connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `restcountries` |
| **Version** | 1.0.0 |
| **Base URL** | `https://restcountries.com/v3.1` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `all` | `restcountries-all` | read | GET | `/all` | - |
| `by-name` | `restcountries-by-name` | read | GET | `/name/{name}` | `name` |
| `by-code` | `restcountries-by-code` | read | GET | `/alpha/{code}` | `code` |
| `by-region` | `restcountries-by-region` | read | GET | `/region/{region}` | `region` |

## Tools Exposed

- `restcountries-all`
- `restcountries-by-name`
- `restcountries-by-code`
- `restcountries-by-region`
