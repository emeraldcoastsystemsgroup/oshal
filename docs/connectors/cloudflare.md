# Cloudflare connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `cloudflare` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.cloudflare.com/client/v4` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read Cloudflare accounts, zones, and DNS records for the connected user. |
| **Icon** | Cloudflare (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `accounts` | `cloudflare-accounts` | read | GET | `/accounts` | - |
| `zones` | `cloudflare-zones` | read | GET | `/zones` | - |
| `zone` | `cloudflare-zone` | read | GET | `/zones/{zoneId}` | `zoneId` |
| `dns-records` | `cloudflare-dns-records` | read | GET | `/zones/{zoneId}/dns_records` | `zoneId` |
| `user` | `cloudflare-user` | read | GET | `/user` | - |

## Tools Exposed

- `cloudflare-accounts`
- `cloudflare-zones`
- `cloudflare-zone`
- `cloudflare-dns-records`
- `cloudflare-user`
