#!/usr/bin/env sh
# Pruebas de navegador (Playwright): crear y copiar un token, listar/confirmar/liberar reservas, roles en la interfaz, XSS, accesibilidad.
# Usa DATABASE_URL si existe; si no, un PostgreSQL desechable. Instala Chromium si falta (con --with-deps solo en CI, donde hay permisos).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$("$RAIZ/scripts/ci/postgres-local.sh" arriba "${IPAM_PG:-16}"); export DATABASE_URL
  trap '"$RAIZ"/scripts/ci/postgres-local.sh abajo "${IPAM_PG:-16}"' EXIT
fi
cd "$RAIZ/mvp"
node scripts/aplicar-sql.js --reiniciar db/schema.sql db/seed.sql >/dev/null
if [ "${IPAM_NAVEGADOR_PREINSTALADO:-}" = 1 ]; then :; elif [ -n "${CI:-}" ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi
npm run test:e2e
