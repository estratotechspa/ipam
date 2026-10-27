'use strict';
// Lectura por lotes para exportar a Excel. Va en su propio archivo para que el repositorio no crezca sin límite.
const { USO_POOL, COLUMNAS_DIRECCION } = require('./sql-comun');

const SQL_POOLS = `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones, ${USO_POOL} as uso
  from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`;
const SQL_FILAS = `select a.id, a.codigo, a.pool_id, p.tipo, p.ambiente, p.proveedor, p.cidr::text as pool_cidr, a.cidr::text, a.vpc,
    a.vlan, a.vlan_nombre, a.solicitante, a.ticket, a.origen, a.creado_en
  from asignaciones a join pools p on p.id = a.pool_id order by p.ambiente desc, a.pool_id, a.cidr, a.id limit $1 offset $2`;
const SQL_DIRECCIONES = `select ${COLUMNAS_DIRECCION}, a.codigo as segmento_codigo, a.cidr::text as segmento
  from direcciones_ip d left join asignaciones a on a.id = d.asignacion_id order by d.pool_id nulls last, d.ip, d.id limit $1 offset $2`;

/** @param {import('pg').Pool} db */
function consultasDeExportacion(db) {
  return {
    /**
     * Recorre lo que lleva el Excel (segmentos, pools e IPs fijas) dentro de una transacción de solo lectura con instantánea
     * consistente: la memoria no crece con el número de filas y el archivo no mezcla momentos distintos.
     * `consumir` recibe { pools(), filas(), direcciones() }; las dos últimas son generadores asíncronos de lotes.
     */
    async recorrerParaExcel(consumir, { lote = 1000 } = {}) {
      const cl = await db.connect();
      try {
        await cl.query('begin transaction isolation level repeatable read read only');
        const porLotes = (sql) =>
          async function* () {
            for (let desde = 0; ; desde += lote) {
              const filas = (await cl.query(sql, [lote, desde])).rows;
              if (filas.length) yield filas;
              if (filas.length < lote) return;
            }
          };
        return await consumir({ pools: async () => (await cl.query(SQL_POOLS)).rows, filas: porLotes(SQL_FILAS), direcciones: porLotes(SQL_DIRECCIONES) });
      } finally {
        await cl.query('rollback').catch(() => {});
        cl.release();
      }
    },
  };
}

module.exports = { consultasDeExportacion };
