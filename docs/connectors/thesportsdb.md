# TheSportsDB connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `thesportsdb` |
| **Version** | 1.0.0 |
| **Base URL** | `https://www.thesportsdb.com/api/v1/json/3` |
| **Auth** | None |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search-teams` | `thesportsdb-search-teams` | read | GET | `/searchteams.php` | `q` |
| `lookup-team` | `thesportsdb-lookup-team` | read | GET | `/lookupteam.php` | `q` |
| `next-league-events` | `thesportsdb-next-league-events` | read | GET | `/eventsnextleague.php` | `q` |

## Tools Exposed

- `thesportsdb-search-teams`
- `thesportsdb-lookup-team`
- `thesportsdb-next-league-events`
