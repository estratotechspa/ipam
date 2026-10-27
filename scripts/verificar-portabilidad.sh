#!/usr/bin/env sh
# Guardia de portabilidad: el código del IPAM no debe saber en qué nube corre ni quién lo construye.
# Falla (código de salida 1) si en mvp/src/:
#   1. aparece un SDK o dominio de proveedor (googleapis, @google-cloud, aws-sdk, @azure, supabase, onrender);
#   2. dominio/ o aplicacion/ importan infraestructura (Express, pg, módulos de red o de archivos, adaptadores, config…);
#   3. se lee process.env fuera de src/config.js (las pruebas *.test.js y src/pruebas/ quedan fuera: ellas SÍ preparan el entorno).
# También revisa las dependencias de package.json. Se ejecuta en CI y en el hook de pre-commit.
set -eu

RAIZ=$(cd "$(dirname "$0")/.." && pwd)
SRC="${IPAM_SRC:-$RAIZ/mvp/src}"
PKG="${IPAM_PKG:-$RAIZ/mvp/package.json}"
fallos=0

aviso() { printf '  ✗ %s\n' "$1"; fallos=$((fallos + 1)); }
titulo() { printf '\n%s\n' "$1"; }

# Archivos de producción (sin pruebas ni sus ayudantes en pruebas/).
produccion() { find "$SRC" -type f -name '*.js' ! -name '*.test.js' ! -path '*/pruebas/*' "$@"; }

titulo "1. SDK o dominios de proveedor en mvp/src/"
PROVEEDORES='googleapis|@google-cloud|aws-sdk|@aws-sdk|@azure|supabase|onrender'
coincidencias=$(produccion -exec grep -nEi "$PROVEEDORES" {} + 2>/dev/null || true)
if [ -n "$coincidencias" ]; then
  printf '%s\n' "$coincidencias" | while IFS= read -r l; do printf '  ✗ %s\n' "$l"; done
  fallos=$((fallos + 1))
else
  echo "  ✓ sin referencias a proveedores"
fi
if [ -f "$PKG" ] && grep -nEi "\"($PROVEEDORES)[^\"]*\"" "$PKG" >/dev/null 2>&1; then
  aviso "package.json declara una dependencia de proveedor: $(grep -nEi "\"($PROVEEDORES)[^\"]*\"" "$PKG" | tr '\n' ' ')"
else
  echo "  ✓ package.json sin SDK de proveedor"
fi

titulo "2. dominio/ y aplicacion/ no importan infraestructura"
# Prohibido: frameworks, drivers, módulos de red/archivos/procesos del sistema, adaptadores, config y process/fetch.
INFRA='(require|from)[ (]*["'"'"'](express|pg|helmet|exceljs|openid-client|prom-client|ajv|@opentelemetry/[^"'"'"']*|(node:)?(fs|http|https|http2|net|dns|tls|child_process|cluster|worker_threads|crypto|os|stream)(/promises)?|\.\.?/(\.\./)*(adaptadores|config|server|arranque)[^"'"'"']*)["'"'"']'
for capa in dominio aplicacion; do
  [ -d "$SRC/$capa" ] || continue
  m=$(find "$SRC/$capa" -type f -name '*.js' ! -name '*.test.js' -exec grep -nE "$INFRA" {} + 2>/dev/null || true)
  m2=$(find "$SRC/$capa" -type f -name '*.js' ! -name '*.test.js' -exec grep -nE 'process\.(env|exit|on)|[^.a-zA-Z_]fetch\(|console\.(log|error|warn)' {} + 2>/dev/null || true)
  if [ -n "$m$m2" ]; then
    printf '%s\n%s\n' "$m" "$m2" | sed '/^$/d' | while IFS= read -r l; do printf '  ✗ %s\n' "$l"; done
    fallos=$((fallos + 1))
  else
    echo "  ✓ $capa/ sin imports de infraestructura"
  fi
done

titulo "3. process.env solo dentro de src/config.js"
m=$(produccion ! -path "$SRC/config.js" -exec grep -n 'process\.env' {} + 2>/dev/null || true)
if [ -n "$m" ]; then
  printf '%s\n' "$m" | while IFS= read -r l; do printf '  ✗ %s\n' "$l"; done
  fallos=$((fallos + 1))
else
  echo "  ✓ cero lecturas de process.env fuera de config.js"
fi

echo
if [ "$fallos" -gt 0 ]; then
  echo "Guardia de portabilidad: FALLÓ ($fallos revisiones con problemas)."
  exit 1
fi
echo "Guardia de portabilidad: OK"
