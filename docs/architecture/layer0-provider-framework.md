<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Layer 0 architecture documentation
-->

# Layer 0: Provider Framework Architecture

## Overview

Layer 0 is the **Provider Framework** — the foundational abstraction that exposes the runtime's registered LLM providers through a unified configuration and execution interface. It handles provider registration, encrypted credential storage, model selection, and runtime provider resolution. The registry is authoritative; the 2026-07-23 unit run initialized 42 definitions.

## High-Level Architecture

```mermaid
graph TB
    subgraph "UI Layer"
        UI[API Configuration Page<br/>api-config.html]
    end

    subgraph "API Layer"
        API["/api/config/*<br/>Express Routes"]
    end

    subgraph "Feature Layer — provider-config"
        SVC[ConfigService<br/>Orchestration]
        ECM[EncryptedConfigManager<br/>Secrets Handling]
    end

    subgraph "Entity Layer — providers"
        PR[ProviderRegistry<br/>Runtime provider definitions]
        PD[provider-definitions.ts<br/>Models & Metadata]
    end

    subgraph "Shared Layer"
        DB[(PostgreSQL<br/>provider_configs table)]
        CRYPTO[CryptoUtils<br/>AES-256 Encryption]
        LOG[Pino Logger]
    end

    UI -->|HTTP POST/GET| API
    API --> SVC
    SVC --> ECM
    SVC --> PR
    ECM --> CRYPTO
    ECM --> DB
    PR --> PD
    SVC --> LOG
```

## Component Details

### 1. Provider Registry (`src/entities/providers/`)

The **ProviderRegistry** is the central catalog of all supported LLM providers. It is a static, read-only registry that maps provider keys to their definitions.

```mermaid
classDiagram
    class ProviderRegistry {
        -providers: Map~string, ProviderDefinition~
        +getProvider(key: string): ProviderDefinition
        +getAllProviders(): ProviderDefinition[]
        +getProvidersByCategory(cat: string): ProviderDefinition[]
        +isValidProvider(key: string): boolean
    }

    class ProviderDefinition {
        +key: string
        +name: string
        +category: ProviderCategory
        +models: ModelDefinition[]
        +requiredFields: FieldDefinition[]
        +optionalFields: FieldDefinition[]
        +documentationUrl: string
    }

    class ModelDefinition {
        +id: string
        +name: string
        +contextWindow: number
        +maxOutputTokens: number
        +capabilities: string[]
    }

    class FieldDefinition {
        +key: string
        +label: string
        +type: "text" | "password" | "select"
        +isSecret: boolean
        +placeholder: string
    }

    ProviderRegistry --> ProviderDefinition
    ProviderDefinition --> ModelDefinition
    ProviderDefinition --> FieldDefinition
```

**Registered providers** across categories:
| Category | Examples |
|----------|----------|
| Cloud AI | Anthropic, OpenAI, Google AI, AWS Bedrock, Azure OpenAI, GCP Vertex |
| Open Source | Ollama, LM Studio, vLLM, Hugging Face |
| Specialized | Cohere, Mistral, Groq, Together AI, Fireworks AI |
| Enterprise | IBM watsonx, Oracle GenAI |

### 2. Encrypted Config Manager (`src/features/provider-config/`)

The **EncryptedConfigManager** handles the separation and encryption of configuration data:

- **Settings** (non-sensitive): model selection, temperature, base URLs → stored as plaintext JSON
- **Secrets** (sensitive): API keys, client secrets, tokens → encrypted with AES-256 before storage

```mermaid
flowchart LR
    subgraph Input
        FORM[UI Form Data<br/>Mixed settings + secrets]
    end

    subgraph Separation
        SPLIT{isSecret?}
        SETTINGS[Settings Object<br/>model, temperature, etc.]
        SECRETS[Secrets Object<br/>apiKey, clientSecret, etc.]
    end

    subgraph Storage
        ENC[AES-256<br/>Encryption]
        DB[(PostgreSQL)]
    end

    FORM --> SPLIT
    SPLIT -->|No| SETTINGS
    SPLIT -->|Yes| SECRETS
    SETTINGS -->|JSON| DB
    SECRETS --> ENC -->|Encrypted blob| DB
```

### 3. Configuration Service (`src/features/provider-config/`)

The **ConfigService** orchestrates all provider configuration operations:

| Operation | Method | Description |
|-----------|--------|-------------|
| Save Config | `saveConfiguration()` | Split settings/secrets, encrypt, persist |
| Load Config | `getConfiguration()` | Fetch from DB, decrypt secrets, merge |
| List Configs | `getUserConfigurations()` | Get all configs for a user (no secrets) |
| Delete Config | `deleteConfiguration()` | Remove config and secrets |
| Test Connection | `testProviderConnection()` | Validate credentials against provider API |

## Process Flows

### Configuration Save Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as API Config UI
    participant API as /api/config
    participant SVC as ConfigService
    participant ECM as EncryptedConfigManager
    participant PR as ProviderRegistry
    participant DB as PostgreSQL

    User->>UI: Fill provider form (API key, model, etc.)
    UI->>API: POST /api/config/save
    API->>SVC: saveConfiguration(userId, provider, data)
    SVC->>PR: getProvider(providerKey)
    PR-->>SVC: ProviderDefinition (with field metadata)
    SVC->>ECM: separateAndEncrypt(data, fieldDefs)
    
    Note over ECM: Split fields by isSecret flag
    ECM->>ECM: settings = extractSettings(data)
    ECM->>ECM: secrets = extractSecrets(data)
    ECM->>ECM: encryptedSecrets = AES256.encrypt(secrets)
    
    ECM->>DB: INSERT/UPDATE provider_configs<br/>(user_id, provider, settings, encrypted_secrets)
    DB-->>ECM: Success
    ECM-->>SVC: SaveResult {settingsCount, secretsCount}
    SVC-->>API: 200 OK
    API-->>UI: Configuration saved
    UI-->>User: Success toast notification
