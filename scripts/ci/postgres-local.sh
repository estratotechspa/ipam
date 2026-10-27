#!/usr/bin/env sh
# PostgreSQL desechable para pruebas, en un contenedor. Versiones soportadas: 14, 15, 16 y 17 (imágenes fijadas por digest).
#   postgres-local.sh arriba <versión>   levanta el contenedor y escribe en pantalla DATABASE_URL
#   postgres-local.sh abajo  <versión>   lo borra
# El puerto del equipo lo elige Docker (no choca con otras bases que tengas).
set -eu
accion="${1:-}"; v="${2:-16}"
case "$v" in
  14) img='postgres:14-alpine@sha256:e73790e2702b489f664605acbec5f5da6981bc7e432f0489e52a53c9d1e7467f' ;;
  15) img='postgres:15-alpine@sha256:d2c2ced0372e855e4c257a9e9b5725f403847c01cfb64facbf2b21dbdadb2d74' ;;
  16) img='postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea' ;;
  17) img='postgres:17-alpine@sha256:1bcc18d81671b02906296aad470ec9778a6b71016ce953092024b680bad007b0' ;;
  *) echo "Versión de PostgreSQL no soportada: $v (usa 14, 15, 16 o 17)" >&2; exit 2 ;;
esac
nombre="ipam-ci-pg$v"
case "$accion" in
  arriba)
    docker rm -f "$nombre" >/dev/null 2>&1 || true
    docker run -d --name "$nombre" -e POSTGRES_USER=ipam -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ipam -p 127.0.0.1::5432 "$img" >/dev/null
    # La imagen arranca primero un servidor temporal de inicialización: pg_isready responde ahí y luego se apaga.
    # Se espera a que termine la inicialización y a que el servidor definitivo acepte conexiones.
    for _ in $(seq 1 90); do
      docker logs "$nombre" 2>&1 | grep -q 'init process complete' && docker exec "$nombre" psql -U ipam -d ipam -tAc 'select 1' >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec "$nombre" psql -U ipam -d ipam -tAc 'select 1' >/dev/null 2>&1 || { echo "PostgreSQL $v no arrancó" >&2; docker logs "$nombre" >&2; exit 1; }
    puerto=$(docker port "$nombre" 5432/tcp | head -1 | sed 's/.*://')
    printf 'postgres://ipam:ci@127.0.0.1:%s/ipam\n' "$puerto"
    ;;
  abajo) docker rm -f "$nombre" >/dev/null 2>&1 || true ;;
  *) echo "Uso: $0 {arriba|abajo} <14|15|16|17>" >&2; exit 2 ;;
esac
