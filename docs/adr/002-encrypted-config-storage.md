# ADR-002: Encrypted Configuration Storage

## Status
**Accepted** — 2026-03-07

## Context
The API Configuration Module (`src/api/`) persists provider credentials (API keys, OAuth tokens, session tokens) to the filesystem. The current implementation writes secrets to plain JSON files (`secrets.json`). While the split write mode separates secrets from settings, the secrets file remains unencrypted on disk.

For a production swarm system (oshal) handling credentials for 40+ API providers, plaintext secret storage is insufficient:

- API keys in plaintext are a security risk if the filesystem is compromised
- Multi-user environments require credential isolation
- Compliance standards (SOC 2, ISO 27001) mandate encryption at rest
- The oshal rebuild must establish secure patterns from the foundation

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **Node.js `crypto` AES-256-GCM** | Zero dependencies, built-in, authenticated encryption, simple | File-based, no query capability |
| **SQLite + sqlcipher** | Query capability, structured storage, encryption built-in | Native compilation (C++), heavy dependency, overkill for key-value config |
| **Encrypted JSON with `libsodium`** | Strong crypto, well-audited | External dependency, larger attack surface |

## Decision
Use **Node.js built-in `crypto` module with AES-256-GCM** for encrypting configuration secrets at rest.

### Specifics
- **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
- **Key derivation**: PBKDF2 with 100,000 iterations, SHA-512, 32-byte random salt
- **Key source**: `ENCRYPTION_KEY` environment variable (loaded from `.env`)
- **Storage format**: JSON envelope containing `{ salt, iv, authTag, ciphertext }` (all base64-encoded)
- **File**: `secrets.enc.json` replaces `secrets.json` when encryption is enabled
- **Backward compatibility**: If no `ENCRYPTION_KEY` is set, falls back to plain JSON (`secrets.json`)

### Why AES-256-GCM?
- **Authenticated**: GCM mode provides both confidentiality and integrity — tampering is detected
- **Standard**: NIST-approved, widely used in TLS 1.3, AWS S3 SSE
- **Built-in**: No external dependencies — aligns with the project's minimal-dependency philosophy
- **Performance**: Hardware-accelerated on modern CPUs (AES-NI)

### Why not SQLite?
- Adds `better-sqlite3` (native C++ addon) + `sqlcipher` — significant compilation and portability burden
- Config data is simple key-value pairs, not relational — no query advantage
- Overkill for the current use case (single-file secret storage)

## Consequences

### Positive
- Secrets encrypted at rest with authenticated encryption
- Zero new native dependencies
- Simple migration path from plain JSON
- Key rotation supported without data loss
- Backward compatible — unencrypted mode still works

### Negative
- File-based storage limits future query patterns (acceptable for config data)
- PBKDF2 key derivation adds ~100ms on first encrypt/decrypt (acceptable, not in hot path)
- Master key in environment variable requires secure `.env` file permissions
- No multi-user key isolation (single master key for all secrets)

### Risks
- If `ENCRYPTION_KEY` is lost, encrypted secrets are unrecoverable — must document backup procedures
- `.env` file must be excluded from version control (already in `.gitignore`)

## References
- [Node.js crypto documentation](https://nodejs.org/api/crypto.html)
- [NIST SP 800-38D: GCM Specification](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)