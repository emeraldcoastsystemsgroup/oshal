# Wix connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `wix` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.wixapis.com` |
| **Auth** | API key in header `Authorization` |
| **Icon** | Wix (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `site-properties` | `wix-site-properties` | read | GET | `/site-properties/v4/properties` | - |
| `members` | `wix-members` | read | GET | `/members/v1/members` | - |
| `member` | `wix-member` | read | GET | `/members/v1/members/{member_id}` | `member_id` |

## Tools Exposed

- `wix-site-properties`
- `wix-members`
- `wix-member`
