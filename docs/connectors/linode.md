# Linode connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `linode` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.linode.com/v4` |
| **Auth** | OAuth2 (bearer) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `account` | `linode-account` | read | GET | `/account` | - |
| `instances` | `linode-instances` | read | GET | `/linode/instances` | - |
| `instance` | `linode-instance` | read | GET | `/linode/instances/{linodeId}` | `linodeId` |
| `volumes` | `linode-volumes` | read | GET | `/volumes` | - |
| `domains` | `linode-domains` | read | GET | `/domains` | - |
| `regions` | `linode-regions` | read | GET | `/regions` | - |

## Tools Exposed

- `linode-account`
- `linode-instances`
- `linode-instance`
- `linode-volumes`
- `linode-domains`
- `linode-regions`
