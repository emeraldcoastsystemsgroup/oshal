#!/bin/sh
set -eu

create_role_if_missing() {
  role_name="$1"
  role_password="$2"

  if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_roles WHERE rolname='${role_name}'" | grep -q 1; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE ROLE ${role_name} LOGIN PASSWORD '${role_password}';"
  fi
}

create_database_if_missing() {
  database_name="$1"
  database_owner="$2"

  if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='${database_name}'" | grep -q 1; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE DATABASE ${database_name} OWNER ${database_owner};"
  fi
}

create_role_if_missing "oshal" "oshalpass"
create_database_if_missing "oshal" "oshal"

create_role_if_missing "keycloak" "keycloak_db_password"
create_database_if_missing "keycloak" "keycloak"
