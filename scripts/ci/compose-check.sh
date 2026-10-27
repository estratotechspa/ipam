#!/usr/bin/env sh
# `docker compose up` de despliegue/docker-compose: construye la imagen, migra el esquema y espera a que los healthchecks den «healthy».
# Luego prueba /healthz y /readyz DESDE DENTRO del contenedor (así no depende de redes del CI).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
cd "$RAIZ/despliegue/docker-compose"
export PORT="${IPAM_PUERTO:-18080}" DB_PASSWORD=clave-solo-ci
proy="ipamci$$"
trap 'docker compose -p "$proy" down -v >/dev/null 2>&1 || true' EXIT
docker compose -p "$proy" config -q
docker compose -p "$proy" up --build -d --wait --wait-timeout 180
for sonda in healthz readyz; do
  docker compose -p "$proy" exec -T api node -e "fetch('http://127.0.0.1:8080/$sonda').then(async r=>{console.log('$sonda',r.status,await r.text());process.exit(r.ok?0:1)})"
done
# La semilla se copia por la API de Docker (sin montajes del equipo): funciona también con Docker remoto o Docker-en-Docker.
docker compose -p "$proy" cp ../../mvp/db/seed.sql db:/tmp/seed.sql
docker compose -p "$proy" exec -T db psql -U ipam -d ipam -v ON_ERROR_STOP=1 -q -f /tmp/seed.sql
docker compose -p "$proy" exec -T api node -e "fetch('http://127.0.0.1:8080/api/resumen').then(async r=>{const j=await r.json();console.log('resumen',JSON.stringify(j));process.exit(j.pools===6?0:1)})"
echo "docker compose: OK"
