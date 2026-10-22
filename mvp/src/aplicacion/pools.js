// @ts-check
'use strict';
const { validarPoolNuevo, validarTexto, chocaConPool } = require('../dominio/pool');
const { ok, fallo } = require('./resultado');

/**
 * Alta, edición y baja de bloques base (pools). Solo admin (lo exige la ruta). Las altas se serializan con un bloqueo
 * para que dos admins no creen a la vez pools que se solapan.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos}} deps
 */
function crearPools({ repo, eventos }) {
  const solapado = (p) =>
    fallo('conflicto', 'pool_solapado', {
      mensaje: `Se solapa con el pool ${p.id} (${p.cidr}) del mismo proveedor y ambiente. Elige otro rango o ajusta el existente.`,
      conflicto: p,
    });

  async function crear(entrada) {
    const v = validarPoolNuevo(entrada || {});
    if (!v.ok) return fallo('validacion', v.error, { mensaje: v.mensaje });
    const d = v.datos;
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      if (await tx.obtenerPool(d.id)) return fallo('conflicto', 'pool_existe', { mensaje: `Ya existe un pool llamado ${d.id}.` });
      const choca = chocaConPool(d, await tx.todosLosPools());
      if (choca) return solapado(choca);
      await tx.insertarPoolSiNoExiste(d);
      return ok({ pool: d });
    });
    if (r.ok) await eventos.publicar('pool_creado', r.pool);
    return r;
  }

  /** Solo tipo y proveedor: cambiar el CIDR o el ambiente dejaría segmentos fuera de su pool. */
  async function editar(id, entrada) {
    const t = validarTexto(entrada || {});
    if (!t.ok) return fallo('validacion', t.error, { mensaje: t.mensaje });
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      const p = await tx.obtenerPool(id);
      if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool ${id} no existe.` });
      const choca = chocaConPool({ ...p, proveedor: t.proveedor }, await tx.todosLosPools());
      if (choca) return solapado(choca);
      return ok({ antes: p, pool: await tx.actualizarPool(id, { tipo: t.tipo, proveedor: t.proveedor }) });
    });
    if (r.ok) await eventos.publicar('pool_editado', r.pool);
    return r;
  }

  /** Solo un pool vacío: sin asignaciones, reservas vigentes ni direcciones IP registradas. */
  async function eliminar(id) {
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      await tx.bloquear(`pool:${id}`);
      const p = await tx.obtenerPool(id);
      if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool ${id} no existe.` });
      const uso = await tx.usoDePool(id);
      if (uso.asignaciones || uso.reservas_vigentes || uso.direcciones)
        return fallo('conflicto', 'pool_en_uso', {
          mensaje: `No se puede eliminar ${id}: tiene ${uso.asignaciones} asignaciones, ${uso.reservas_vigentes} reservas vigentes y ${uso.direcciones} direcciones IP. Libéralas primero.`,
          uso,
        });
      await tx.eliminarPool(id);
      return ok({ pool: p });
    });
    if (r.ok) await eventos.publicar('pool_eliminado', r.pool);
    return r;
  }

  return { crear, editar, eliminar };
}

module.exports = { crearPools };
