// @ts-check
'use strict';

/**
 * Tareas en segundo plano: trabajo que no debe retrasar la respuesta al usuario (hoy, la sincronización con Jira) y que
 * nunca debe tumbar el proceso. Se siguen para poder esperarlas al apagar el servicio y en las pruebas.
 * @param {{avisar?: (e: unknown) => void}} [opciones]  `avisar` recibe un error que se escapó de una tarea (para el log)
 */
function crearTareas({ avisar = () => {} } = {}) {
  /** @type {Set<Promise<void>>} */
  const pendientes = new Set();
  return {
    /** Lanza `fn` sin esperarla. Un error suyo no se propaga: se avisa. @param {() => Promise<unknown>|unknown} fn */
    lanzar(fn) {
      const p = Promise.resolve()
        .then(fn)
        .then(
          () => {},
          (e) => avisar(e),
        )
        .finally(() => pendientes.delete(p));
      pendientes.add(p);
    },
    /** Espera a que terminen todas las pendientes (también las que se lancen mientras tanto). */
    async esperar() {
      while (pendientes.size) await Promise.allSettled([...pendientes]);
    },
    cuantas: () => pendientes.size,
  };
}

module.exports = { crearTareas };
