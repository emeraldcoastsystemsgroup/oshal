# Discourse connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `discourse` |
| **Version** | 1.0.0 |
| **Base URL** | `https://your-forum.example.com` |
| **Auth** | API key in header `Api-Key` |
| **Icon** | Discourse (verified) |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `latest-topics` | `discourse-latest-topics` | read | GET | `/latest.json` | - |
| `top-topics` | `discourse-top-topics` | read | GET | `/top.json` | - |
| `topic` | `discourse-topic` | read | GET | `/t/{id}.json` | `id` |
| `category-topics` | `discourse-category-topics` | read | GET | `/c/{category_id}.json` | `category_id` |
| `categories` | `discourse-categories` | read | GET | `/categories.json` | - |
| `user` | `discourse-user` | read | GET | `/users/{username}.json` | `username` |

## Tools Exposed

- `discourse-latest-topics`
- `discourse-top-topics`
- `discourse-topic`
- `discourse-category-topics`
- `discourse-categories`
- `discourse-user`
