'use strict';
// Trazas OpenTelemetry (OTLP/HTTP) hacia cualquier colector: Google Cloud, AWS, Azure, Grafana, Jaeger…
// APAGADAS por defecto. Se activan con OTEL_TRACES_EXPORTER=otlp y OTEL_EXPORTER_OTLP_ENDPOINT.
// Una traza por petición HTTP. Nunca se registran cuerpos, cabeceras ni la query string (solo método, ruta de plantilla y estado).
// Los paquetes de OpenTelemetry se cargan solo si se activan: apagado, no cuestan nada.
const { config } = require('../../config');

/** "k1=v1,k2=v2" → {k1: 'v1', k2: 'v2'} */
function parsearCabeceras(texto) {
  const o = {};
  for (const par of String(texto || '').split(',')) {
    const i = par.indexOf('=');
    if (i > 0) o[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return o;
}

/**
 * @param {{log: any, version?: string, exportador?: any}} o  `exportador` solo se inyecta en pruebas.
 */
function crearTrazas({ log, version = 'dev', exportador }) {
  let proveedor = null;
  let tracer = null;
  let api = null;
  let propagador = null;
  return {
    activo: true,
    async iniciar() {
      api = require('@opentelemetry/api');
      const { TracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace');
      const { resourceFromAttributes } = require('@opentelemetry/resources');
      const { W3CTraceContextPropagator } = require('@opentelemetry/core');
      const c = config.otel;
      const exp = exportador || new (require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter)({
        url: `${c.endpoint.replace(/\/+$/, '')}/v1/traces`, headers: parsearCabeceras(c.cabeceras), timeoutMillis: 10000,
      });
      proveedor = new TracerProvider({
        resource: resourceFromAttributes({ 'service.name': c.servicio, 'service.version': version }),
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(c.muestreo) }),
        spanProcessors: [new BatchSpanProcessor({ exporter: exp })],
      });
      tracer = proveedor.getTracer('ipam');
      propagador = new W3CTraceContextPropagator();
      log.info('Trazas OpenTelemetry activadas', { servicio: c.servicio, muestreo: c.muestreo });
    },
    /** Abre el span de la petición (continúa la traza si llega `traceparent`) y anota el trace_id en el contexto para los logs. */
    iniciarSolicitud(req, datos) {
      if (!tracer) return { terminar() {} };
      const padre = propagador.extract(api.ROOT_CONTEXT, req.headers, api.defaultTextMapGetter);
      const span = tracer.startSpan(`${req.method}`, { kind: api.SpanKind.SERVER, attributes: { 'http.request.method': req.method } }, padre);
      datos.trace_id = span.spanContext().traceId;
      return {
        terminar(estado, plantilla) {
          span.updateName(`${req.method} ${plantilla}`);
          span.setAttribute('http.route', plantilla);
          span.setAttribute('http.response.status_code', estado);
          if (estado >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
          span.end();
        },
      };
    },
    async apagar() {
      if (!proveedor) return;
      try { await proveedor.forceFlush({ timeoutMillis: 5000 }); } catch (e) { log.warn('No se pudieron enviar todas las trazas al apagar', { error: Array.isArray(e) ? e.map(String) : e }); }
      await proveedor.shutdown().catch(() => {});
    },
  };
}

module.exports = { crearTtracas: undefined, crearTrazas, parsearCabeceras };
