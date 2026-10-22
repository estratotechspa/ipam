'use strict';
// Repositorio PostgreSQL. SOLO consultas parametrizadas ($1, $2…): nada de texto concatenado (lo vigila una regla de lint).
// El IPAM es dueño de sus tablas: ningún otro servicio debe leerlas ni escribirlas; se integran por la API.
const { ConflictoDeDatos } = require('../../../aplicacion/resultado');
const { reintentar } = require('./resiliencia');

const COLUMNAS_ASIGNACION = 'id, pool_id, cidr::text, vpc, solicitante, ticket, origen, creado_en';
// Fracción del pool que ocupan los segmentos asignados (para la barra de uso de la interfaz).
const USO_POOL = `coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 / (2^(32-masklen(p.cidr)))::float8`;

/** Traduce los errores de restricción de PostgreSQL a un error de negocio. */
function traducir(e) {
  if (e && (e.code === '23P01' || e.code === '23514' || e.code === '23503')) return new ConflictoDeDatos(e.message, e.code);
  return e;
}

/** Consultas compartidas por el repositorio y por las transacciones (`x` = pool o cliente). */
function consultas(x) {
  const q = (texto, params) => x.query(texto, params);
  return {
    async obtenerPool(id) {
      return (await q('select id, tipo, ambiente, proveedor, cidr::text from pools where id=$1', [id])).rows[0];
    },
    async buscarPools({ ambiente, tipo }) {
      return (await q('select id, tipo, ambiente, proveedor, cidr::text from pools where ambiente=$1 and tipo=$2 order by id', [ambiente, tipo])).rows;
    },
    async ocupados(poolId) {
      return (await q('select cidr::text from asignaciones where pool_id=$1', [poolId])).rows.map((r) => r.cidr);
    },
    async conflicto(poolId, cidr) {
      return (await q(
        'select cidr::text, vpc, solicitante, ticket, creado_en from asignaciones where pool_id=$1 and cidr && $2::cidr limit 1', [poolId, cidr])).rows[0] || null;
    },
    async siguienteTicket() {
      return (await q("select 'NET-' || nextval('ticket_seq') as t")).rows[0].t;
    },
    async insertarAsignacion({ pool, cidr, vpc, solicitante, ticket, origen }) {
      return (await q(
        `insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen) values ($1,$2,$3,$4,$5,$6) returning ${COLUMNAS_ASIGNACION}`,
        [pool, cidr, vpc, solicitante, ticket, origen])).rows[0];
    },
  };
}

