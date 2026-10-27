#!/usr/bin/env sh
# Pruebas unitarias y de integración contra PostgreSQL REAL.  Uso: probar.sh [versión de PostgreSQL: 14|15|16|17]
# Si DATABASE_URL ya está definida (el CI levanta PostgreSQL como servicio), la usa; si no, levanta un contenedor desechable.
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
v="${1:-${IPAM_PG:-16}}"
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$("$RAIZ/scripts/ci/postgres-local.sh" arriba "$v"); export DATABASE_URL
  trap '"$RAIZ"/scripts/ci/postgres-local.sh abajo "$v"' EXIT
  echo "PostgreSQL $v desechable en $(printf '%s' "$DATABASE_URL" | sed 's#//[^@]*@#//***@#')"
fi
cd "$RAIZ/mvp"
node scripts/aplicar-sql.js --reiniciar db/schema.sql db/seed.sql >/dev/null   # base de ejemplo para las pruebas históricas; el resto crea su propia base temporal
npm test
