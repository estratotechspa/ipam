#!/usr/bin/env sh
# Corre las pruebas contra PostgreSQL 14, 15, 16 y 17, una tras otra (en local; el CI lo reparte en trabajos paralelos).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
fallos=""
for v in ${IPAM_PG_VERSIONES:-14 15 16 17}; do
  echo "== PostgreSQL $v"
  if DATABASE_URL= "$RAIZ/scripts/ci/probar.sh" "$v"; then :; else fallos="$fallos $v"; fi
done
[ -z "$fallos" ] && echo "Matriz de PostgreSQL: OK" || { echo "Matriz de PostgreSQL: FALLÓ en:$fallos"; exit 1; }
