# Hetzner Cloud connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `hetzner` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.hetzner.cloud/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Hetzner (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `servers` | `hetzner-servers` | read | GET | `/servers` | - |
| `server` | `hetzner-server` | read | GET | `/servers/{serverId}` | `serverId` |
| `volumes` | `hetzner-volumes` | read | GET | `/volumes` | - |
| `networks` | `hetzner-networks` | read | GET | `/networks` | - |
| `images` | `hetzner-images` | read | GET | `/images` | - |
| `datacenters` | `hetzner-datacenters` | read | GET | `/datacenters` | - |

## Tools Exposed

- `hetzner-servers`
- `hetzner-server`
- `hetzner-volumes`
- `hetzner-networks`
- `hetzner-images`
- `hetzner-datacenters`
