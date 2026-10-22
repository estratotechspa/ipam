#!/usr/bin/env sh
# Valida los entregables de alertas y el dashboard con herramientas reales (las que haya disponibles):
#   jq (JSON) · promtool (reglas de Prometheus, en contenedor) · tofu validate (HCL, en contenedor) · equivalencia PrometheusRule ↔ archivo de reglas.
# Sale con error si algo falla; avisa (sin fallar) cuando no hay Docker para promtool/tofu.
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
A="$RAIZ/docs/ops/alertas"
fallos=0
ok() { printf '  ✓ %s\n' "$1"; }
mal() { printf '  ✗ %s\n' "$1"; fallos=$((fallos + 1)); }

echo "Deriva: lo versionado coincide con lo que genera scripts/ci/generar-alertas.js"
TMP=$(mktemp -d)
node "$RAIZ/scripts/ci/generar-alertas.js" --texto > "$TMP/gen.json"
node -e "
const fs=require('fs'),p=require('path');const g=JSON.parse(fs.readFileSync(process.argv[1]));let mal=0;
for(const [r,c] of Object.entries(g)){const f=p.join(process.argv[2],r);if(!fs.existsSync(f)||fs.readFileSync(f,'utf8')!==c){console.log('  ✗ desviado: '+r);mal++}}
process.exit(mal?1:0)" "$TMP/gen.json" "$RAIZ" && ok "sin deriva" || fallos=$((fallos + 1))

echo "JSON (jq)"
for f in "$A"/cloud-monitoring/*.json "$RAIZ"/docs/ops/gcp/*.json; do
  jq -e . "$f" >/dev/null 2>&1 && ok "$(basename "$f")" || mal "$(basename "$f") no es JSON válido"
done

echo "Equivalencia PrometheusRule ↔ archivo de reglas"
ruby -ryaml -rjson -e '
  a = YAML.load_file(ARGV[0]); b = YAML.load_file(ARGV[1])
  exit(a["spec"]["groups"] == b["groups"] ? 0 : 1)' "$A/prometheusrule.yaml" "$A/reglas-prometheus.yml" && ok "mismas reglas" || mal "las reglas difieren"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "promtool (Prometheus)"
  docker run --rm --entrypoint promtool -v "$A:/reglas:ro" prom/prometheus:v2.55.1 check rules /reglas/reglas-prometheus.yml >/tmp/promtool.out 2>&1 && ok "promtool check rules" || { cat /tmp/promtool.out; mal "promtool rechazó las reglas"; }
  echo "OpenTofu (validate)"
  cp -R "$A/cloud-monitoring" "$TMP/tf"
  docker run --rm -v "$TMP/tf:/work" -w /work ghcr.io/opentofu/opentofu:1.8 init -backend=false -input=false >/tmp/tofu-init.out 2>&1 \
    && docker run --rm -v "$TMP/tf:/work" -w /work ghcr.io/opentofu/opentofu:1.8 validate >/tmp/tofu-validate.out 2>&1 \
    && docker run --rm -v "$TMP/tf:/work" -w /work ghcr.io/opentofu/opentofu:1.8 fmt -check >/dev/null 2>&1 \
    && ok "tofu init + validate + fmt" || { cat /tmp/tofu-init.out /tmp/tofu-validate.out 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tail -15; mal "tofu falló (validate o formato)"; }
else
  echo "  (sin Docker: se omiten promtool y tofu validate; ejecútalos donde haya Docker)"
fi
rm -rf "$TMP"
[ "$fallos" -eq 0 ] && echo "Alertas y dashboard: OK" || { echo "Alertas y dashboard: FALLÓ ($fallos)"; exit 1; }
