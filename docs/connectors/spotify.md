# Spotify connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `spotify` |
| **Version** | 1.0.0 |
| **Base URL** | `https://api.spotify.com/v1` |
| **Auth** | OAuth2 (bearer) - scopes: playlist-modify-private, playlist-modify-public, user-top-read, user-read-currently-playing, user-read-private |
| **Description** | Read the connected Spotify profile, current playback, playlists, and top tracks, with resources to create playlists and add tracks. |
| **Icon** | Spotify (verified) |
| **Rate limit** | burst 10, 5/s |
| **Retry** | up to 3, honors Retry-After |
| **Pagination** | link |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `me` | `spotify-me` | read | GET | `/me` | - |
| `search-tracks` | `spotify-search` | read | GET | `/search` | `query`, `limit`, `market` |
| `now-playing` | `spotify-now-playing` | read | GET | `/me/player/currently-playing` | - |
| `my-playlists` | `spotify-playlists` | read | GET | `/me/playlists` | - |
| `top-tracks` | `spotify-top-tracks` | read | GET | `/me/top/tracks` | `limit` |
| `create-playlist` | `spotify-create-playlist` | write (confirm) | POST | `/users/{userId}/playlists` | `userId`, `name`, `description` |
| `add-tracks` | `spotify-add-tracks` | write (confirm) | POST | `/playlists/{playlistId}/tracks` | `playlistId`, `uris` |

## Tools Exposed

- `spotify-me`
- `spotify-search`
- `spotify-now-playing`
- `spotify-playlists`
- `spotify-top-tracks`
- `spotify-create-playlist`
- `spotify-add-tracks`
