'use strict';
// AlmacenLimite EN MEMORIA: SOLO PARA PRUEBAS (cada proceso tendría sus propios contadores; con varias réplicas el límite sería inconsistente).
// Mismo puerto y misma aritmética que el de PostgreSQL, con reloj inyectable.
const VENTANA_SEG = 60;

/** @param {{ahoraMs?: () => number}} [o] */
function crearAlmacenMemoria({ ahoraMs = () => Date.now() } = {}) {
  const cubos = new Map(); // `${clave}|${ventana}` → cuenta
  const pos = (ventanaSeg) => { const s = Math.floor(ahoraMs() / 1000); return { ventana: Math.floor(s / ventanaSeg), avance: (s % ventanaSeg) / ventanaSeg }; };
  const leer = (clave, ventana) => cubos.get(`${clave}|${ventana}`) || 0;
  const estado = (clave, ventanaSeg) => { const { ventana, avance } = pos(ventanaSeg); return { clave, actual: leer(clave, ventana), previa: leer(clave, ventana - 1), avance }; };
  return {
    async incrementar(claves, ventanaSeg = VENTANA_SEG) {
      const { ventana } = pos(ventanaSeg);
      return [...new Set(claves)].map((c) => { cubos.set(`${c}|${ventana}`, leer(c, ventana) + 1); return estado(c, ventanaSeg); });
    },
    async consultar(clave, ventanaSeg = VENTANA_SEG) { return estado(clave, ventanaSeg); },
    async devolver(claves, ventanaSeg = VENTANA_SEG) {
      const { ventana } = pos(ventanaSeg);
      for (const c of new Set(claves)) if (leer(c, ventana) > 0) cubos.set(`${c}|${ventana}`, leer(c, ventana) - 1);
    },
  };
}

module.exports = { crearAlmacenMemoria };
