# Supabase connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `supabase` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.supabase.com/v1` |
| **Auth** | OAuth2 (bearer) |
| **Icon** | Supabase (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | none |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `organizations` | `supabase-organizations` | read | GET | `/organizations` | - |
| `projects` | `supabase-projects` | read | GET | `/projects` | - |
| `project-api-keys` | `supabase-project-api-keys` | read | GET | `/projects/{ref}/api-keys` | `ref` |
| `project-functions` | `supabase-project-functions` | read | GET | `/projects/{ref}/functions` | `ref` |
| `project-secrets` | `supabase-project-secrets` | read | GET | `/projects/{ref}/secrets` | `ref` |

## Tools Exposed

- `supabase-organizations`
- `supabase-projects`
- `supabase-project-api-keys`
- `supabase-project-functions`
- `supabase-project-secrets`
