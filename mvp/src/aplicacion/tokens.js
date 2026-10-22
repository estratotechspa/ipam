// @ts-check
'use strict';
const T = require('../dominio/token');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

/** Lo que ve el cliente de un token: nunca el hash. */
const presentar = (t) => ({
  id: t.id, nombre: t.nombre, prefijo: t.prefijo, rol: t.rol, cuota_reservas: t.cuota_reservas, creado_por: t.creado_por, creado_en: t.creado_en,
  expira_en: t.expira_en, ultimo_uso: t.ultimo_uso, revocado_en: t.revocado_en, estado: t.estado, por_vencer: !!t.por_vencer,
});

/**
 * @param {{repo: any, generador: {generar: () => {token: string, hash: string}, hashear: (t: string) => string}, config: any}} deps
 */
function crearTokens({ repo, generador, config }) {
  /** Crea un token. El token en claro solo se devuelve aquí, una vez. */
  async function crear(actor, entrada) {
    const v = T.validarCreacion(entrada || {}, { vidaDefectoDias: config.auth.tokenVidaDias });
    if (!v.ok) return fallo('validacion', v.error, { mensaje: v.mensaje });
    const { token, hash } = generador.generar();
    try {
      const fila = await repo.insertarToken({ nombre: v.nombre, prefijo: T.prefijoDe(token), hash, rol: v.rol, cuota: v.cuota, creadoPor: actor.nombre, dias: v.dias });
      return ok({ token, meta: presentar(fila) });
    } catch (e) {
      if (e instanceof ConflictoDeDatos && e.codigo === '23505') return fallo('conflicto', 'nombre_en_uso', { mensaje: `Ya existe un token llamado «${v.nombre}». Para rotar, crea uno con otro nombre (p. ej. ${v.nombre}-2) y revoca el anterior.` });
      throw e;
    }
  }

  async function listar() {
    return ok({ tokens: (await repo.listarTokens()).map(presentar) });
  }

  /** Revoca (idempotente: revocar uno ya revocado devuelve el mismo resultado). */
  async function revocar(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El token no existe.' });
    const t = await repo.revocarToken(id);
    return t ? ok({ token: presentar(t) }) : fallo('no_encontrado', 'no_encontrado', { mensaje: 'El token no existe.' });
  }

  /**
   * Autentica un token presentado en `Authorization: Bearer`. Devuelve el actor o el motivo del rechazo.
   * @returns {Promise<{ok: true, actor: {nombre: string, rol: string, tipo: 'token', tokenId: string, cuota: number|null}} | {ok: false, motivo: 'formato'|'desconocido'|'vencido'|'revocado', nombre?: string}>}
   */
  async function autenticar(token) {
    if (!T.pareceToken(token)) return { ok: false, motivo: 'formato' };
    const hash = generador.hashear(token);
    const t = await repo.tokenPorHash(hash);
    if (!t) return { ok: false, motivo: 'desconocido' };
    if (t.estado === 'revocado') return { ok: false, motivo: 'revocado', nombre: t.nombre };
    if (t.estado === 'vencido') return { ok: false, motivo: 'vencido', nombre: t.nombre };
    await repo.tocarUltimoUso(t.id); // como máximo una vez por minuto (lo decide la base)
    return { ok: true, actor: { nombre: `svc:${t.nombre}`, rol: t.rol, tipo: 'token', tokenId: t.id, cuota: t.cuota_reservas } };
  }

  return { crear, listar, revocar, autenticar };
}

module.exports = { crearTokens, presentar };
