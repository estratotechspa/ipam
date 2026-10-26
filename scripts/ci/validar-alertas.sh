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

echo "JSON y equivalencia PrometheusRule ↔ archivo de reglas (Node: no depende de jq ni de ruby)"
node -e "
const fs=require('fs'),p=require('path');
const yaml=require(p.join(process.argv[1],'mvp','node_modules','yaml'));
let mal=0;const ok=(m)=>console.log('  ✓ '+m),no=(m)=>{console.log('  ✗ '+m);mal++};
const dirs=[p.join(process.argv[1],'docs/ops/alertas/cloud-monitoring'),p.join(process.argv[1],'docs/ops/gcp')];
for(const d of dirs)for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.json'))){try{JSON.parse(fs.readFileSync(p.join(d,f),'utf8'));ok(f)}catch(e){no(f+' no es JSON válido')}}
const a=yaml.parse(fs.readFileSync(p.join(process.argv[1],'docs/ops/alertas/prometheusrule.yaml'),'utf8')).spec.groups;
const b=yaml.parse(fs.readFileSync(p.join(process.argv[1],'docs/ops/alertas/reglas-prometheus.yml'),'utf8')).groups;
JSON.stringify(a)===JSON.stringify(b)?ok('mismas reglas'):no('las reglas difieren');
process.exit(mal?1:0)" "$RAIZ" || fallos=$((fallos + 1))

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "promtool (Prometheus)"
  docker run --rm --entrypoint promtool -v "$A:/reglas:ro" prom/prometheus:v2.55.1 check rules /reglas/reglas-prometheus.yml >/tmp/promtool.out 2>&1 && ok "promtool check rules" || { cat /tmp/promtool.out; mal "promtool rechazó las reglas"; }
  echo "OpenTofu (validate)"
  cp -R "$A/cloud-monitoring" "$TMP/tf"
  # Con tu mismo usuario (no root): en Linux, lo que el contenedor escribe en $TMP/tf como root no se podía borrar al terminar
  # («rm: cannot remove … .terraform/providers/…») y el script fallaba en el CI. HOME=/tmp porque ese usuario no tiene directorio propio.
  tofu() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$TMP/tf:/work" -w /work ghcr.io/opentofu/opentofu:1.8 "$@"; }
  tofu init -backend=false -input=false >/tmp/tofu-init.out 2>&1 \
    && tofu validate >/tmp/tofu-validate.out 2>&1 \
    && tofu fmt -check >/dev/null 2>&1 \
    && ok "tofu init + validate + fmt" || { cat /tmp/tofu-init.out /tmp/tofu-validate.out 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tail -15; mal "tofu falló (validate o formato)"; }
else
  echo "  (sin Docker: se omiten promtool y tofu validate; ejecútalos donde haya Docker)"
fi
chmod -R u+w "$TMP" 2>/dev/null || true # los proveedores descargados son de solo lectura
rm -rf "$TMP"
[ "$fallos" -eq 0 ] && echo "Alertas y dashboard: OK" || { echo "Alertas y dashboard: FALLÓ ($fallos)"; exit 1; }
