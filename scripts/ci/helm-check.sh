#!/usr/bin/env sh
# Verifica el chart de Helm: lint y render en tres escenarios, los ajustes por nube y kube-linter (si está disponible).
#   1) SIN autenticación: la plantilla debe FALLAR (arranque seguro).   2) con allowAnonymous: renderiza.   3) con OIDC y métricas: renderiza.
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="${IPAM_HERRAMIENTAS:-$HOME/.cache/ipam-herramientas}/bin:$PATH"
command -v helm >/dev/null 2>&1 || "$RAIZ/scripts/ci/instalar-herramientas.sh" helm
CHART="$RAIZ/mvp/chart/ipam"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok() { printf '  ✓ %s\n' "$1"; }

helm lint "$CHART" --set auth.allowAnonymous=true >/dev/null && ok "helm lint"
if helm template ipam "$CHART" >/dev/null 2>"$T/err"; then echo "  ✗ sin autenticación el chart DEBE fallar y renderizó" >&2; exit 1; fi
grep -qi 'autenticación' "$T/err" && ok "escenario 1: falla sin autenticación (con mensaje claro)"
helm template ipam "$CHART" --set auth.allowAnonymous=true > "$T/anonimo.yaml" && ok "escenario 2: renderiza con allowAnonymous"
helm template ipam "$CHART" --set auth.oidc.issuer=https://accounts.google.com --set auth.oidc.clientId=cliente --set secrets.oidcClientSecret=secreto \
  --set config.publicUrl=https://ipam.ejemplo.interno --set metrics.enabled=true --set ingress.enabled=true > "$T/oidc.yaml" && ok "escenario 3: renderiza con OIDC y métricas"
helm template ipam "$CHART" --set secrets.existingSecret=x --set postgres.backup.enabled=true --set postgres.backup.repo.gcs.bucket=b >/dev/null && ok "respaldos activados"
for nube in gke eks aks; do helm template ipam "$CHART" -f "$RAIZ/despliegue/kubernetes/values-$nube.yaml" >/dev/null && ok "ajustes de $nube"; done
for amb in dev qa prod; do helm template ipam "$CHART" -f "$RAIZ/despliegue/kubernetes/values-gke.yaml" -f "$RAIZ/despliegue/kubernetes/values-$amb.yaml" >/dev/null && ok "ambiente $amb (sobre gke)"; done
cmp -s "$RAIZ/mvp/db/schema.sql" "$CHART/files/schema.sql" && cmp -s "$RAIZ/mvp/db/seed.sql" "$CHART/files/seed.sql" && ok "esquema y semilla del chart idénticos a db/"
if command -v kube-linter >/dev/null 2>&1 || "$RAIZ/scripts/ci/instalar-herramientas.sh" kube-linter >/dev/null 2>&1; then
  kube-linter lint --config "$RAIZ/.kube-linter.yaml" "$T/oidc.yaml" >/dev/null && ok "kube-linter (OIDC + métricas + ingress)"
else echo "  · kube-linter no disponible: omitido"; fi
echo "Chart de Helm: OK"
