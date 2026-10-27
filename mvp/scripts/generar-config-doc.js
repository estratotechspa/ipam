#!/usr/bin/env node
'use strict';
// Genera docs/CONFIGURACION.md desde el catálogo de variables de src/config.js (única fuente de verdad).
//   node scripts/generar-config-doc.js            escribe el archivo
//   node scripts/generar-config-doc.js --verificar  falla si el archivo está desactualizado (lo usa el CI)
const fs = require('node:fs');
const path = require('node:path');
const { listarVariables } = require('../src/config');

const destino = path.join(__dirname, '..', '..', 'docs', 'CONFIGURACION.md');
const celda = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const valor = (v) =>
  v.secreta ? '(secreto)' : Array.isArray(v.defecto) ? (v.defecto.length ? v.defecto.join(',') : '(vacía)') : v.defecto === '' ? '(vacío)' : String(v.defecto);

const prefijo = (n) => n.split('_')[0];
const cuenta = new Map();
for (const v of listarVariables()) cuenta.set(prefijo(v.nombre), (cuenta.get(prefijo(v.nombre)) || 0) + 1);
const TITULOS = {
  DATABASE: 'Base de datos',
  DB: 'Base de datos (conexiones)',
  JSON: 'Límites de cuerpo',
  OIDC: 'Acceso con OIDC (SSO)',
  RATE: 'Límite de peticiones',
  RESERVA: 'Reservas',
  TOKEN: 'Tokens de servicio',
  EVENTOS: 'Eventos y webhook saliente',
  OTEL: 'Trazas (OpenTelemetry)',
  JIRA: 'Jira',
  BRAND: 'Marca',
  METRICS: 'Métricas',
  APP: 'Acceso básico (POC)',
  SESSION: 'Sesión',
  COOKIE: 'Sesión',
  General: 'General (proceso y servidor)',
};
const grupos = new Map();
for (const v of listarVariables()) {
  const p = prefijo(v.nombre);
  const g = TITULOS[cuenta.get(p) > 1 || TITULOS[p] ? p : 'General'] || p;
  if (!grupos.has(g)) grupos.set(g, []);
  grupos.get(g).push(v);
}

let md = `# Configuración (variables de entorno)

> **Este archivo se genera** con \`npm run doc:config\` desde \`mvp/src/config.js\`; no lo edites a mano (el CI verifica que esté al día).
> Todo se configura por variables de entorno (12-factor). En Kubernetes van en \`values.yaml\` (ver [DESPLIEGUE](ops/DESPLIEGUE.md)).
> Los **secretos** aceptan también la forma \`NOMBRE_FILE=/ruta/al/archivo\` (Kubernetes Secret montado, Docker secrets, Secret Manager…); el valor nunca se imprime en logs.
> Los defaults son los seguros: sin configurar nada, en producción el servicio **no arranca** sin autenticación.

Tipos: *texto*, *entero*, *booleano* (\`true\`/\`false\`) y *lista* (valores separados por coma).
`;
for (const [g, vars] of grupos) {
  md += `\n## ${g}\n\n| Variable | Tipo | Por defecto | Descripción |\n|---|---|---|---|\n`;
  for (const v of vars) {
    const extra = [
      v.obligatoria ? '**Obligatoria.**' : '',
      v.secreta ? 'Secreta.' : '',
      v.opciones ? `Opciones: ${v.opciones.join(', ')}.` : '',
      v.ejemplo && !v.secreta ? `Ej.: \`${celda(v.ejemplo)}\`` : '',
    ]
      .filter(Boolean)
      .join(' ');
    md += `| \`${v.nombre}\` | ${v.tipo} | ${celda(valor(v))} | ${celda(v.descripcion)} ${extra} |\n`;
  }
}
if (process.argv.includes('--verificar')) {
  const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '';
  if (actual !== md) {
    console.error('docs/CONFIGURACION.md está desactualizado: ejecuta `npm run doc:config`.');
    process.exit(1);
  }
  console.log('docs/CONFIGURACION.md al día');
} else {
  fs.writeFileSync(destino, md);
  console.log(`escrito ${destino} (${listarVariables().length} variables)`);
}
