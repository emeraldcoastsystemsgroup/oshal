#!/bin/sh
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Automated container start script: builds chat UI, copies static bundle, starts server
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Skip build in dev mode - bundles already built in Docker image
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed trailing whitespace and normalized shell Change Log formatting for diff hygiene

set -e

# In dev mode, bundles are already built into the Docker image
# Skip rebuild to avoid vite dependency issues with bind mounts
if [ "$NODE_ENV" = "development" ]; then
  echo "Dev mode detected - skipping bundle rebuild (using pre-built bundles from image)"
else
  echo "Building chat UI bundle..."
  npm run build:chat

  echo "Copying built chat-ui.js to static serve location..."
  cp src/api/dist/chat-ui.js src/api/chat-ui.js
fi

echo "Starting API server..."
exec node dist/app/server.js
