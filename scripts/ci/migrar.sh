#!/usr/bin/env sh
# Aplica las migraciones (db/schema.sql) con el rol MIGRADOR. Misma lógica para GitHub y GitLab.
# Requiere DATABASE_URL_MIGRACION (secreto del CI; este script nunca lo imprime) y DATABASE_SCHEMA (por defecto «ipam»).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
[ -n "${DATABASE_URL_MIGRACION:-}" ] || { echo "Falta el secreto DATABASE_URL_MIGRACION" >&2; exit 2; }
export DATABASE_SCHEMA="${DATABASE_SCHEMA:-ipam}"
cd "$RAIZ/mvp"
npm ci --no-audit --no-fund
npm run -s migrar
