#!/usr/bin/env sh
# Construye la imagen OCI del IPAM. SIN registry fijo: el nombre sale de IPAM_IMAGEN (scripts/ci/entorno.sh).
#   construir-imagen.sh local        una arquitectura, queda en Docker (para escanear y probar); guarda imagen.tar si IPAM_GUARDAR_TAR=1
#   construir-imagen.sh multiarch    amd64 + arm64, sin publicar (comprueba que ambas construyen)
#   construir-imagen.sh publicar     amd64 + arm64 y SUBE al registry (con SBOM y procedencia); exige IPAM_PUBLICAR=true
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
. "$RAIZ/scripts/ci/entorno.sh"
modo="${1:-local}"
etiquetas="-t $IPAM_IMAGEN:$IPAM_VERSION"
[ "$IPAM_ES_TAG" = true ] && etiquetas="$etiquetas -t $IPAM_IMAGEN:$(printf '%s' "$IPAM_VERSION" | cut -d. -f1,2)"
args="--build-arg VERSION=$IPAM_VERSION --build-arg REVISION=$IPAM_SHA_CORTO --label org.opencontainers.image.source=${IPAM_REPO_URL:-desconocido}"
cd "$RAIZ/mvp"
case "$modo" in
  local)
    # shellcheck disable=SC2086
    docker buildx build $args $etiquetas --load .
    [ "${IPAM_GUARDAR_TAR:-}" = 1 ] && docker save "$IPAM_IMAGEN:$IPAM_VERSION" -o "$RAIZ/imagen.tar"
    echo "Imagen: $IPAM_IMAGEN:$IPAM_VERSION" ;;
  multiarch)
    # shellcheck disable=SC2086
    docker buildx build --platform linux/amd64,linux/arm64 $args $etiquetas . ;;
  publicar)
    [ "${IPAM_PUBLICAR:-false}" = true ] || { echo "Publicar exige IPAM_PUBLICAR=true (por seguridad no se publica por defecto)." >&2; exit 2; }
    [ -n "${IPAM_REGISTRY_CLAVE:-}" ] && printf '%s' "$IPAM_REGISTRY_CLAVE" | docker login "${IPAM_REGISTRY%%/*}" -u "$IPAM_REGISTRY_USUARIO" --password-stdin
    # shellcheck disable=SC2086
    docker buildx build --platform linux/amd64,linux/arm64 $args $etiquetas --sbom=true --provenance=mode=max --push . ;;
  *) echo "Uso: $0 {local|multiarch|publicar}" >&2; exit 2 ;;
esac
