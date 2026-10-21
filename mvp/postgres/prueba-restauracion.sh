#!/bin/sh
# Restaura el último respaldo en un directorio temporal, levanta una instancia aparte y cuenta las filas.
# Un respaldo que nunca se restauró no es un respaldo.
STANZA=${BACKUP_STANZA:-ipam}
D=/tmp/prueba-restauracion
log() { echo "$(date -u +%FT%TZ) prueba-restauracion: $*"; }
rm -rf "$D"; mkdir -p "$D/datos" "$D/sock"; chmod 700 "$D/datos"
if ! pgbackrest --stanza="$STANZA" --pg1-path="$D/datos" --type=immediate --target-action=promote restore; then
  log "ERROR: no se pudo restaurar"; rm -rf "$D"; exit 1
fi
if ! pg_ctl -D "$D/datos" -w -t 120 -l "$D/pg.log" -o "-p 5433 -c listen_addresses='' -c unix_socket_directories=$D/sock -c archive_mode=off" start >/dev/null; then
  log "ERROR: la copia restaurada no arranca"; tail -20 "$D/pg.log"; rm -rf "$D"; exit 1
fi
n=$(psql -h "$D/sock" -p 5433 -U "${POSTGRES_USER:-ipam}" -d "${POSTGRES_DB:-ipam}" -tAc "select count(*) from pools" 2>&1)
pg_ctl -D "$D/datos" -m fast stop >/dev/null
rm -rf "$D"
case "$n" in ''|*[!0-9]*) log "ERROR: la copia restaurada no responde ($n)"; exit 1;; esac
log "OK: la copia restaurada arranca y tiene $n pools"
