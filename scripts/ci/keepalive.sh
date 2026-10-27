#!/usr/bin/env sh
# Despierta (y comprueba) el servicio del POC. El plan gratuito de Render lo duerme tras un rato sin tráfico y la primera
# petición puede tardar más de un minuto: se reintenta con espera. Uso: IPAM_URL=https://… scripts/ci/keepalive.sh
# No necesita ningún secreto: /healthz es público. Un keepalive NO es un monitor de disponibilidad.
set -eu
[ -n "${IPAM_URL:-}" ] || { echo "Falta IPAM_URL (la URL pública del servicio)" >&2; exit 2; }
url="${IPAM_URL%/}/healthz"
intentos="${IPAM_KEEPALIVE_INTENTOS:-8}"
i=1
while [ "$i" -le "$intentos" ]; do
  codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$url" || true)
  echo "intento $i/$intentos: HTTP ${codigo:-000}"
  [ "$codigo" = "200" ] && { echo "servicio despierto"; exit 0; }
  i=$((i + 1)); sleep 15
done
echo "El servicio no respondió 200 en /healthz" >&2
exit 1
