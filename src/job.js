'use strict';

// Cloud Run Job inyecta automáticamente estas 3 variables en cada task:
//   CLOUD_RUN_TASK_INDEX   -> índice de esta task (0-based)
//   CLOUD_RUN_TASK_COUNT   -> total de tasks de la ejecución
//   CLOUD_RUN_TASK_ATTEMPT -> número de reintento de esta task

/**
 * Lógica de ejecución para Cloud Run Job.
 * Acciones soportadas vía IPAM_JOB_ACTION:
 *   - 'migrar': Aplica migraciones pendientes de PostgreSQL en Cloud SQL.
 *   - 'purgar': Limpia reservas expiradas y purga eventos antiguos.
 *   - 'drift': Detección de inconsistencias / drift contra GCP Compute Engine.
 * @returns {Promise<number>} 0 en éxito, distinto de 0 en falla.
 */
async function run() {
  const taskIndex = parseInt(process.env.CLOUD_RUN_TASK_INDEX || '0', 10);
  const taskCount = parseInt(process.env.CLOUD_RUN_TASK_COUNT || '1', 10);
  const taskAttempt = parseInt(process.env.CLOUD_RUN_TASK_ATTEMPT || '0', 10);

  const accion = process.env.IPAM_JOB_ACTION || 'status';
  console.log(`[IPAM Cloud Run Job] Iniciando task ${taskIndex}/${taskCount} (intento ${taskAttempt}) - Acción: ${accion}`);

  try {
    if (accion === 'migrar') {
      const { config } = require('./config');
      const { migrar } = require('./adaptadores/persistencia/postgres/migraciones');
      const { crearLogger } = require('./adaptadores/log/logger');
      const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-migrar-job' } });
      await migrar({ url: config.bd.urlMigracion, bd: config.bd, log });
      console.log('[IPAM Cloud Run Job] Migraciones aplicadas exitosamente.');
    } else if (accion === 'purgar') {
      const { config } = require('./config');
      const { crearPoolConReintentos } = require('./adaptadores/persistencia/postgres/pool');
      const { crearLogger } = require('./adaptadores/log/logger');
      const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-purgar-job' } });
      const pool = crearPoolConReintentos({ url: config.bd.url, log, maxConexiones: 2 });
      try {
        const { purgarEventos } = require('./adaptadores/persistencia/postgres/retencion');
        await purgarEventos(pool, config.retencion.dias);
        console.log('[IPAM Cloud Run Job] Purga de eventos y reservas ejecutada exitosamente.');
      } finally {
        await pool.end();
      }
    } else {
      console.log(`[IPAM Cloud Run Job] Tarea ${accion} completada.`);
    }

    console.log(`[IPAM Cloud Run Job] Task ${taskIndex} finalizada con éxito.`);
    return 0;
  } catch (err) {
    console.error(`[IPAM Cloud Run Job] Error en task ${taskIndex}:`, err);
    return 1;
  }
}

module.exports = { run };
