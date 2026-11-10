'use strict';
// Migración de las asignaciones de un pool grande a pools hijos por VPC (ver docs/ops/MIGRAR-VPC-A-POOLS.md).
// Siempre calcula el plan sobre el estado ACTUAL de la base; solo escribe con `aplicar: true` y si el plan no tiene problemas.
// Todo ocurre en UNA transacción: o se migra todo o no se toca nada. Se ejecuta con el usuario migrador, no con la aplicación.
const { planificar } = require('../../../dominio/migracion-vpc');
const { crearCliente, prepararSesion } = require('./pool');

const USUARIO = 'migracion-vpc';

/** Hereda del padre los límites de máscara que caben en el hijo (son los de las subredes que saldrán de él). */
function limites(padre, largoHijo) {
  const cabe = (n) => (n === null || n === undefined || n < largoHijo ? null : n);
  const minima = padre.mascara_minima === null || padre.mascara_minima === undefined ? null : Math.max(padre.mascara_minima, largoHijo);
  return [cabe(padre.mascara_defecto), minima, cabe(padre.mascara_maxima)];
}

async function leerEstado(c, padreId) {
  const padre = (
    await c.query('select id, ambiente, proveedor, cidr::text, mascara_defecto, mascara_minima, mascara_maxima from pools where id = $1', [padreId])
  ).rows[0];
  if (!padre) throw new Error(`El pool «${padreId}» no existe.`);
  const asignaciones = (await c.query('select id, cidr::text, vpc, proyecto from asignaciones where pool_id = $1 order by cidr', [padreId])).rows;
  const reservasVigentes = (await c.query("select cidr::text from reservas where pool_id = $1 and estado = 'reservada' and expira_en > now()", [padreId])).rows;
  const hijosExistentes = (await c.query('select id, cidr::text from pools where padre_id = $1', [padreId])).rows;
  const idsEnUso = (await c.query('select id from pools')).rows.map((r) => r.id);
  return { padre, asignaciones, reservasVigentes, hijosExistentes, idsEnUso };
}

/**
 * @param {{url: string, bd: object, padre: string, ajustes?: any[], aplicar?: boolean}} o
 * @returns {Promise<{plan: any, aplicado: boolean, movidas: number}>}
 */
async function migrarVpcAPools({ url, bd, padre: padreId, ajustes = [], aplicar = false }) {
  if (!url) throw new Error('Falta la URL de conexión (DATABASE_URL_MIGRACION, o DATABASE_URL si falta).');
  const c = await crearCliente(url, bd);
  try {
    await prepararSesion(c, bd);
    await c.query('begin');
    try {
      await c.query("select pg_advisory_xact_lock(hashtext('pools'))");
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`pool:${padreId}`]);
      const estado = await leerEstado(c, padreId);
      const plan = planificar({ ...estado, ajustes });
      if (!aplicar || !plan.ok || !plan.grupos.length) {
        await c.query('rollback');
        return { plan, aplicado: false, movidas: 0 };
      }
      const { padre } = estado;
      // El ajuste local deja que el pool hijo nazca antes de que se le muevan las asignaciones (el disparador lo exige vacío en el padre).
      await c.query("select set_config('ipam.migrando_pools', 'on', true)");
      let movidas = 0;
      for (const g of plan.grupos) {
        const [defecto, minima, maxima] = limites(padre, Number(g.cidr.split('/')[1]));
        await c.query(
          'insert into pools (id,tipo,ambiente,proveedor,cidr,mascara_defecto,mascara_minima,mascara_maxima,proyecto,vpc,padre_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [g.pool_id, 'VPC', padre.ambiente, padre.proveedor, g.cidr, defecto, minima, maxima, g.proyecto, g.vpc, padre.id],
        );
        movidas += (await c.query('update asignaciones set pool_id = $1 where id = any($2::bigint[]) and pool_id = $3', [g.pool_id, g.ids, padre.id])).rowCount;
        // Las IP fijas siguen a su segmento: el disparador vuelve a tomar el pool de la asignación.
        await c.query('update direcciones_ip set asignacion_id = asignacion_id where asignacion_id = any($1::bigint[])', [g.ids]);
        await c.query('insert into auditoria (usuario, rol, accion, detalle) values ($1, $2, $3, $4)', [
          USUARIO,
          'admin',
          'crear_pool',
          {
            pool: g.pool_id,
            cidr: g.cidr,
            ambiente: padre.ambiente,
            proveedor: padre.proveedor,
            tipo: 'VPC',
            proyecto: g.proyecto,
            vpc: g.vpc,
            padre: padre.id,
            asignaciones_movidas: g.asignaciones,
          },
        ]);
      }
      // Garantía final: el padre no conserva nada dentro de lo que repartió.
      const sobra = (
        await c.query('select count(*)::int as n from asignaciones a join pools h on h.padre_id = a.pool_id and h.cidr && a.cidr where a.pool_id = $1', [
          padre.id,
        ])
      ).rows[0].n;
      if (sobra) throw new Error(`Quedaron ${sobra} asignaciones dentro de bloques ya repartidos: se deshace todo.`);
      await c.query('commit');
      return { plan, aplicado: true, movidas };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    }
  } finally {
    await c.end().catch(() => {});
  }
}

module.exports = { migrarVpcAPools };
