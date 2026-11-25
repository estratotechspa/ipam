// @ts-check
'use strict';
// Revalidación de sesiones OIDC. La cookie es válida mientras no caduque, pero la persona puede haber sido dada de baja,
// eliminada o cambiada de rol: cada SESSION_REVALIDAR_SEG se consulta su fila en `usuarios` y se calcula el rol de HOY.
// La caché es solo de rendimiento y por réplica: con varias, un cambio puede tardar hasta ese tiempo en llegar a todas.
const { config } = require('../../config');
const { rolVigente } = require('../../dominio/roles');

const TOPE_CACHE = 5000;

/** @param {{buscar: (email: string) => Promise<{rol?: string|null, activo?: boolean}|null>}} deps */
function crearRevalidador({ buscar }) {
  /** @type {Map<string, {fila: any, hasta: number}>} */
  const cache = new Map();

  /** Fila del usuario (null si no existe), con caché. */
  async function fila(email) {
    const ttl = config.auth.sesionRevalidarSeg * 1000;
    const c = cache.get(email);
    if (c && c.hasta > Date.now()) return c.fila;
    const f = await buscar(email);
    if (ttl > 0) {
      if (cache.size >= TOPE_CACHE) for (const [k, v] of cache) if (v.hasta <= Date.now()) cache.delete(k);
      cache.set(email, { fila: f, hasta: Date.now() + ttl });
    }
    return f;
  }

  return {
    /** Rol vigente de una sesión abierta, o null si ya no vale (usuario dado de baja o eliminado). @param {{email: string, rolBase?: string|null}} sesion */
    rol: async (sesion) => rolVigente(sesion, await fila(sesion.email), config.auth.oidc),
    /** Olvida a una persona (se llama al cambiarle el rol o la baja desde esta réplica: rige al instante aquí). @param {string} email */
    olvidar: (email) => {
      cache.delete(String(email || '').toLowerCase());
    },
    olvidarTodos: () => cache.clear(),
  };
}

module.exports = { crearRevalidador };
