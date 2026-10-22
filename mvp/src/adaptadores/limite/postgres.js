'use strict';
// AlmacenLimite en PostgreSQL: contadores compartidos por todas las réplicas (el reloj es el de la base, así coinciden).
// Ventana deslizante «por contador»: se cuentan las peticiones del minuto actual y del anterior, ponderando el anterior por lo que falta
// del minuto (aproxima una ventana móvil sin guardar cada petición). Redis sería una alternativa futura: mismo puerto, otro adaptador (ver ADR 0005).
const VENTANA_SEG = 60;

const SQL_INCREMENTAR = `
  with t as (
    select (extract(epoch from now())::bigint / $2) as ventana, (extract(epoch from now())::bigint % $2)::float8 / $2 as avance),
  inc as (
    insert into limite_contador (clave, ventana, cuenta)
    select k, t.ventana, 1 from unnest($1::text[]) as k, t
    on conflict (clave, ventana) do update set cuenta = limite_contador.cuenta + 1
    returning clave, cuenta)
  select inc.clave, inc.cuenta as actual, coalesce(p.cuenta, 0) as previa, t.avance
    from inc cross join t left join limite_contador p on p.clave = inc.clave and p.ventana = t.ventana - 1`;
const SQL_ESTADO = `
  with t as (
    select (extract(epoch from now())::bigint / $2) as ventana, (extract(epoch from now())::bigint % $2)::float8 / $2 as avance)
  select $1::text as clave, coalesce(a.cuenta, 0) as actual, coalesce(p.cuenta, 0) as previa, t.avance
    from t left join limite_contador a on a.clave = $1 and a.ventana = t.ventana
           left join limite_contador p on p.clave = $1 and p.ventana = t.ventana - 1`;
const SQL_DEVOLVER = `
  update limite_contador set cuenta = cuenta - 1
   where clave = any($1::text[]) and ventana = (extract(epoch from now())::bigint / $2) and cuenta > 0`;

const fila = (r) => ({ clave: r.clave, actual: Number(r.actual), previa: Number(r.previa), avance: Number(r.avance) });

/** @param {{query: Function}} db */
function crearAlmacenPostgres(db) {
  return {
    /** Suma 1 a cada clave (distintas) y devuelve su estado: [{clave, actual, previa, avance}]. */
    async incrementar(claves, ventanaSeg = VENTANA_SEG) {
      const unicas = [...new Set(claves)];
      return (await db.query(SQL_INCREMENTAR, [unicas, ventanaSeg])).rows.map(fila);
    },
    /** Estado de una clave sin sumar. */
    async estado(clave, ventanaSeg = VENTANA_SEG) {
      return fila((await db.query(SQL_ESTADO, [clave, ventanaSeg])).rows[0]);
    },
    /** Quita 1 a las claves: una petición rechazada no debe consumir cupo. */
    async devolver(claves, ventanaSeg = VENTANA_SEG) {
      await db.query(SQL_DEVOLVER, [[...new Set(claves)], ventanaSeg]);
    },
  };
}

module.exports = { crearAlmacenPostgres, VENTANA_SEG };
