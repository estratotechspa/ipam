// @ts-check
'use strict';
const { validarPoolNuevo, validarTexto, validarLimitesMascara, validarIdentidad, chocaConPool, ancestros, cabeEnPadre } = require('../dominio/pool');
const { parse } = require('../dominio/cidr');
const { ok, fallo } = require('./resultado');

const solapado = (p) =>
  fallo('conflicto', 'pool_solapado', {
    mensaje: `Se solapa con el pool ${p.id} (${p.cidr}) (los rangos no se repiten entre ambientes ni proveedores; solo un pool puede solaparse con el padre del que sale). Elige otro rango o ajusta el existente.`,
    conflicto: p,
  });

/**
 * Reglas de un pool con identidad de VPC y/o padre, comunes al alta, a la edición y a la creación automática al confirmar el bloque
 * de una VPC. Se llama DENTRO de una transacción con el bloqueo «pools» tomado. No escribe nada: devuelve ok o el fallo.
 *  - el CIDR del hijo está dentro del del padre (pool_fuera_del_padre) y el padre es del mismo ambiente y proveedor;
 *  - nada se solapa con un pool que no sea su ancestro o su descendiente (pool_solapado);
 *  - (proveedor, proyecto, vpc) es único (vpc_duplicada);
 *  - el padre no tiene ya segmentos asignados o reservados en ese bloque (pool_rango_ocupado).
 * @param {any} tx @param {{id: string, ambiente: string, proveedor: string, cidr: string, proyecto?: string|null, vpc?: string|null, padre_id?: string|null}} d
 */
async function revisarPool(tx, d) {
  const todos = await tx.todosLosPools();
  if (d.padre_id) {
    const padre = todos.find((p) => p.id === d.padre_id);
    if (!padre) return fallo('ambiguo', 'padre_no_existe', { mensaje: `El pool padre «${d.padre_id}» no existe.` });
    if (d.padre_id === d.id || ancestros(padre.padre_id ?? null, todos).includes(d.id))
      return fallo('ambiguo', 'pool_fuera_del_padre', { mensaje: 'Un pool no puede ser su propio ancestro.' });
    if (!cabeEnPadre(d.cidr, padre.cidr) || d.cidr === padre.cidr)
      return fallo('ambiguo', 'pool_fuera_del_padre', {
        mensaje: `El bloque ${d.cidr} no está dentro de ${padre.cidr}, el pool padre ${padre.id} (y debe ser más chico que él).`,
        padre: { id: padre.id, cidr: padre.cidr },
      });
    if (padre.ambiente !== d.ambiente || padre.proveedor.toLowerCase() !== d.proveedor.toLowerCase())
      return fallo('ambiguo', 'padre_incompatible', {
        mensaje: `El pool padre ${padre.id} es de ${padre.ambiente}/${padre.proveedor}: el hijo debe ser del mismo ambiente y proveedor.`,
      });
  }
  const choca = chocaConPool(d, todos);
  if (choca) return solapado(choca);
  if (d.vpc) {
    const igual = todos.find(
      (p) => p.id !== d.id && p.vpc === d.vpc && (p.proyecto ?? '') === (d.proyecto ?? '') && p.proveedor.toLowerCase() === d.proveedor.toLowerCase(),
    );
    if (igual)
      return fallo('conflicto', 'vpc_duplicada', {
        mensaje: `La VPC «${d.vpc}»${d.proyecto ? ` del proyecto «${d.proyecto}»` : ''} ya es el pool ${igual.id} (${d.proveedor}).`,
        pool: igual.id,
      });
  }
  if (d.padre_id) {
    const x = await tx.conflicto(d.padre_id, d.cidr);
    if (x && x.fuente !== 'pool')
      return fallo('conflicto', 'pool_rango_ocupado', {
        mensaje: `El bloque ${d.cidr} ya tiene ${x.fuente === 'reserva' ? 'una reserva vigente' : 'un segmento asignado'} (${x.cidr}) en el pool ${d.padre_id}. Libéralo primero o elige otro bloque.`,
        conflicto: x,
      });
  }
  return ok();
}

