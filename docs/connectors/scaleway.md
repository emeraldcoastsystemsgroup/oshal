# Scaleway connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `scaleway` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.scaleway.com` |
| **Auth** | API key in header `X-Auth-Token` |
| **Icon** | Scaleway (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `servers` | `scaleway-servers` | read | GET | `/instance/v1/zones/{zone}/servers` | `zone` |
| `server` | `scaleway-server` | read | GET | `/instance/v1/zones/{zone}/servers/{serverId}` | `zone`, `serverId` |
| `volumes` | `scaleway-volumes` | read | GET | `/instance/v1/zones/{zone}/volumes` | `zone` |
| `images` | `scaleway-images` | read | GET | `/instance/v1/zones/{zone}/images` | `zone` |
| `security-groups` | `scaleway-security-groups` | read | GET | `/instance/v1/zones/{zone}/security_groups` | `zone` |

## Tools Exposed

- `scaleway-servers`
- `scaleway-server`
- `scaleway-volumes`
- `scaleway-images`
- `scaleway-security-groups`
