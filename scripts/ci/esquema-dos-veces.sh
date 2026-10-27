#!/usr/bin/env sh
# El esquema SQL debe poder aplicarse DOS veces sin error y migrar desde el esquema VIEJO sin perder datos.
# Se comprueba con las pruebas de integración de esquema/migración (contra PostgreSQL real) y con la copia del chart.
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
cmp -s "$RAIZ/mvp/db/schema.sql" "$RAIZ/mvp/chart/ipam/files/schema.sql" || { echo "✗ mvp/db/schema.sql y mvp/chart/ipam/files/schema.sql deben ser idénticos" >&2; exit 1; }
echo "✓ el esquema del chart es idéntico al de db/"
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$("$RAIZ/scripts/ci/postgres-local.sh" arriba "${IPAM_PG:-16}"); export DATABASE_URL
  trap '"$RAIZ"/scripts/ci/postgres-local.sh abajo "${IPAM_PG:-16}"' EXIT
fi
cd "$RAIZ/mvp"
node --test --test-timeout=180000 --test-name-pattern='esquema|migrar|roles' src/servicio.test.js src/roles.test.js
