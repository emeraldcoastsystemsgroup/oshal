# =============================================================================
# LEGACY / DEV-COMPAT IMAGE - NOT THE CANONICAL HOSTED OSHAL BUILD
# =============================================================================
# USE THIS ONLY WHEN A LEGACY COMPOSE OR INSTALLER PATH EXPLICITLY REFERENCES
# THE ROOT DOCKERFILE.
#
# Correct production/local OSHAL runtime:
#
#   docker build -f Dockerfile.oshal -t oshal-bot:latest .
#
# Why this file remains:
#   - older docker-compose.yml / docker-compose.core.yml / docker-compose.dev.yml
#     paths still reference the root Dockerfile
#   - some installer/k8s conversion scripts still package it for compatibility
#
# Do not use this file for the hosted cockpit, Harbor/Gardener releases, or the
# main docker-compose.oshal-local.yml stack.
# =============================================================================
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Labeled root Dockerfile as
#                      |                            | legacy/dev-compatible and
#                      |                            | pointed production builds
#                      |                            | to Dockerfile.oshal.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of API server containerization
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed copy set for Vite build and startup dependencies
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Added Cline CLI and Claude Code CLI installation for agent support
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Added standalone chat UI assets and modular Vite config to image build
# 6 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution/timestamps per governance rules
# 7 | maintainer@emeraldcoastsystemsgroup.com   | Exposed OpenAI Codex callback port 1455 to support upstream OAuth redirect target
# 8 | maintainer@emeraldcoastsystemsgroup.com   | Copied codicon font assets into image for /fonts static route used by chat UI
# 9 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated shared workspace directory mount point for upcoming hive-mode shared spaces
# 10 | maintainer@emeraldcoastsystemsgroup.com   | Expanded API image with baseline any-bot style devops CLIs (kubectl/helm/argocd/terraform/vault/aws/gcloud/gh/glab/yq/docker-compose)
# 11 | maintainer@emeraldcoastsystemsgroup.com   | Made HashiCorp CLI unzip steps non-interactive to prevent Docker build failure on duplicate LICENSE prompts
# 12 | maintainer@emeraldcoastsystemsgroup.com   | Switched GitLab CLI install to Alpine package manager for architecture-safe image builds
# 13 | maintainer@emeraldcoastsystemsgroup.com   | Copied the full any-bot ui-enhanced asset tree so the converted OSHAL server can serve /ui-enhanced routes in containers
# 14 | maintainer@emeraldcoastsystemsgroup.com   | Added bot-personas copy and bot-entrypoint.sh for per-container swarm architecture
# 15 | maintainer@emeraldcoastsystemsgroup.com   | B4/CM-2: Removed legacy any-bot/ui-enhanced COPY — codicon fonts now served from @vscode/codicons npm package
# =============================================================================

# Use official Node.js 20 LTS Alpine image for minimal footprint
FROM node:20-alpine

LABEL oshal.image.role="legacy-dev-compatible" \
      oshal.image.source_of_truth="false" \
      oshal.image.correct_dockerfile="Dockerfile.oshal"

# Install system dependencies needed for Cline CLI and Claude Code
RUN apk add --no-cache \
    bash \
    git \
    python3 \
    py3-pip \
    curl \
    wget \
    unzip \
    tar \
    gzip \
    jq \
    openssh-client \
    openssl \
    ca-certificates \
    docker-cli \
    docker-cli-compose \
    sqlite \
    graphviz

# Install agent CLIs globally
RUN npm install -g cline@latest @anthropic-ai/claude-code@latest @openai/codex@latest

# Install Python MCP server tooling (uvx for running MCP servers)
RUN pip3 install --break-system-packages uv

# Install yq (YAML processor)
RUN wget -q https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# Install kubectl
RUN curl -L "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

# Install Terraform
ENV TERRAFORM_VERSION=1.9.8
RUN wget -q "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -O /tmp/terraform.zip && \
    unzip -qo /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip

# Install HashiCorp Vault CLI
ENV VAULT_VERSION=1.18.5
RUN wget -q "https://releases.hashicorp.com/vault/${VAULT_VERSION}/vault_${VAULT_VERSION}_linux_amd64.zip" -O /tmp/vault.zip && \
    unzip -qo /tmp/vault.zip -d /usr/local/bin && \
    rm /tmp/vault.zip

# Install cloud/automation CLIs through pip where Alpine-compatible
RUN pip3 install --break-system-packages --no-cache-dir awscli ansible azure-cli

# Install gcloud CLI
RUN wget -q https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz -O /tmp/google-cloud-cli.tar.gz && \
    tar -xzf /tmp/google-cloud-cli.tar.gz -C /tmp && \
    /tmp/google-cloud-sdk/install.sh --quiet --path-update=false --usage-reporting=false && \
    ln -sf /tmp/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud && \
    ln -sf /tmp/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil && \
    rm -rf /tmp/google-cloud-sdk /tmp/google-cloud-cli.tar.gz

