#!/bin/sh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# DATE         | AUTHOR  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Automated UI test script: builds, runs container, checks /ui endpoint
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated to use docker compose, health checks, and Playwright E2E tests
# =============================================================================

set -e

IMAGE_NAME="cline-chat-ui"
CONTAINER_NAME="cline-chat-ui-test"
PORT=3456

echo "=== Step 1: Building Docker image ==="
docker build -t $IMAGE_NAME .

echo "=== Step 2: Stopping any existing test container ==="
docker stop $CONTAINER_NAME 2>/dev/null || true

echo "=== Step 3: Running container ==="
docker run -d --rm -p $PORT:$PORT --name $CONTAINER_NAME $IMAGE_NAME

echo "=== Step 4: Waiting for server to start ==="
RETRIES=10
while [ $RETRIES -gt 0 ]; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/health 2>/dev/null || echo "000")
  if [ "$STATUS" -eq 200 ]; then
    echo "✅ Server healthy at http://localhost:$PORT/health"
    break
  fi
  echo "  Waiting for server... ($RETRIES retries left)"
  sleep 2
  RETRIES=$((RETRIES - 1))
done

if [ "$STATUS" -ne 200 ]; then
  echo "❌ Server failed to start. Container logs:"
  docker logs $CONTAINER_NAME
  docker stop $CONTAINER_NAME
  exit 1
fi

echo "=== Step 5: Verifying UI endpoint ==="
UI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/ui)
if [ "$UI_STATUS" -eq 200 ]; then
  echo "✅ UI is reachable at http://localhost:$PORT/ui"
else
  echo "❌ UI is NOT reachable (HTTP $UI_STATUS)"
  docker logs $CONTAINER_NAME
  docker stop $CONTAINER_NAME
  exit 1
fi

echo "=== Step 6: Running Playwright E2E tests ==="
npx playwright test tests/chat-ui.spec.ts --reporter=list
TEST_EXIT=$?

echo "=== Step 7: Stopping container ==="
docker stop $CONTAINER_NAME

if [ $TEST_EXIT -eq 0 ]; then
  echo ""
  echo "✅ All tests passed!"
  exit 0
else
  echo ""
  echo "❌ Some tests failed (exit code $TEST_EXIT)"
  exit $TEST_EXIT
fi