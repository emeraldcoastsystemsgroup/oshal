# Moralis connector

> Auto-generated from `connector.yaml` by `specToMarkdown` (ADR-065). Do not edit by hand - change the spec.

| | |
| --- | --- |
| **Provider** | `moralis` |
| **Version** | 1.0.0 |
| **Base URL** | `https://deep-index.moralis.io/api/v2.2` |
| **Auth** | API key in header `X-API-Key` |
| **Description** | Moralis — reads native balance, wallet nfts, erc20 price via deep-index.moralis.io. Bring your own key: each user pastes their own token, held per-user in the encrypted connection store. |
| **Rate limit** | burst 10, 10/s |
| **Retry** | up to 3, honors Retry-After |

## Resources

| Resource | Tool | Action | Method | Path | Inputs |
| --- | --- | --- | --- | --- | --- |
| `native-balance` | `moralis-native-balance` | read | GET | `/{address}/balance` | `address`, `chain` |
| `wallet-nfts` | `moralis-wallet-nfts` | read | GET | `/{address}/nft` | `address`, `chain` |
| `erc20-price` | `moralis-erc20-price` | read | GET | `/erc20/{address}/price` | `address`, `chain` |

## Tools Exposed

- `moralis-native-balance`
- `moralis-wallet-nfts`
- `moralis-erc20-price`