/**
 * Alta, edición y baja de bloques base (pools). Solo admin (lo exige la ruta). Las altas se serializan con un bloqueo
 * para que dos admins no creen a la vez pools que se solapan.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos}} deps
 */
function crearPools({ repo, eventos }) {
  async function crear(entrada) {
    const v = validarPoolNuevo(entrada || {});
    if (!v.ok) return fallo('validacion', v.error, { mensaje: v.mensaje });
    const d = v.datos;
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      if (d.padre_id) await tx.bloquear(`pool:${d.padre_id}`); // el mismo bloqueo que usan asignar y reservar en el padre
      if (await tx.obtenerPool(d.id)) return fallo('conflicto', 'pool_existe', { mensaje: `Ya existe un pool llamado ${d.id}.` });
      const rev = await revisarPool(tx, d);
      if (!rev.ok) return rev;
      await tx.insertarPoolSiNoExiste(d);
      return ok({ pool: d });
    });
    if (r.ok) await eventos.publicar('pool_creado', r.pool);
    return r;
  }

  /**
   * Tipo, proveedor, límites de máscara e identidad de VPC (proyecto, vpc, padre_id). Cambiar el CIDR o el ambiente dejaría segmentos
   * fuera de su pool. Lo que no viene en el pedido se conserva; nulo quita proyecto, vpc o padre.
   */
  async function editar(id, entrada) {
    const e = entrada || {};
    const t = validarTexto(e);
    if (!t.ok) return fallo('validacion', t.error, { mensaje: t.mensaje });
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      const p = await tx.obtenerPool(id);
      if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool ${id} no existe.` });
      // Los límites de máscara solo cambian si el pedido los trae (nulo los quita); si no, se conservan.
      const trae = ['mascara_defecto', 'mascara_minima', 'mascara_maxima'].some((k) => Object.hasOwn(e, k));
      /** @type {any} */
      const lim = trae
        ? validarLimitesMascara(e, parse(p.cidr)?.len ?? 8)
        : { ok: true, mascara_defecto: p.mascara_defecto ?? null, mascara_minima: p.mascara_minima ?? null, mascara_maxima: p.mascara_maxima ?? null };
      if (!lim.ok) return fallo('validacion', lim.error, { mensaje: lim.mensaje });
      const mezcla = { proyecto: p.proyecto ?? null, vpc: p.vpc ?? null, padre_id: p.padre_id ?? null };
      for (const k of Object.keys(mezcla)) if (Object.hasOwn(e, k)) mezcla[k] = e[k];
      const ident = validarIdentidad(mezcla);
      if (!ident.ok) return fallo('validacion', ident.error, { mensaje: ident.mensaje });
      const nuevo = { ...p, proveedor: t.proveedor, ...ident.datos };
      const cambiaIdentidad = ['proyecto', 'vpc', 'padre_id'].some((k) => (p[k] ?? null) !== nuevo[k]);
      if (nuevo.padre_id) await tx.bloquear(`pool:${nuevo.padre_id}`);
      if (cambiaIdentidad || t.proveedor !== p.proveedor) {
        const rev = await revisarPool(tx, nuevo);
        if (!rev.ok) return rev;
      } else {
        const choca = chocaConPool(nuevo, await tx.todosLosPools());
        if (choca) return solapado(choca);
      }
      return ok({
        antes: p,
        pool: await tx.actualizarPool(id, { tipo: t.tipo, proveedor: t.proveedor, ...lim, ...ident.datos }),
      });
    });
    if (r.ok) await eventos.publicar('pool_editado', r.pool);
    return r;
  }

  /** Solo un pool vacío: sin asignaciones, reservas vigentes, direcciones IP registradas ni pools hijos. */
  async function eliminar(id) {
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear('pools');
      await tx.bloquear(`pool:${id}`);
      const p = await tx.obtenerPool(id);
      if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool ${id} no existe.` });
      const uso = await tx.usoDePool(id);
      if (uso.hijos)
        return fallo('conflicto', 'pool_con_hijos', {
          mensaje: `No se puede eliminar ${id}: de él salen ${uso.hijos} pools hijos (VPC). Elimina o mueve esos pools primero.`,
          uso,
        });
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

module.exports = { crearPools, revisarPool };
