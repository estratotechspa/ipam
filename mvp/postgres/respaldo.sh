#!/bin/sh
# Sidecar de respaldos (pgBackRest). Crea el «stanza», hace un primer respaldo completo y luego sigue el calendario:
#   completo el día BACKUP_FULL_DIA (0 = domingo), incremental el resto de los días, a las BACKUP_HORA (UTC).
#   El día BACKUP_PRUEBA_DIA de cada mes restaura el último respaldo en un directorio temporal y comprueba los datos.
# Un fallo se registra y se reintenta al día siguiente; nunca detiene la base de datos.
STANZA=${BACKUP_STANZA:-ipam}
HORA=${BACKUP_HORA:-02}
FULL_DIA=${BACKUP_FULL_DIA:-0}
PRUEBA_DIA=${BACKUP_PRUEBA_DIA:-01}
log() { echo "$(date -u +%FT%TZ) respaldo: $*"; }
pgb() { pgbackrest --stanza="$STANZA" "$@"; }

until pg_isready -q -h /var/run/postgresql; do sleep 2; done
until pgb stanza-create; do log "stanza-create falló; reintento en 30 s (¿bucket o credenciales?)"; sleep 30; done
if ! pgb info 2>/dev/null | grep -q 'full backup:'; then
  log "no hay respaldos: primer respaldo completo"
  pgb --type=full backup && log "primer respaldo completo OK" || log "ERROR en el primer respaldo completo"
fi

ultimo=""
while true; do
  hoy=$(date -u +%F)
  if [ "$(date -u +%H)" = "$HORA" ] && [ "$ultimo" != "$hoy" ]; then
    ultimo=$hoy
    if [ "$(date -u +%w)" = "$FULL_DIA" ]; then tipo=full; else tipo=incr; fi
    log "inicia respaldo $tipo"
    if pgb --type=$tipo backup; then log "respaldo $tipo OK"; else log "ERROR en el respaldo $tipo"; fi
    if [ "$(date -u +%d)" = "$PRUEBA_DIA" ]; then prueba-restauracion.sh || true; fi
  fi
  sleep 60
done