/** @param {import('pg').Pool} db */
function crearRepositorio(db) {
  const base = consultas(db);

  async function transaccion(fn) {
    return reintentar(async () => {
      const cl = await db.connect();
      let roto;
      try {
        await cl.query('begin');
        const r = await fn(crearTx(cl));
        await cl.query('commit');
        return r;
      } catch (e) {
        roto = await cl.query('rollback').then(() => undefined, (er) => er); // si el rollback falla, la conexión se descarta
        throw traducir(e);
      } finally {
        cl.release(roto);
      }
    }, { intentos: 3, baseMs: 50, transitorio: (e) => e && (e.code === '40001' || e.code === '40P01') });
  }

  function crearTx(cl) {
    const c = consultas(cl);
    const q = (texto, params) => cl.query(texto, params);
    return {
      ...c,
      consultar: q,
      // Bloqueo de transacción por clave: serializa las operaciones sobre un mismo pool (se libera solo al terminar).
      async bloquear(clave) { await q('select pg_advisory_xact_lock(hashtext($1))', [clave]); },
      async insertarPoolSiNoExiste(p) {
        return (await q('insert into pools (id,tipo,ambiente,proveedor,cidr) values ($1,$2,$3,$4,$5) on conflict (id) do nothing', [p.id, p.tipo, p.ambiente, p.proveedor, p.cidr])).rowCount;
      },
      async insertarAsignacionImportada(a) {
        const x = await q(
          `insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen,creado_en)
           select $1,$2::cidr,$3,$4,$5,$6,coalesce($7::timestamptz,now())
            where not exists (select 1 from asignaciones where pool_id=$1 and cidr=$2::cidr)`,
          [a.pool_id, a.cidr, a.vpc, a.solicitante || 'importado', a.ticket, a.origen, a.creado_en || null]);
        return x.rowCount;
      },
      async insertarUsuarioSiNoExiste(u) {
        return (await q('insert into usuarios (email,nombre,rol) values ($1,$2,$3) on conflict (email) do nothing', [String(u.email).toLowerCase(), u.nombre || '', u.rol])).rowCount;
      },
      async expirarReservasVencidas() { return []; },
      async purgarLimite() { return 0; },
      async ajustarSecuenciaTicket() {
        await q("select setval('ticket_seq', greatest((select last_value from ticket_seq), coalesce((select max(substring(ticket from 5)::int) from asignaciones where ticket ~ '^NET-[0-9]+$'),0)))");
      },
    };
  }

  /**
   * Ejecuta `fn` solo si esta réplica obtiene el advisory lock del barredor y nadie lo ejecutó hace poco.
   * El lock es de transacción (pg_try_advisory_xact_lock): se libera solo y funciona tras un pooler en modo sesión.
   */
  async function conBarredor({ ahora, minimoMs, instancia }, fn) {
    return transaccion(async (tx) => {
      const lock = (await tx.consultar("select pg_try_advisory_xact_lock(hashtext('ipam:barredor')) as ok")).rows[0].ok;
      if (!lock) return { ejecutado: false, motivo: 'otra_instancia' };
      const est = (await tx.consultar('select ultima_ejecucion from barredor_estado where id = 1')).rows[0];
      if (est && est.ultima_ejecucion && ahora.getTime() - new Date(est.ultima_ejecucion).getTime() < minimoMs) return { ejecutado: false, motivo: 'reciente' };
      const inicio = Date.now();
      const resultado = await fn(tx, ahora);
      await tx.consultar('update barredor_estado set ultima_ejecucion = now(), duracion_ms = $1, instancia = $2 where id = 1', [Date.now() - inicio, instancia]);
      return { ejecutado: true, ...resultado };
    });
  }

  return {
    ...base,
    transaccion,
    conBarredor,
    async actualizarTicketAsignacion(id, ticket) {
      await db.query('update asignaciones set ticket=$1 where id=$2', [ticket, id]);
    },
    async liberarAsignacion(id) {
      return (await db.query('delete from asignaciones where id=$1 returning cidr::text, ticket, pool_id', [id])).rows[0] || null;
    },
    async poolsConUso({ ambiente, tipo } = {}) {
      return (await db.query(
        `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones, ${USO_POOL} as uso
           from pools p left join asignaciones a on a.pool_id = p.id
          where ($1::text is null or p.ambiente = $1) and ($2::text is null or p.tipo = $2)
          group by p.id order by p.ambiente desc, p.id`, [ambiente || null, tipo || null])).rows;
    },
    async resumen() {
      return (await db.query(
        `select (select count(*) from pools)::int as pools, (select count(*) from asignaciones)::int as asignaciones,
                (select coalesce(avg(u),0) from (select ${USO_POOL} as u from pools p left join asignaciones a on a.pool_id=p.id group by p.id) x)::float8 as uso_promedio`)).rows[0];
    },
    async listarAsignaciones() {
      return (await db.query(`select ${COLUMNAS_ASIGNACION} from asignaciones order by id desc`)).rows;
    },
    async asignacionesParaExcel() {
      const filas = (await db.query(
        `select a.id, a.pool_id, p.tipo, p.ambiente, p.proveedor, p.cidr::text as pool_cidr, a.cidr::text, a.vpc,
                a.solicitante, a.ticket, a.origen, a.creado_en
           from asignaciones a join pools p on p.id = a.pool_id order by p.ambiente desc, a.pool_id, a.cidr`)).rows;
      const pools = (await db.query(
        `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones, ${USO_POOL} as uso
           from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`)).rows;
      return { filas, pools };
    },
    async exportarDatos() {
      const pools = (await db.query('select id, tipo, ambiente, proveedor, cidr::text from pools order by id')).rows;
      const asignaciones = (await db.query('select pool_id, cidr::text, vpc, solicitante, ticket, origen, creado_en from asignaciones order by pool_id, cidr')).rows;
      const usuarios = (await db.query('select email, nombre, rol from usuarios where rol is not null order by email')).rows;
      return { pools, asignaciones, usuarios };
    },
    async listarUsuarios() {
      return (await db.query('select email, nombre, rol, ultimo_acceso from usuarios order by email')).rows;
    },
    async asignarRol(email, rol) {
      await db.query('insert into usuarios (email, rol) values ($1,$2) on conflict (email) do update set rol = excluded.rol', [email, rol]);
    },
    /** Alta o actualización al iniciar sesión; devuelve el rol asignado en la base (o null). */
    async registrarLogin({ email, nombre }) {
      return (await db.query(
        `insert into usuarios (email, nombre, ultimo_acceso) values ($1,$2,now())
         on conflict (email) do update set nombre = excluded.nombre, ultimo_acceso = now() returning rol`, [email, nombre])).rows[0];
    },
    async listarAuditoria() {
      return (await db.query('select id, ts, usuario, rol, accion, detalle, ip, request_id from auditoria order by id desc limit 200')).rows;
    },
    async registrarAuditoria({ usuario, rol, accion, detalle, ip, requestId }) {
      await db.query('insert into auditoria (usuario, rol, accion, detalle, ip, request_id) values ($1,$2,$3,$4,$5,$6)', [usuario, rol, accion, detalle, ip, requestId || null]);
    },
    async listarEventos() {
      return (await db.query('select id, ts, tipo, detalle from eventos order by id desc limit 50')).rows;
    },
    async registrarEvento(tipo, detalle) {
      await db.query('insert into eventos (tipo, detalle) values ($1,$2)', [tipo, detalle]);
    },
  };
}

module.exports = { crearRepositorio, consultas, traducir, COLUMNAS_ASIGNACION, USO_POOL };
