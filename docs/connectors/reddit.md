# Reddit connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `reddit` |
| **Version** | 1.0.0 |
| **Base URL** | `https://oauth.reddit.com` |
| **Auth** | OAuth2 (bearer) |
| **Description** | Read subreddit hot posts and metadata, user profiles, and popular subreddits. |
| **Icon** | Reddit (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `subreddit-hot` | `reddit-subreddit-hot` | read | GET | `/r/{subreddit}/hot` | `subreddit` |
| `subreddit-about` | `reddit-subreddit-about` | read | GET | `/r/{subreddit}/about` | `subreddit` |
| `user-about` | `reddit-user-about` | read | GET | `/user/{username}/about` | `username` |
| `popular-subreddits` | `reddit-popular-subreddits` | read | GET | `/subreddits/popular` | - |

## Tools Exposed

- `reddit-subreddit-hot`
- `reddit-subreddit-about`
- `reddit-user-about`
- `reddit-popular-subreddits`
