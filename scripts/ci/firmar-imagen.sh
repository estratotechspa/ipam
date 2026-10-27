#!/usr/bin/env sh
# OPCIONAL (apagado por defecto): firma la imagen publicada con cosign SIN llaves (identidad OIDC del CI) y adjunta el SBOM.
# Se activa con FIRMAR_IMAGEN=true. Necesita `cosign` instalado (en GitHub: id-token: write; en GitLab: un ID token con audiencia sigstore).
#   firmar-imagen.sh <imagen@sha256:digest>
set -eu
[ "${FIRMAR_IMAGEN:-false}" = true ] || { echo "Firma de imagen desactivada (FIRMAR_IMAGEN=true para activarla)."; exit 0; }
imagen="${1:?Uso: firmar-imagen.sh <imagen@sha256:digest>}"
command -v cosign >/dev/null 2>&1 || { echo "Falta cosign (https://docs.sigstore.dev/cosign/installation/)." >&2; exit 2; }
COSIGN_YES=true cosign sign "$imagen"
[ -f sbom/ipam.cdx.json ] && COSIGN_YES=true cosign attest --type cyclonedx --predicate sbom/ipam.cdx.json "$imagen" || true
echo "Verifica con: cosign verify --certificate-identity-regexp '<identidad del pipeline>' --certificate-oidc-issuer '<emisor OIDC>' $imagen"
