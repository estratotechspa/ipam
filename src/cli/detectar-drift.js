'use strict';
// `node src/cli/detectar-drift.js --archivo <ruta-json>`
// Detecta discrepancias (drift) entre el inventario de subredes de la nube y las asignaciones del IPAM.
const fs = require('node:fs');
const { config, validar } = require('../config');
const { crearLogger } = require('../adaptadores/log/logger');
const { crearPoolConReintentos } = require('../adaptadores/persistencia/postgres/pool');
const { crearRepositorio } = require('../adaptadores/persistencia/postgres/repositorio');
const { reconciliarSubredes } = require('../dominio/reconciliacion');

async function main(argv = process.argv.slice(2)) {
  const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-drift' } });
  const idxArchivo = argv.indexOf('--archivo');
  const rutaArchivo = idxArchivo !== -1 && argv[idxArchivo + 1] ? argv[idxArchivo + 1] : null;

  if (!rutaArchivo) {
    // eslint-disable-next-line no-console
    console.error('Uso: node src/cli/detectar-drift.js --archivo <subredes-nube.json>');
    process.exitCode = 1;
    return;
  }

  let subredesNube;
  try {
    const raw = fs.readFileSync(rutaArchivo, 'utf8');
    subredesNube = JSON.parse(raw);
    if (!Array.isArray(subredesNube)) {
      throw new Error('El JSON debe contener un arreglo de subredes [{ cidr, proyecto, vpc, subred }]');
    }
  } catch (e) {
    log.error('Error al leer el archivo de subredes', { error: e.message });
    process.exitCode = 1;
    return;
  }

  const { errores } = validar();
  if (errores.length) {
    log.error('Configuración inválida', { errores });
    process.exitCode = 1;
    return;
  }

  const pool = crearPoolConReintentos({
    url: config.bd.url,
    maxConexiones: 2,
    log,
    intentos: 2,
    esperaMs: 500,
  });

  try {
    const repo = crearRepositorio(pool);
    const { filas: asignaciones } = await repo.listarAsignaciones({ limit: 10000 });
    const resultado = reconciliarSubredes(subredesNube, asignaciones);

    log.info('Resultado de la reconciliación:', resultado.resumen);

    if (resultado.desviaciones_no_registradas.length > 0) {
      log.warn(`Se detectaron ${resultado.desviaciones_no_registradas.length} subredes en la nube NO registradas en el IPAM:`, {
        desviaciones: resultado.desviaciones_no_registradas,
      });
    }

    if (resultado.huerfanas_en_ipam.length > 0) {
      log.warn(`Se detectaron ${resultado.huerfanas_en_ipam.length} asignaciones en IPAM huérfanas (no halladas en la nube):`, {
        huerfanas: resultado.huerfanas_en_ipam.map((h) => ({ id: h.id, codigo: h.codigo, cidr: h.cidr })),
      });
    }

    if (resultado.resumen.hay_drift) {
      process.exitCode = 2; // Código 2 indica drift detectado
    } else {
      log.info('IPAM y Nube en 100% de sincronía.');
    }
  } catch (e) {
    log.error('Fallo en la reconciliación', { error: e.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { main };
