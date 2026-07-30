#!/bin/sh
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Automated container start script: builds chat UI, copies static bundle, starts server
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Skip build in dev mode - bundles already built in Docker image
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed trailing whitespace and normalized shell Change Log formatting for diff hygiene
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the `cp src/api/dist/chat-ui.js src/api/chat-ui.js` step. It was the vestige of an
#   | older serve layout: vite now emits to src/api/dist and all three HTML surfaces load
#   | `dist/chat-ui.js` (mounted at /dist from src/api/dist by resolveUiAssetPaths), while src/api
#   | itself is NOT statically mounted (server.ts's express.static(apiDir) is commented out). So the
#   | copy's destination was served by nothing, and the 236 KB bundle it shadowed was tracked in git
#   | purely as build output. Destination file deleted in the same change.

set -e

# In dev mode, bundles are already built into the Docker image
# Skip rebuild to avoid vite dependency issues with bind mounts
if [ "$NODE_ENV" = "development" ]; then
  echo "Dev mode detected - skipping bundle rebuild (using pre-built bundles from image)"
else
  echo "Building chat UI bundle..."
  # Output lands in src/api/dist, which is what the /dist static mount serves. No copy step:
  # src/api is not statically mounted, so src/api/chat-ui.js would be unreachable.
  npm run build:chat
fi

echo "Starting API server..."
exec node dist/app/server.js
