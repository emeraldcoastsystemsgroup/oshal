#!/bin/bash
# ERROR #12: Auto-configure Cline CLI for GovCloud in Code Server
# Run this inside the Code Server container or local VS Code terminal

set -e

echo "🔧 Configuring Cline CLI for AWS GovCloud..."

# Set AWS GovCloud region
export AWS_DEFAULT_REGION="us-gov-west-1"
export AWS_REGION="us-gov-west-1"

# Configure Cline CLI settings
CLINE_SETTINGS_DIR="$HOME/.cline"
mkdir -p "$CLINE_SETTINGS_DIR"

# Write GovCloud config
cat > "$CLINE_SETTINGS_DIR/config.json" << 'EOF'
{
  "provider": "bedrock",
  "region": "us-gov-west-1",
  "model": "us-gov.anthropic.claude-3-5-sonnet-20241022-v2:0",
  "crossRegionInference": false,
  "autoApprove": {
    "safeCommands": true,
    "fileReads": true,
    "fileWrites": false
  }
}
EOF

echo "✅ Cline CLI configured for GovCloud"
echo "   Region: us-gov-west-1"
echo "   Model: Claude 3.5 Sonnet v2"
echo "   Config: $CLINE_SETTINGS_DIR/config.json"
echo ""
echo "📌 Make sure AWS credentials are configured:"
echo "   aws configure --profile govcloud"
echo "   export AWS_PROFILE=govcloud"
