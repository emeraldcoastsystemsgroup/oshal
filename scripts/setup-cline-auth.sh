#!/bin/bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# DATE         | AUTHOR  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation - Cline CLI auth setup for oshal
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Use LLM_PROVIDER env var, preserve existing OAuth tokens on PVC
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
# =============================================================================
#
# Non-interactive Cline CLI authentication for containers
# Run on container startup to configure Cline CLI with the configured LLM provider
# Preserves existing OAuth tokens when /root/.cline is mounted on a PVC
#
# Usage: bash scripts/setup-cline-auth.sh

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "oshal Cline CLI Authentication Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check if Cline CLI is installed
if ! command -v cline &> /dev/null; then
  echo "⚠️  Cline CLI not found - agent will use noop provider fallback"
  exit 0
fi

CLINE_VERSION=$(timeout 5 cline --version 2>&1 | head -1 || echo "unknown")
echo "✓ Cline CLI installed: $CLINE_VERSION"

# Check if Claude Code CLI is installed
if command -v claude &> /dev/null; then
  CLAUDE_VERSION=$(timeout 5 claude --version 2>&1 | head -1 || echo "unknown")
  echo "✓ Claude Code CLI installed: $CLAUDE_VERSION"
else
  echo "⚠️  Claude Code CLI not found"
fi

# Ensure cline is accessible at standard paths
mkdir -p "$HOME/.local/bin" 2>/dev/null || true
ln -sf "$(which cline)" "$HOME/.local/bin/cline" 2>/dev/null || true

# Check for Anthropic API key (required for Claude Code provider)
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠️  ANTHROPIC_API_KEY not set - Cline CLI will not be available"
  echo "   Set ANTHROPIC_API_KEY in .env or docker-compose.yml"
  echo "   Falling back to noop provider"
  exit 0
fi

echo "✓ Anthropic API key found"
echo "   Key: ${ANTHROPIC_API_KEY:0:12}..."

# Provider and model from environment (respect .env / compose overrides)
CLINE_PROVIDER="${LLM_PROVIDER:-claude-code}"
CLINE_MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"
echo "   Provider: ${CLINE_PROVIDER}"
echo "   Model: ${CLINE_MODEL}"

# Create Cline config directories
mkdir -p ~/.cline/data

# Write Cline CLI configuration (always update — provider/model may change)
echo "Writing Cline CLI configuration..."
cat > ~/.cline/config.json <<EOF
{
  "provider": "${CLINE_PROVIDER}",
  "model": "${CLINE_MODEL}",
  "autoApprove": true
}
EOF
echo "✓ Cline config written to ~/.cline/config.json"

# Generate mock ~/.claude.json for Claude Code OAuth
echo "Generating Claude Code auth config..."
cat > ~/.claude.json <<EOF
{
  "oauthAccount": {
    "accountUuid": "oshal-agent-uuid",
    "emailAddress": "agent@oshal.local",
    "organizationUuid": "oshal-org-uuid"
  }
}
EOF
echo "✓ Claude Code auth config created"

# Write or merge global state for Cline CLI
# If globalState.json already exists (PVC), merge provider/model but preserve OAuth tokens
GS_FILE="$HOME/.cline/data/globalState.json"

if [ -f "$GS_FILE" ] && command -v python3 &> /dev/null; then
  echo "Merging provider/model into existing globalState (preserving OAuth tokens)..."
  python3 -c "
import json, sys
f = '$GS_FILE'
provider = '$CLINE_PROVIDER'
model = '$CLINE_MODEL'
try:
    d = json.load(open(f))
except:
    sys.exit(1)

d['actModeApiProvider'] = provider
d['planModeApiProvider'] = provider
d['actModeApiModelId'] = model
d['planModeApiModelId'] = model
json.dump(d, open(f, 'w'), indent=2)
print('✓ Merged provider/model, OAuth tokens preserved')
" 2>&1 || {
    echo "⚠️  Merge failed, writing fresh globalState"
    rm -f "$GS_FILE"
  }
fi

# Write fresh globalState if it doesn't exist (first boot or merge failed)
if [ ! -f "$GS_FILE" ]; then
  cat > "$GS_FILE" <<EOF
{
  "welcomeViewCompleted": true,
  "remoteRulesToggles": {},
  "remoteWorkflowToggles": {},
  "mode": "act",
  "actModeThinkingBudgetTokens": 0,
  "yoloModeToggled": true,
  "actModeApiProvider": "${CLINE_PROVIDER}",
  "planModeApiProvider": "${CLINE_PROVIDER}",
  "actModeApiModelId": "${CLINE_MODEL}",
  "planModeApiModelId": "${CLINE_MODEL}",
  "autoApprovalSettings": {
    "version": 3,
    "enabled": true,
    "favorites": [],
    "maxRequests": 20,
    "actions": {
      "readFiles": true,
      "readFilesExternally": false,
      "editFiles": false,
      "editFilesExternally": false,
      "executeSafeCommands": true,
      "executeAllCommands": false,
      "useBrowser": false,
      "useMcp": true
    },
    "enableNotifications": false
  },
  "workspaceRoots": [
    {
      "path": "/app/workspace",
      "name": "workspace",
      "vcs": "git",
      "commitHash": ""
    }
  ],
  "primaryRootIndex": 0,
  "globalWorkflowToggles": {},
  "globalClineRulesToggles": {}
}
EOF
  echo "✓ Global state written to $GS_FILE"
fi

# Create ensure-model-config helper script
# Called by ClineCLIWrapper before each CLI spawn to restore model config
cat > ~/.cline/ensure-model-config.sh << 'ENSURE_SCRIPT'
#!/bin/bash
PROVIDER="${LLM_PROVIDER:-claude-code}"
MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"
GS_FILE="$HOME/.cline/data/globalState.json"

if [ ! -f "$GS_FILE" ]; then
  exit 0
fi

python3 -c "
import json, sys
f = '$GS_FILE'
provider = '$PROVIDER'
model = '$MODEL'
try:
    d = json.load(open(f))
except:
    sys.exit(0)

changed = False
fields = {
    'actModeApiProvider': provider,
    'planModeApiProvider': provider,
    'actModeApiModelId': model,
    'planModeApiModelId': model,
}
for k, v in fields.items():
    if d.get(k) != v:
        d[k] = v
        changed = True

if changed:
    json.dump(d, open(f, 'w'), indent=2)
    print(f'[ensure-model-config] Restored config: provider={provider} model={model}')
else:
    print(f'[ensure-model-config] Config OK: provider={provider} model={model}')
" 2>&1
ENSURE_SCRIPT
chmod +x ~/.cline/ensure-model-config.sh
echo "✓ ensure-model-config.sh created"

# Write MCP servers configuration
echo "Writing MCP servers configuration..."
cat > ~/.cline/mcp_settings.json <<EOF
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/app"]
    },
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
EOF
echo "✓ MCP servers config written"

# Configure Claude Code CLI (empty settings - LLM backend only)
mkdir -p ~/.claude
cat > ~/.claude/settings.json <<EOF
{}
EOF
echo "✓ Claude Code CLI config written"

# Verify configuration
MCP_COUNT=$(jq '.mcpServers | length' ~/.cline/mcp_settings.json 2>/dev/null || echo "0")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Cline CLI authenticated and ready"
echo "   Provider: ${CLINE_PROVIDER}"
echo "   Model: ${CLINE_MODEL}"
echo "   MCP Servers: ${MCP_COUNT} configured"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
