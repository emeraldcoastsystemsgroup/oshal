#!/bin/bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# DATE         | AUTHOR  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Script to add a test user to the oshal realm via Keycloak Admin API

set -e

KEYCLOAK_URL="http://localhost:8080"
KEYCLOAK_USER="admin"
KEYCLOAK_PASS="admin"
REALM_NAME="oshal"
TEST_USER="testuser"
TEST_PASS="testpass"

echo "Getting admin access token..."
TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$KEYCLOAK_USER" \
  -d "password=$KEYCLOAK_PASS" \
  -d 'grant_type=password' \
  -d 'client_id=admin-cli' | jq -r .access_token)

if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
  echo "Failed to get admin token. Check Keycloak credentials."
  exit 1
fi

echo "Creating test user '$TEST_USER' in realm '$REALM_NAME'..."
USER_ID=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"enabled\":true,\"emailVerified\":true}")

if [ "$USER_ID" == "201" ] || [ "$USER_ID" == "409" ]; then
  echo "Test user created or already exists (HTTP $USER_ID)."
else
  echo "Failed to create test user (HTTP $USER_ID)."
  exit 1
fi

echo "Setting password for test user..."
USER_UUID=$(curl -s -H "Authorization: Bearer $TOKEN" "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users?username=$TEST_USER" | jq -r '.[0].id')
curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/$USER_UUID/reset-password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"password\",\"value\":\"$TEST_PASS\",\"temporary\":false}"

echo "Test user '$TEST_USER' with password '$TEST_PASS' is ready in realm '$REALM_NAME'."