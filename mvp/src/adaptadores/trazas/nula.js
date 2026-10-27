'use strict';
// Trazas apagadas (OTEL_TRACES_EXPORTER=none, el valor por defecto).
module.exports = {
  iniciarSolicitud() {
    return { terminar() {} };
  },
  async iniciar() {},
  async apagar() {},
  activo: false,
};
