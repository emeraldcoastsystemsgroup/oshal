# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Docker-based installer image for local no-registry distribution of the any-bot Kubernetes setup workflow
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Repointed the installer image payload to the converted OSHAL root runtime build context
# =============================================================================

FROM node:20-alpine

RUN apk add --no-cache bash python3 curl docker-cli tar gzip && \
    curl -Lo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x /usr/local/bin/kubectl

WORKDIR /opt/oshal-installer

COPY Dockerfile /opt/oshal-installer/Dockerfile
COPY package.json /opt/oshal-installer/package.json
COPY package-lock.json /opt/oshal-installer/package-lock.json
COPY vite.config.js /opt/oshal-installer/vite.config.js
COPY vite.config.ts /opt/oshal-installer/vite.config.ts
COPY tsconfig.server.json /opt/oshal-installer/tsconfig.server.json

COPY scripts /opt/oshal-installer/scripts
COPY any-bot-k8s /opt/oshal-installer/any-bot-k8s
COPY docs/k8 /opt/oshal-installer/docs/k8

COPY src/api /opt/oshal-installer/src/api
COPY src/features /opt/oshal-installer/src/features
COPY src/shared /opt/oshal-installer/src/shared
COPY src/entities /opt/oshal-installer/src/entities
COPY src/app /opt/oshal-installer/src/app
COPY src/pages/chat/ui /opt/oshal-installer/src/pages/chat/ui

COPY any-bot/ui-cockpit /opt/oshal-installer/any-bot/ui-cockpit
COPY any-bot/ui-enhanced /opt/oshal-installer/any-bot/ui-enhanced

RUN chmod +x /opt/oshal-installer/scripts/setup-any-bot-k8s.sh

WORKDIR /workspace

ENTRYPOINT ["node", "/opt/oshal-installer/scripts/setup-any-bot-k8s-cli.js"]