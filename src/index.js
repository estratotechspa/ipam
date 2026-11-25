'use strict';

// Punto de entrada dual para Cloud Run:
// 1. Si se invoca como Cloud Run Job (detectado por CLOUD_RUN_TASK_INDEX o IPAM_MODE=job):
//    corre la tarea batch en src/job.js y termina con process.exitCode.
// 2. Si se invoca como Servicio HTTP (Cloud Run Service o npm start):
//    levanta la API Express y sirve la interfaz Web UI en public/.
const isJob = process.env.CLOUD_RUN_TASK_INDEX !== undefined || process.env.IPAM_MODE === 'job';

if (isJob) {
  const { run } = require('./job');
  run()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      console.error('Task fallida con excepción no capturada:', err);
      process.exitCode = 1;
    });
} else {
  const { compuesto } = require('./server');
  require('./arranque').iniciar(compuesto);
}
