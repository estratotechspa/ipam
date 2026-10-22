'use strict';
// Ciclo de vida del proceso: arranque, barredor y apagado ordenado (procesos «desechables»).
//  SIGTERM/SIGINT → deja de aceptar conexiones, termina las peticiones en curso, detiene el barredor y cierra el pool.
const http = require('node:http');
const express = require('express');
const { config } = require('./config');
const { migrar } = require('./adaptadores/persistencia/postgres/migraciones');
const { crearPlanificador } = require('./adaptadores/planificador/barredor');
const sistema = require('./adaptadores/http/rutas/sistema');

/** @param {ReturnType<typeof import('./server')['compuesto']>} c */
async function iniciar(c) {
  const { app, db, casos, log, estado, avisos, trazas } = c;
  for (const a of avisos) log.warn(a);

  if (config.bd.migrarAlArrancar) {
    log.warn('MIGRAR_AL_ARRANCAR=true: aplicando el esquema antes de escuchar (excepción; lo normal es `npm run migrar` aparte)');
    await migrar({ url: config.bd.urlMigracion, bd: config.bd, log });
  }
  await trazas.iniciar();

  const rol = config.rol;
  let servidor;
  if (rol === 'worker') {
    // El worker solo corre el barredor, pero expone sondas para que la plataforma lo supervise.
    const mini = express();
    mini.disable('x-powered-by');
    sistema.montar(mini, { db, estado, log });
    servidor = http.createServer(mini);
  } else {
    servidor = http.createServer(app);
  }
  servidor.requestTimeout = config.http.solicitudTimeoutMs;
  servidor.keepAliveTimeout = 65_000; // mayor que el de los balanceadores habituales (60 s) para evitar 502 por conexiones reutilizadas
  servidor.headersTimeout = 66_000;

  const planificador = crearPlanificador({ ejecutar: () => casos.barrido.barrer(), intervaloMs: config.reservas.barredorIntervaloSeg * 1000, log });
  if (rol === 'worker' || rol === 'todos') planificador.iniciar();

  await new Promise((ok) => servidor.listen(config.http.puerto, ok));
  log.info('IPAM escuchando', { puerto: config.http.puerto, rol, esquema: config.bd.esquema, entorno: config.entorno });

  let cerrando = null;
  async function apagar(senal) {
    if (cerrando) return cerrando;
    cerrando = (async () => {
      log.info('Apagado ordenado iniciado', { senal });
      estado.apagando = true; // /readyz pasa a 503: el balanceador deja de enviar tráfico
      const limite = setTimeout(() => { log.warn('Tiempo de apagado agotado: se cierran las conexiones restantes'); servidor.closeAllConnections(); }, config.http.apagadoTimeoutMs);
      limite.unref();
      const cerrado = new Promise((ok) => servidor.close(ok)); // deja de aceptar y espera las peticiones en curso
      servidor.closeIdleConnections();
      await planificador.detener();
      await cerrado;
      clearTimeout(limite);
      await trazas.apagar();
      await db.end().catch((e) => log.warn('Error al cerrar el pool', e));
      log.info('Apagado completo');
    })();
    return cerrando;
  }
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => apagar(s).then(() => process.exit(0), () => process.exit(1)));
  return { servidor, apagar, planificador };
}

module.exports = { iniciar };
