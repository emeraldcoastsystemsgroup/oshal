# Movies & TV (TMDB) connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `tmdb` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.themoviedb.org/3` |
| **Auth** | API key in query param `api_key` |
| **Description** | Movies & TV (TMDB) — reads search movies, where to watch, recommendations, trending via api.themoviedb.org. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Icon** | The Movie Database (verified) |
| **Rate limit** | burst 20, 20/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | offset (`page`) |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `search-movies` | `tmdb-search` | read | GET | `/search/movie` | `query`, `page` |
| `where-to-watch` | `tmdb-watch-providers` | read | GET | `/movie/{movieId}/watch/providers` | `movieId` |
| `recommendations` | `tmdb-recommendations` | read | GET | `/movie/{movieId}/recommendations` | `movieId`, `page` |
| `trending` | `tmdb-trending` | read | GET | `/trending/movie/{window}` | `window` |

## Tools Exposed

- `tmdb-search`
- `tmdb-watch-providers`
- `tmdb-recommendations`
- `tmdb-trending`
