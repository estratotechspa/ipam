'use strict';
// Raíz de composición: aquí (y solo aquí) se conectan los adaptadores con los casos de uso.
// Importar este módulo construye la app y el pool sin escuchar; `node src/server.js` además arranca el servicio.
const os = require('node:os');
const crypto = require('node:crypto');
const { config, validarOFallar } = require('./config');
const contexto = require('./adaptadores/http/contexto');
const { crearLogger } = require('./adaptadores/log/logger');
const { crearPool } = require('./adaptadores/persistencia/postgres/pool');
const { crearRepositorio } = require('./adaptadores/persistencia/postgres/repositorio');
const { crearPublicador } = require('./adaptadores/eventos');
const { crearMetricas } = require('./adaptadores/metricas/prom');
const tickets = require('./adaptadores/tickets/jira');
const generadorToken = require('./adaptadores/auth/token');
const { crearCasos } = require('./aplicacion');
const { crearTareas } = require('./aplicacion/tareas');
const contrasenas = require('./adaptadores/auth/contrasena');
const { crearLimite } = require('./aplicacion/limite');
const { crearAlmacenPostgres } = require('./adaptadores/limite/postgres');
const { crearAlmacenMemoria } = require('./adaptadores/limite/memoria');
const { crearApp } = require('./adaptadores/http/app');
const version = require('../package.json').version;

const instancia = `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`;
const log = crearLogger({
  nivel: config.log.nivel,
  base: { servicio: 'ipam' },
  contexto: () => {
    const c = contexto.actual();
    return { request_id: c.request_id, actor: c.actor, trace_id: c.trace_id };
  },
});

const trazas = config.otel.activo ? require('./adaptadores/trazas/otel').crearTrazas({ log, version }) : require('./adaptadores/trazas/nula');

function construir() {
  const avisos = validarOFallar();
  const db = crearPool(config.bd, log);
  const repo = crearRepositorio(db);
  const reloj = { ahora: () => new Date() };
  const metricas = crearMetricas({ repo, log });
  const publicador = crearPublicador({ repo, log, cfg: config.eventos, extra: [metricas] });
  const auditor = {
    // La auditoría nunca bloquea ni rompe la operación: si falla, queda en el log. El request_id sale del contexto.
    registrar: ({ accion, usuario, rol = null, detalle = {}, ip = null }) =>
      repo.registrarAuditoria({ usuario, rol, accion, detalle, ip, requestId: contexto.actual().request_id }).catch((e) => log.error('auditoría', e)),
  };
  const auditar = (accion, usuario, rol, detalle = {}, ip = null) => auditor.registrar({ accion, usuario, rol, detalle, ip });
  const tareas = crearTareas({ avisar: (e) => log.error('Tarea en segundo plano', e) });
  const casos = crearCasos({ repo, eventos: publicador, auditor, tickets, reloj, config, instancia, generadorToken, contrasenas, tareas });
  // Puerto AlmacenLimite: PostgreSQL por defecto (varias réplicas comparten contadores); «memoria» solo para pruebas.
  const almacen = config.limite.almacen === 'memoria' ? crearAlmacenMemoria() : crearAlmacenPostgres(db);
  const limite = crearLimite({ almacen, config, auditor, log, metricas });
  const estado = { apagando: false };
  const app = crearApp({ config, log, db, repo, casos, auditar, publicador, tickets, estado, metricas, trazas, limite });
  return { app, db, repo, casos, log, estado, avisos, instancia, metricas, trazas, tareas };
}

let compuesto;
try {
  compuesto = construir();
} catch (e) {
  if (require.main !== module) throw e;
  // Arranque fallido: mensaje claro en JSON (nada de trazas ni secretos) y código de salida distinto de cero.
  log.error(e.problemas ? 'Configuración inválida: el servicio no arranca' : 'El servicio no pudo arrancar', e.problemas ? { problemas: e.problemas } : e);
  process.exit(1);
}

if (require.main === module) require('./arranque').iniciar(compuesto);

module.exports = { app: compuesto && compuesto.app, db: compuesto && compuesto.db, compuesto };
