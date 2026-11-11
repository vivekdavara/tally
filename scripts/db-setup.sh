#!/usr/bin/env bash
# Creates Tally's two roles and its databases. Idempotent: running it again changes nothing, except that it
# re-asserts tally_app's restrictions in case someone loosened them.
#
#   scripts/db-setup.sh [database ...]      default: tally tally_test
#
# Connects with psql's usual defaults (PGHOST, PGPORT, PGUSER; locally the Homebrew superuser over the Unix
# socket, in CI the service container's postgres user), which must be a superuser or have CREATEROLE and
# CREATEDB. No passwords: local Postgres trusts local connections, and CI's container runs with
# POSTGRES_HOST_AUTH_METHOD=trust.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  set -- tally tally_test
fi

psql_admin() {
  psql -X -q -v ON_ERROR_STOP=1 "$@"
}

for db in "$@"; do
  case "$db" in
    *[!a-z0-9_]* | "") echo "db-setup: refusing database name '$db' (lower-case letters, digits, _)" >&2; exit 2 ;;
  esac
done

# Roles. tally_owner owns the tables and runs migrations; tally_app is what the application connects as, and
# row-level security only binds it because it is not a superuser, has no BYPASSRLS and owns nothing.
psql_admin -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tally_owner') THEN
    CREATE ROLE tally_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tally_app') THEN
    CREATE ROLE tally_app LOGIN;
  END IF;
END
$$;
ALTER ROLE tally_owner NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE tally_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
SQL

for db in "$@"; do
  psql_admin -d postgres -v db="$db" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER tally_owner', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
  # Postgres 14 lets every role create objects in the public schema; Tally's migrations are the only thing
  # that should. The owner role gets the schema; nobody else may create in it.
  psql_admin -d "$db" <<'SQL'
ALTER SCHEMA public OWNER TO tally_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
  # Only Tally's roles (and superusers) may connect.
  psql_admin -d "$db" -v db="$db" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO tally_owner, tally_app', :'db') \gexec
SQL
  echo "db-setup: $db ready (owner tally_owner, app role tally_app)"
done
