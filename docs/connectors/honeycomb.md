# Honeycomb connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `honeycomb` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.honeycomb.io/1` |
| **Auth** | API key in header `X-Honeycomb-Team` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `datasets` | `honeycomb-datasets` | read | GET | `/datasets` | - |
| `columns` | `honeycomb-columns` | read | GET | `/columns/{dataset}` | `dataset` |
| `triggers` | `honeycomb-triggers` | read | GET | `/triggers/{dataset}` | `dataset` |

## Tools Exposed

- `honeycomb-datasets`
- `honeycomb-columns`
- `honeycomb-triggers`
