#!/usr/bin/env sh
# OPCIONAL (apagado por defecto): OWASP ZAP baseline contra una instancia EFÍMERA del IPAM (con base de datos desechable).
# Se activa con ACTIVAR_DAST=true. Necesita Docker. El informe queda en dast-informe.html.
set -eu
[ "${ACTIVAR_DAST:-false}" = true ] || { echo "DAST desactivado (ACTIVAR_DAST=true para activarlo)."; exit 0; }
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
ZAP='ghcr.io/zaproxy/zaproxy@sha256:391f66efa53b30de40d4a1c6e28146477263552fc828bc7613c9cd11a2949908'   # 2.16.0
red="ipam-dast-$$"; docker network create "$red" >/dev/null
trap 'docker rm -f "$red-app" "$red-db" >/dev/null 2>&1 || true; docker network rm "$red" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$red-db" --network "$red" -e POSTGRES_USER=ipam -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ipam \
  -v "$RAIZ/mvp/db/schema.sql:/docker-entrypoint-initdb.d/01.sql:ro" -v "$RAIZ/mvp/db/seed.sql:/docker-entrypoint-initdb.d/02.sql:ro" postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$red-db" pg_isready -U ipam -d ipam >/dev/null 2>&1 && break; sleep 1; done; sleep 3
. "$RAIZ/scripts/ci/entorno.sh"
docker run -d --name "$red-app" --network "$red" -e DATABASE_URL=postgres://ipam:ci@"$red-db":5432/ipam -e ALLOW_ANONYMOUS=true "$IPAM_IMAGEN:$IPAM_VERSION" >/dev/null
sleep 5
docker run --rm --network "$red" -v "$PWD:/zap/wrk:rw" "$ZAP" zap-baseline.py -t "http://$red-app:8080" -r dast-informe.html -I
echo "Informe: dast-informe.html"
