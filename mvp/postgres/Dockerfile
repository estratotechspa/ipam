# PostgreSQL con pgBackRest para respaldos incrementales y archivado continuo de WAL (recuperación a un punto en el tiempo).
# Se usa solo con postgres.backup.enabled=true en el chart. Con una base administrada (Cloud SQL, RDS) no hace falta.
ARG BASE_IMAGE=postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}
# Sin fijar la versión: Alpine retira las antiguas y rompería la construcción; la base va fijada por digest y Dependabot la actualiza.
# hadolint ignore=DL3018
RUN apk add --no-cache pgbackrest
COPY respaldo.sh prueba-restauracion.sh /usr/local/bin/
RUN chmod 0555 /usr/local/bin/respaldo.sh /usr/local/bin/prueba-restauracion.sh
