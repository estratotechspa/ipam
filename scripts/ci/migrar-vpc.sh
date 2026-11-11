#!/usr/bin/env sh
# Migra las asignaciones de un pool grande a pools hijos por VPC (npm run migrar-vpc) con el rol MIGRADOR.
# Sin APLICAR=true solo simula. Requiere DATABASE_URL_MIGRACION (secreto del CI; este script nunca lo imprime) y POOL.
# El repositorio y sus registros pueden ser públicos y el plan trae proyectos, VPC y rangos de la red: el plan NO se imprime;
# se deja en un archivo temporal del runner y el registro solo muestra un resumen (cantidades y tipos de problema).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
[ -n "${DATABASE_URL_MIGRACION:-}" ] || { echo "Falta el secreto DATABASE_URL_MIGRACION" >&2; exit 2; }
[ -n "${POOL:-}" ] || { echo "Falta POOL (el pool grande, p. ej. dev-gcp-ccla)" >&2; exit 2; }
export DATABASE_SCHEMA="${DATABASE_SCHEMA:-ipam}"
cd "$RAIZ/mvp"
npm ci --no-audit --no-fund
SAL="${RUNNER_TEMP:-/tmp}/migrar-vpc"
mkdir -p "$SAL"
rm -f "$SAL/plan.json" "$SAL/salida.txt"
APLICAR_ARG=""
[ "${APLICAR:-false}" = "true" ] && APLICAR_ARG="--aplicar"
set +e
# shellcheck disable=SC2086
npm run -s migrar-vpc -- --pool "$POOL" --salida "$SAL/plan.json" $APLICAR_ARG >"$SAL/salida.txt" 2>&1
CODIGO=$?
set -e
node - "$SAL" "${APLICAR:-false}" <<'JS'
const fs = require('node:fs');
const [dir, aplicar] = process.argv.slice(2);
console.log(aplicar === 'true' ? 'Modo: APLICAR' : 'Modo: simulación (no se escribió nada)');
try {
  const p = JSON.parse(fs.readFileSync(`${dir}/plan.json`, 'utf8'));
  const porTipo = {};
  for (const x of p.problemas || []) porTipo[x.tipo] = (porTipo[x.tipo] || 0) + 1;
  console.log(`Plan sin problemas fatales: ${p.ok ? 'sí' : 'no'}`);
  console.log(`Pools hijos a crear: ${(p.grupos || []).length}`);
  console.log(`Avisos: ${(p.avisos || []).length}`);
  console.log(`Problemas: ${(p.problemas || []).length}${Object.keys(porTipo).length ? ' ' + JSON.stringify(porTipo) : ''}`);
} catch {
  console.log('No se generó el plan.');
}
for (const linea of fs.readFileSync(`${dir}/salida.txt`, 'utf8').split('\n')) {
  try {
    const l = JSON.parse(linea);
    if (!l.nivel || !l.mensaje) continue;
    if (l.nivel === 'error') console.log(`Error: ${l.mensaje} (${l.error?.tipo || 'sin tipo'}${l.error?.codigo ? ', código ' + l.error.codigo : ''})`);
    else if (/aplicada|Simulación/.test(l.mensaje)) console.log(l.mensaje.replace(/\s+Revisa.*$/, ''), JSON.stringify({ pools_creados: l.pools_creados, asignaciones_movidas: l.asignaciones_movidas, pools_a_crear: l.pools_a_crear, problemas: l.problemas }));
  } catch {
    /* no es una línea del registro */
  }
}
JS
exit "$CODIGO"
