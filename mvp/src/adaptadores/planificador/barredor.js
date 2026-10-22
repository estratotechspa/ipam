'use strict';
// Planificador del barredor: ejecuta una tarea cada cierto tiempo, sin solaparse y con algo de azar para que
// las réplicas no despierten todas a la vez. El temporizador usa unref(): nunca impide que el proceso termine.
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** @param {{ejecutar: () => Promise<unknown>, intervaloMs: number, log: any}} o */
function crearPlanificador({ ejecutar, intervaloMs, log }) {
  let timer = null;
  let enCurso = false;
  let detenido = true;

  async function tick() {
    if (enCurso || detenido) return;
    enCurso = true;
    try {
      await ejecutar();
    } catch (e) {
      log.error('El barredor falló (se reintentará)', e);
    } finally {
      enCurso = false;
      programar();
    }
  }
  function programar() {
    if (detenido) return;
    timer = setTimeout(tick, Math.round(intervaloMs * (0.9 + Math.random() * 0.2)));
    timer.unref();
  }
  return {
    iniciar() {
      if (!detenido) return;
      detenido = false;
      programar();
    },
    async detener() {
      detenido = true;
      clearTimeout(timer);
      while (enCurso) await dormir(20);
    },
    tick,
    get activo() {
      return !detenido;
    },
  };
}

module.exports = { crearPlanificador };
