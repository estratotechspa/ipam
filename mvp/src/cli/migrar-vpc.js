'use strict';
// `npm run migrar-vpc -- --pool dev-gcp-ccla [--ajustes ajustes.json] [--salida plan.json] [--aplicar]`
// Lleva las asignaciones de un pool grande a pools hijos, uno por VPC. SIN `--aplicar` solo SIMULA: calcula el plan, lo imprime y no
// escribe nada. Con `--aplicar` escribe, todo o nada, y solo si el plan no tiene problemas. Usa el usuario migrador (DATABASE_URL_MIGRACION).
// Guía: docs/ops/MIGRAR-VPC-A-POOLS.md.
const fs = require('node:fs');
const { config, validarParaMigrar } = require('../config');
const { crearLogger } = require('../adaptadores/log/logger');
const { migrarVpcAPools } = require('../adaptadores/persistencia/postgres/migracion-vpc');

const valorDe = (argv, nombre) => {
  const i = argv.indexOf(nombre);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main(argv = process.argv.slice(2)) {
  const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-migrar-vpc' } });
  const { errores } = validarParaMigrar();
  if (errores.length) {
    log.error('Configuración inválida', { errores });
    process.exitCode = 1;
    return;
  }
  const padre = valorDe(argv, '--pool');
  if (!padre) {
    log.error('Falta --pool <id del pool grande>, p. ej. --pool dev-gcp-ccla');
    process.exitCode = 1;
    return;
  }
  try {
    const archivo = valorDe(argv, '--ajustes');
    const ajustes = archivo ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : [];
    const r = await migrarVpcAPools({ url: config.bd.urlMigracion, bd: config.bd, padre, ajustes, aplicar: argv.includes('--aplicar') });
    const salida = valorDe(argv, '--salida');
    if (salida) fs.writeFileSync(salida, JSON.stringify(r.plan, null, 2));
    console.log(JSON.stringify(r.plan, null, 2));
    if (r.aplicado) log.info('Migración aplicada', { pools_creados: r.plan.grupos.length, asignaciones_movidas: r.movidas });
    else if (argv.includes('--aplicar')) {
      log.error('No se aplicó nada: el plan tiene problemas (ver "problemas") o no hay nada que migrar.');
      process.exitCode = 1;
    } else
      log.info('Simulación: no se escribió nada. Revisa el plan y repite con --aplicar.', {
        pools_a_crear: r.plan.grupos.length,
        problemas: r.plan.problemas.length,
      });
  } catch (e) {
    log.error('La migración falló (no se cambió nada)', e);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { main };