```

### Configuration Load Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as API Config UI
    participant API as /api/config
    participant SVC as ConfigService
    participant ECM as EncryptedConfigManager
    participant DB as PostgreSQL

    User->>UI: Select provider to configure
    UI->>API: GET /api/config/:provider
    API->>SVC: getConfiguration(userId, provider)
    SVC->>DB: SELECT FROM provider_configs<br/>WHERE user_id = ? AND provider = ?
    DB-->>SVC: {settings, encrypted_secrets}
    SVC->>ECM: decryptAndMerge(settings, encrypted_secrets)
    
    Note over ECM: Decrypt secrets, merge with settings
    ECM->>ECM: secrets = AES256.decrypt(encrypted_secrets)
    ECM->>ECM: merged = {...settings, ...secrets}
    ECM->>ECM: maskedSecrets = maskSensitiveFields(merged)
    
    ECM-->>SVC: MergedConfig (secrets masked for display)
    SVC-->>API: 200 OK + config data
    API-->>UI: Config with masked secrets
    UI-->>User: Form populated with saved values
```

### Provider Selection in Chat

```mermaid
sequenceDiagram
    actor User
    participant Chat as Chat UI
    participant API as /api/chat
    participant SVC as ChatService
    participant PR as ProviderRegistry
    participant CFG as ConfigService
    participant LLM as LLM Provider API

    User->>Chat: Send message
    Chat->>API: POST /api/chat/message
    API->>SVC: processMessage(userId, agentId, message)
    SVC->>SVC: resolveProvider(agentId)
    SVC->>CFG: getConfiguration(userId, agentProvider)
    CFG-->>SVC: {apiKey, model, ...config}
    SVC->>PR: getProvider(providerKey)
    PR-->>SVC: ProviderDefinition
    SVC->>LLM: API call with decrypted credentials
    LLM-->>SVC: LLM response
    SVC-->>API: Chat response
    API-->>Chat: Message + metadata
    Chat-->>User: Display response
```

## Database Schema

```mermaid
erDiagram
    PROVIDER_CONFIGS {
        uuid id PK
        varchar user_id FK
        varchar provider_key
        jsonb settings "Non-sensitive config"
        text encrypted_secrets "AES-256 encrypted"
        varchar model_id
        timestamp created_at
        timestamp updated_at
    }

    PROVIDER_CONFIGS ||--o{ USERS : "belongs to"
```

**Key columns:**
- `user_id` — JWT `sub` claim from OIDC token
- `provider_key` — Maps to `ProviderRegistry` (e.g., `anthropic`, `openai`)
- `settings` — JSONB with non-sensitive config (model, temperature, base URL)
- `encrypted_secrets` — AES-256 encrypted blob containing API keys and tokens

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config/providers` | List all currently registered providers |
| `GET` | `/api/config/providers/:key` | Get provider definition with fields |
| `GET` | `/api/config/:provider` | Get user's config for provider (masked secrets) |
| `POST` | `/api/config/save` | Save/update provider configuration |
| `DELETE` | `/api/config/:provider` | Delete provider configuration |
| `POST` | `/api/config/test` | Test provider connection with credentials |
| `GET` | `/api/config/active` | Get user's active/configured providers |

## Security Model

```mermaid
flowchart TB
    subgraph "Authentication"
        OIDC[OIDC / Mock OIDC]
        JWT[JWT Token<br/>sub claim = user_id]
    end

    subgraph "Authorization"
        MW[requiresAuth Middleware]
        USER[req.user.sub<br/>User Identity]
    end

    subgraph "Data Protection"
        SEP[Settings / Secrets<br/>Separation]
        ENC[AES-256 Encryption<br/>at rest]
        MASK[Field Masking<br/>on read]
        SCOPE[User Scoping<br/>per-user isolation]
    end

    OIDC --> JWT --> MW --> USER
    USER --> SEP
    SEP --> ENC
    SEP --> MASK
    USER --> SCOPE
```

**Security guarantees:**
1. **Authentication required** — All config endpoints require valid OIDC/mock JWT
2. **User isolation** — Configs scoped by `user_id`; users cannot access other users' configs
3. **Encryption at rest** — Secrets encrypted with AES-256 before database storage
4. **Masked on read** — API keys shown as `****...last4` in UI responses
5. **No logging of secrets** — Pino redact rules strip sensitive fields from logs

## File Map

```
src/
├── entities/
│   └── providers/
│       ├── index.ts                  # Barrel export
│       ├── provider-registry.ts      # ProviderRegistry class
│       ├── provider-definitions.ts   # runtime provider definitions
│       └── types.ts                  # ProviderDefinition, ModelDefinition types
├── features/
│   └── provider-config/
│       ├── index.ts                  # Barrel export
│       ├── services/
│       │   ├── config-service.ts     # ConfigService orchestration
│       │   └── encrypted-config-manager.ts  # Encryption/separation
│       └── types.ts                  # SaveResult, ConfigData types
├── app/
│   └── routes/
│       └── config-routes.ts          # Express route handlers
└── shared/
    ├── db/
    │   └── postgres.ts               # Database connection pool
    └── utils/
        └── crypto.ts                 # AES-256 utilities
