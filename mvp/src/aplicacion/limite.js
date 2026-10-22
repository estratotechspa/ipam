// @ts-check
'use strict';

const VENTANA_SEG = 60;
const UMBRAL_EXCESOS_AUDITADOS = 5; // a partir de este número de excesos en un minuto se audita (una vez por minuto y actor)

/** Total ponderado de la ventana deslizante: lo del minuto anterior pesa según lo que falta del minuto actual. */
const ponderado = (e) => e.previa * (1 - e.avance) + e.actual;

/**
 * Segundos que debe esperar quien fue rechazado: hasta que el total ponderado deje de superar el límite (como mucho, lo que falta del minuto).
 * @param {{actual: number, previa: number, avance: number}} e estado SIN contar la petición rechazada
 */
function segundosDeEspera(e, limite, ventanaSeg = VENTANA_SEG) {
  const hastaElFin = (1 - e.avance) * ventanaSeg;
  const sobra = ponderado(e) - (limite - 1); // cuánto hay que «dejar caer» para que quepa una petición más
  if (e.previa > 0 && sobra > 0) {
    const t = (sobra * ventanaSeg) / e.previa;
    if (t <= hastaElFin) return Math.max(1, Math.ceil(t));
  }
  return Math.max(1, Math.ceil(hastaElFin));
}

/**
 * Límite de peticiones por actor (token o usuario) y por IP, y freno a la fuerza bruta (fallos de autenticación por IP).
 * Si el almacén falla, se deja pasar (el límite es una protección, no un requisito de corrección) y se avisa en el log.
 * @param {{almacen: any, config: any, auditor: import('./puertos').Auditor, log: any, metricas?: any}} deps
 */
function crearLimite({ almacen, config, auditor, log, metricas }) {
  /** @returns {Promise<{permitido: boolean, limite: number, restantes: number, reinicio: number, retryAfter?: number, motivo?: 'actor'|'ip'}>} */
  async function evaluar({ actor, ip, escritura }) {
    const c = config.limite;
    const reglas = [];
    if (actor)
      reglas.push({
        motivo: /** @type {const} */ ('actor'),
        clave: `a:${actor}:${escritura ? 'w' : 'r'}`,
        limite: escritura ? c.escrituraPorMinuto : c.lecturaPorMinuto,
      });
    if (ip) reglas.push({ motivo: /** @type {const} */ ('ip'), clave: `ip:${ip}`, limite: c.ipPorMinuto });
    if (!reglas.length) return { permitido: true, limite: 0, restantes: 0, reinicio: VENTANA_SEG };
    try {
      const estados = await almacen.incrementar(
        reglas.map((r) => r.clave),
        VENTANA_SEG,
      );
      const por = new Map(estados.map((e) => [e.clave, e]));
      // Se informa el límite más cercano a agotarse.
      let peor = { restantes: Infinity, limite: 0 };
      let excedida = null;
      for (const r of reglas) {
        const e = por.get(r.clave);
        const total = ponderado(e);
        const restantes = Math.max(0, Math.floor(r.limite - total));
        if (restantes < peor.restantes) peor = { restantes, limite: r.limite };
        if (total > r.limite && !excedida) excedida = { ...r, e };
      }
      const reinicio = Math.ceil((1 - por.get(reglas[0].clave).avance) * VENTANA_SEG);
      if (!excedida) return { permitido: true, limite: peor.limite, restantes: peor.restantes, reinicio };

      // Rechazada: no consume cupo, y si insiste se audita (una vez por minuto y actor).
      await almacen.devolver(
        reglas.map((r) => r.clave),
        VENTANA_SEG,
      );
      const sinEsta = { actual: excedida.e.actual - 1, previa: excedida.e.previa, avance: excedida.e.avance };
      const retryAfter = segundosDeEspera(sinEsta, excedida.limite);
      if (metricas) metricas.rateLimitExcedido();
      const quien = actor || `ip:${ip}`;
      const [exceso] = await almacen.incrementar([`x:${quien}`], VENTANA_SEG);
      if (exceso.actual === UMBRAL_EXCESOS_AUDITADOS) {
        await auditor.registrar({
          accion: 'rate_limit_excedido',
          usuario: actor || 'anonimo',
          rol: null,
          ip,
          detalle: { motivo: excedida.motivo, tipo: escritura ? 'escritura' : 'lectura', excesos_en_el_minuto: exceso.actual, limite: excedida.limite },
        });
      }
      return { permitido: false, limite: excedida.limite, restantes: 0, reinicio: retryAfter, retryAfter, motivo: excedida.motivo };
    } catch (e) {
      log.warn('El almacén del límite de peticiones falló: se deja pasar la petición', e);
      return { permitido: true, limite: 0, restantes: 0, reinicio: VENTANA_SEG };
    }
  }

  /** ¿Esta IP acumuló demasiados fallos de autenticación en el último minuto? */
  async function bloqueadaPorFallos(ip) {
    if (!ip) return { bloqueada: false };
    try {
      const e = await almacen.estado(`f:${ip}`, VENTANA_SEG);
      const limite = config.limite.authFallosPorMinuto;
      return ponderado(e) >= limite
        ? { bloqueada: true, retryAfter: segundosDeEspera({ actual: e.actual, previa: e.previa, avance: e.avance }, limite) }
        : { bloqueada: false };
    } catch (e) {
      log.warn('No se pudo consultar el freno de fuerza bruta: se deja pasar', e);
      return { bloqueada: false };
    }
  }

  /** Registra un intento de autenticación fallido de esta IP. */
  async function registrarFallo(ip) {
    if (!ip) return;
    try {
      await almacen.incrementar([`f:${ip}`], VENTANA_SEG);
    } catch (e) {
      log.warn('No se pudo registrar el fallo de autenticación', e);
    }
  }

  return { evaluar, bloqueadaPorFallos, registrarFallo };
}

module.exports = { crearLimite, ponderado, segundosDeEspera, VENTANA_SEG };
