# VirusTotal connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `virustotal` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.virustotal.com/api/v3` |
| **Auth** | API key in header `x-apikey` |
| **Icon** | VirusTotal (verified) |
| **Rate limit** | burst 4, 4/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `domain` | `virustotal-domain` | read | GET | `/domains/{domain}` | `domain` |
| `ip` | `virustotal-ip` | read | GET | `/ip_addresses/{ip}` | `ip` |
| `file` | `virustotal-file` | read | GET | `/files/{hash}` | `hash` |
| `url` | `virustotal-url` | read | GET | `/urls/{id}` | `id` |

## Tools Exposed

- `virustotal-domain`
- `virustotal-ip`
- `virustotal-file`
- `virustotal-url`
