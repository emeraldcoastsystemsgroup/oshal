#!/bin/bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# DATE         | AUTHOR  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial script to automate Keycloak realm import via Admin REST API

set -e

KEYCLOAK_URL="http://localhost:8080"
KEYCLOAK_USER="admin"
KEYCLOAK_PASS="admin"
REALM_FILE="infra/keycloak/realm-export.json"
REALM_NAME="oshal"

echo "Waiting for Keycloak to be up..."
until curl -s "$KEYCLOAK_URL/realms/master/.well-known/openid-configuration" | grep -q issuer; do
  sleep 2
done
echo "Keycloak is up."

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

echo "Importing realm from $REALM_FILE..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KEYCLOAK_URL/admin/realms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$REALM_FILE")

if [ "$HTTP_CODE" == "201" ] || [ "$HTTP_CODE" == "409" ]; then
  echo "Realm import successful or already exists (HTTP $HTTP_CODE)."
else
  echo "Realm import failed (HTTP $HTTP_CODE)."
  exit 1
fi

echo "Verifying realm and client existence..."
REALM_EXISTS=$(curl -s -H "Authorization: Bearer $TOKEN" "$KEYCLOAK_URL/admin/realms/$REALM_NAME" | jq -r .realm)
CLIENT_EXISTS=$(curl -s -H "Authorization: Bearer $TOKEN" "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients" | jq -r '.[] | select(.clientId=="oshal-swarm") | .clientId')

if [ "$REALM_EXISTS" == "$REALM_NAME" ] && [ "$CLIENT_EXISTS" == "oshal-swarm" ]; then
  echo "Realm '$REALM_NAME' and client 'oshal-swarm' are present."
  exit 0
else
  echo "Verification failed: Realm or client missing."
  exit 1
fi