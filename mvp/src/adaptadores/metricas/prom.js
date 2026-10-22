'use strict';
// Métricas en formato Prometheus (GET /metrics). Cualquier recolector las lee: Prometheus, Grafana Agent, Google Managed Prometheus,
// Amazon Managed Prometheus, Azure Monitor… Los dashboards y alertas de cada nube viven en docs/ops/, nunca aquí.
//
// Dos tipos de métrica:
//  - contadores EN PROCESO (peticiones, rechazos de autenticación, límites excedidos, reservas expiradas): cada réplica cuenta lo suyo y
//    Prometheus las suma;
//  - medidores calculados DESDE LA BASE al consultar (reservas, tokens, utilización de pools, último barrido): así son correctos con
//    cualquier número de réplicas y no se «reinician» con los despliegues.
const client = require('prom-client');

const ESTADOS = ['reservada', 'confirmada', 'liberada', 'expirada'];
const CACHE_MS = 5000; // un recolector agresivo no debe martillar la base

/** @param {{repo: any, log: any}} deps */
function crearMetricas({ repo, log }) {
  const registro = new client.Registry();
  client.collectDefaultMetrics({ register: registro });
  const n = (nombre, ayuda, extra = {}) => ({ name: nombre, help: ayuda, registers: [registro], ...extra });

  const peticiones = new client.Counter(n('ipam_http_requests_total', 'Peticiones HTTP atendidas.', { labelNames: ['ruta', 'metodo', 'codigo'] }));
  const duracion = new client.Histogram(n('ipam_http_request_duration_seconds', 'Duración de las peticiones HTTP en segundos.', { labelNames: ['ruta', 'metodo'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] }));
  const reservasActivas = new client.Gauge(n('ipam_reservas_activas', 'Reservas tentativas vigentes ahora.'));
  // Se llama «_total» por el nombre acordado, pero es un medidor: su valor sale de la base (una reserva «reservada» pasa a otro estado), por eso no se «reinicia» al desplegar.
  const reservasPorEstado = new client.Gauge(n('ipam_reservas_total', 'Reservas por estado (calculado desde la base de datos).', { labelNames: ['estado'] }));
  const reservasExpiradas = new client.Counter(n('ipam_reservas_expiradas_total', 'Reservas que esta réplica marcó como expiradas (al consultar o con el barredor).'));
  const utilizacion = new client.Gauge(n('ipam_pool_utilizacion_ratio', 'Fracción ocupada de cada pool (asignaciones + reservas vigentes), de 0 a 1.', { labelNames: ['pool'] }));
  const tokensActivos = new client.Gauge(n('ipam_tokens_activos', 'Tokens de servicio activos (no revocados ni vencidos).'));
  const tokensPorVencer = new client.Gauge(n('ipam_tokens_por_vencer', 'Tokens activos que vencen en menos de 7 días.'));
  const rechazos = new client.Counter(n('ipam_auth_rechazos_total', 'Autenticaciones o accesos rechazados, por motivo.', { labelNames: ['motivo'] }));
  const limiteExcedido = new client.Counter(n('ipam_rate_limit_excedido_total', 'Peticiones rechazadas por exceder el límite (429).'));
  const barredorUltima = new client.Gauge(n('ipam_barredor_ultima_ejecucion_timestamp', 'Momento (segundos UNIX) de la última ejecución del barredor en cualquier réplica; 0 si nunca corrió.'));
  const dbUp = new client.Gauge(n('ipam_db_up', '1 si la base de datos responde, 0 si no.'));

  let ultimaLectura = 0;
  async function refrescar() {
    if (Date.now() - ultimaLectura < CACHE_MS) return;
    try {
      const e = await Promise.race([repo.estadisticas(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]);
      reservasActivas.set(e.reservas.activas);
      for (const estado of ESTADOS) reservasPorEstado.set({ estado }, e.reservas.porEstado[estado] || 0);
      utilizacion.reset();
      for (const p of e.pools) utilizacion.set({ pool: p.id }, Math.min(1, Math.max(0, p.ratio)));
      tokensActivos.set(e.tokens.activos);
      tokensPorVencer.set(e.tokens.porVencer);
      barredorUltima.set(e.barredor);
      dbUp.set(1);
      ultimaLectura = Date.now();
    } catch (err) {
      dbUp.set(0);
      log.warn('Métricas: no se pudo leer la base de datos', err);
    }
  }

  return {
    // --- puerto de métricas (lo llama el resto del código) ---
    solicitud(ruta, metodo, codigo, segundos) { peticiones.inc({ ruta, metodo, codigo: String(codigo) }); duracion.observe({ ruta, metodo }, segundos); },
    authRechazo(motivo) { rechazos.inc({ motivo }); },
    rateLimitExcedido() { limiteExcedido.inc(); },
    reservaExpirada(cantidad = 1) { reservasExpiradas.inc(cantidad); },
    /** Adaptador del puerto PublicadorEventos: cuenta las expiraciones sin que la aplicación sepa de métricas. */
    publicar: async (tipo) => { if (tipo === 'reserva_expirada') reservasExpiradas.inc(); },
    // --- exposición ---
    contentType: registro.contentType,
    async generar() { await refrescar(); return registro.metrics(); },
    registro,
  };
}

module.exports = { crearMetricas, ESTADOS };
