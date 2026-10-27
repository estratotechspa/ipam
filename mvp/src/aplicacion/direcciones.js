// @ts-check
'use strict';
const { validarDireccion, validarDatos, avisoDeSegmento } = require('../dominio/direccion');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

/**
 * Direcciones IP fijas (interfaces de router, switch, firewall…). Lo normal es que estén dentro de un segmento asignado;
 * por excepción (con motivo) pueden quedar fuera de un segmento: dentro de un pool o fuera de todo pool.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos}} deps
 */
function crearDirecciones({ repo, eventos }) {
  /** Dónde cae la IP: su segmento (si hay uno) y su pool. Si hay varios candidatos, pide el pool. */
  async function ubicar(ip, poolPedido) {
    const segs = (await repo.asignacionesQueContienen(ip)).filter((a) => !poolPedido || a.pool_id === poolPedido);
    if (segs.length > 1)
      return fallo('ambiguo', 'ip_ambigua', {
        mensaje: `${ip} está en segmentos de varios pools (rangos privados repetidos): indica el pool.`,
        opciones: segs.map((a) => ({ pool: a.pool_id, segmento: a.cidr, codigo: a.codigo })),
      });
    if (segs.length === 1) return ok({ segmento: segs[0], pool_id: segs[0].pool_id });
    const pools = (await repo.poolsQueContienen(ip)).filter((p) => !poolPedido || p.id === poolPedido);
    if (poolPedido && !pools.length) return fallo('validacion', 'ip_fuera_del_pool', { mensaje: `${ip} no está dentro del pool ${poolPedido}.` });
    if (pools.length > 1)
      return fallo('ambiguo', 'ip_ambigua', {
        mensaje: `${ip} cae en varios pools: indica cuál.`,
        opciones: pools.map((p) => ({ pool: p.id, cidr: p.cidr })),
      });
    return ok({ segmento: null, pool_id: pools.length ? pools[0].id : null });
  }

  const repetida = (ip, x) =>
    fallo('conflicto', 'ip_repetida', {
      mensaje: `${ip} ya está registrada${x ? ` (${[x.dispositivo, x.interfaz].filter(Boolean).join(' ') || x.rol})` : ''}.`,
      ...(x ? { existente: x } : {}),
    });

  async function registrar(actor, entrada) {
    const e = entrada || {};
    const v = validarDireccion(e);
    if (!v.ok) return fallo('validacion', v.error, { mensaje: v.mensaje });
    const d = v.datos;
    const poolPedido = typeof e.pool === 'string' && e.pool.trim() ? e.pool.trim() : null;
    const u = await ubicar(d.ip, poolPedido);
    if (!u.ok) return u;
    if (!u.segmento && !d.excepcion)
      return fallo('validacion', 'fuera_de_segmento', {
        mensaje: u.pool_id
          ? `${d.ip} está en el pool ${u.pool_id} pero fuera de todo segmento asignado. Si es una excepción, indica el motivo.`
          : `${d.ip} no está en ningún pool ni segmento. Si es una excepción, indica el motivo.`,
      });
    const x = await repo.direccionEn(u.pool_id, d.ip);
    if (x) return repetida(d.ip, x);
    let fila;
    try {
      fila = await repo.transaccion((tx) =>
        tx.insertarDireccion({
          ...d,
          excepcion: u.segmento ? null : d.excepcion, // dentro de un segmento no es excepción
          pool_id: u.pool_id,
          asignacion_id: u.segmento ? u.segmento.id : null,
          creado_por: (actor && actor.nombre) || 'panel',
        }),
      );
    } catch (err) {
      if (err instanceof ConflictoDeDatos) return repetida(d.ip, null);
      throw err;
    }
    await eventos.publicar('direccion_registrada', { ip: fila.ip, pool: fila.pool_id, dispositivo: fila.dispositivo, interfaz: fila.interfaz });
    return ok({ direccion: fila, segmento: u.segmento, aviso: u.segmento ? avisoDeSegmento(d.ip, u.segmento.cidr) : null });
  }

  /** Cambia los datos descriptivos (la IP no: para eso se borra y se registra otra). Lo que no venga se conserva. */
  async function editar(id, entrada) {
    const actual = await repo.direccionPorId(id);
    if (!actual) return fallo('no_encontrado', 'direccion_no_existe', { mensaje: 'Esa dirección no existe.' });
    const d = validarDatos({ ...actual, ...(entrada || {}) });
    if (!d.ok) return fallo('validacion', d.error, { mensaje: d.mensaje });
    if (!actual.asignacion_id && !d.datos.excepcion)
      return fallo('validacion', 'falta_excepcion', { mensaje: 'Esta IP está fuera de un segmento: el motivo de la excepción es obligatorio.' });
    const datos = { ...d.datos, excepcion: actual.asignacion_id ? null : d.datos.excepcion };
    const fila = await repo.transaccion((tx) => tx.actualizarDireccion(id, datos));
    return ok({ direccion: fila, antes: actual, segmento: await segmentoDe(fila) });
  }

  async function eliminar(id) {
    const fila = await repo.transaccion((tx) => tx.eliminarDireccion(id));
    if (!fila) return fallo('no_encontrado', 'direccion_no_existe', { mensaje: 'Esa dirección no existe.' });
    await eventos.publicar('direccion_eliminada', { ip: fila.ip, pool: fila.pool_id });
    return ok({ direccion: fila, segmento: await segmentoDe(fila) });
  }

  const listar = (filtros) => repo.listarDirecciones(filtros);
  const segmentoDe = async (fila) => (fila && fila.asignacion_id ? repo.asignacionPorId(fila.asignacion_id) : null);

  return { registrar, editar, eliminar, listar };
}

module.exports = { crearDirecciones };
