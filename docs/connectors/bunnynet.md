# Bunny.net connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `bunnynet` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.bunny.net` |
| **Auth** | API key in header `AccessKey` |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `pull-zones` | `bunnynet-pull-zones` | read | GET | `/pullzone` | - |
| `pull-zone` | `bunnynet-pull-zone` | read | GET | `/pullzone/{id}` | `id` |
| `storage-zones` | `bunnynet-storage-zones` | read | GET | `/storagezone` | - |
| `dns-zones` | `bunnynet-dns-zones` | read | GET | `/dnszone` | - |
| `statistics` | `bunnynet-statistics` | read | GET | `/statistics` | - |
| `countries` | `bunnynet-countries` | read | GET | `/country` | - |

## Tools Exposed

- `bunnynet-pull-zones`
- `bunnynet-pull-zone`
- `bunnynet-storage-zones`
- `bunnynet-dns-zones`
- `bunnynet-statistics`
- `bunnynet-countries`
