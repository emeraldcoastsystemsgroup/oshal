# Fastly connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `fastly` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.fastly.com` |
| **Auth** | API key in header `Fastly-Key` |
| **Icon** | Fastly (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `current-user` | `fastly-current-user` | read | GET | `/current_user` | - |
| `services` | `fastly-services` | read | GET | `/service` | - |
| `service` | `fastly-service` | read | GET | `/service/{serviceId}` | `serviceId` |
| `service-versions` | `fastly-service-versions` | read | GET | `/service/{serviceId}/version` | `serviceId` |
| `datacenters` | `fastly-datacenters` | read | GET | `/datacenters` | - |
| `public-ip-list` | `fastly-public-ip-list` | read | GET | `/public-ip-list` | - |

## Tools Exposed

- `fastly-current-user`
- `fastly-services`
- `fastly-service`
- `fastly-service-versions`
- `fastly-datacenters`
- `fastly-public-ip-list`