# Install GitHub and GitLab CLIs
RUN apk add --no-cache github-cli glab

# Install Argo CD CLI
RUN curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64 && \
    chmod +x /usr/local/bin/argocd

# Install Helm
RUN curl -sSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Set working directory inside container
WORKDIR /app

# Copy package manifests for dependency installation
# Copying these separately leverages Docker layer caching
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev) for the Vite build step
# Using npm ci ensures reproducible builds from package-lock.json
# Using --legacy-peer-deps to resolve zod@3.21.4 vs @anthropic-ai/sdk requiring zod@^3.25.0
RUN npm ci --legacy-peer-deps

# Copy Vite config (required for build step)
COPY vite.config.js ./
COPY vite.config.ts ./

# Copy source code needed for the Vite build and API server
# chat-ui.jsx imports from src/features/ and src/shared/, and the server mounts
# standalone engineering pages directly from src/pages at runtime.
COPY src/api/ ./src/api/
COPY src/features/ ./src/features/
COPY src/shared/ ./src/shared/
COPY src/entities/ ./src/entities/
COPY src/app/ ./src/app/
COPY src/pages/ ./src/pages/

# Copy backend-only TypeScript config for server build
COPY tsconfig.server.json ./

# Copy scripts for container startup (selective — avoids BuildKit issues with dev-only files)
RUN mkdir -p /app/scripts
COPY scripts/container-start.sh ./scripts/
COPY scripts/bot-entrypoint.sh ./scripts/
COPY scripts/setup-cline-auth.sh ./scripts/
COPY scripts/swarm-bot-lifecycle.sh ./scripts/
COPY scripts/oshal-*.js ./scripts/
COPY scripts/migrations/ ./scripts/migrations/

# Copy any-bot UI cockpit assets referenced by the converted OSHAL server
COPY any-bot/ui-cockpit/ ./any-bot/ui-cockpit/
# The bot-node runtime (dist/app/bot-node-server.js) requires the any-bot server tree at runtime
# (utils/config, stores/*, controllers/*, services/* incl. services/tools/<app> surface pages).
# any-bot has no own node_modules — it uses /app/node_modules. Without this, bot-node containers
# crash ("Cannot find module '../../any-bot/server/utils/config'") and every app surface 404s.
COPY any-bot/server/ ./any-bot/server/
# B4/CM-2: Codicon fonts now served from node_modules/@vscode/codicons/dist — legacy ui-enhanced COPY removed

# Build chat UI and copy static bundle for serving
RUN npm run build:chat && cp src/pages/chat/ui/chat-standalone.html src/api/chat-standalone.html

# Build TypeScript API server (backend only)
RUN npx tsc -p tsconfig.server.json && npx tsc-alias -p tsconfig.server.json

# tsc only emits .js. Keep shared design CSS beside dist/app/server.js so
# /shared/ui/css resolves in production images even when source assets are not
# mounted or a deploy path prunes src/ after build.
RUN mkdir -p dist/shared/ui/css && cp -r src/shared/ui/css/. dist/shared/ui/css/

# Copy chat.html for static serving
COPY src/api/chat.html ./dist/chat.html

# Copy bot persona YAML files for per-container swarm mode
COPY ai-lab/bot-personas/ ./ai-lab/bot-personas/

# Make entrypoint scripts executable
RUN chmod +x /app/scripts/container-start.sh 2>/dev/null || true && \
    chmod +x /app/scripts/bot-entrypoint.sh 2>/dev/null || true && \
    chmod +x /app/scripts/swarm-bot-lifecycle.sh 2>/dev/null || true

# Create workspace and data directories for agent operations
RUN mkdir -p /app/workspace /app/workspace-shared /app/data /app/logs /app/output

# Prune dev dependencies for smaller production image
# Using --legacy-peer-deps to resolve zod@3.21.4 vs @anthropic-ai/sdk requiring zod@^3.25.0
RUN npm prune --production --legacy-peer-deps

# Expose API server port (must match PORT in .env or default 3456)
EXPOSE 3456
EXPOSE 1455

# Set default environment variables (can be overridden in docker-compose.yml)
ENV NODE_ENV=production
ENV PORT=3456
ENV SWARM_MODE=single
ENV LLM_PROVIDER=claude-code
ENV BOT_PERSONA_FILE=""
ENV BOT_NAME=""
ENV AGENT_ID=""

# Health check to verify API server is responding
# Checks /health endpoint every 30s, fails after 3 consecutive failures
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3456) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the API server with Cline CLI auth setup
CMD ["bash", "-c", "bash /app/scripts/setup-cline-auth.sh 2>&1; node dist/app/server.js"]
