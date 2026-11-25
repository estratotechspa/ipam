'use strict';
// Implementación vacía del puerto de métricas: permite llamar a las métricas sin comprobar si están activas.
module.exports = {
  solicitud() {},
  authRechazo() {},
  rateLimitExcedido() {},
  reservaExpirada() {},
  barredorEjecutado() {},
};
