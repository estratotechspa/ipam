'use strict';
// Repositorio PostgreSQL. SOLO consultas parametrizadas ($1, $2…): nada de texto concatenado (lo vigila una regla de lint).
// El IPAM es dueño de sus tablas: ningún otro servicio debe leerlas ni escribirlas; se integran por la API.
const { ConflictoDeDatos } = require('../../../aplicacion/resultado');
const { reintentar } = require('./resiliencia');
const { SOLICITANTE_JIRA } = require('../../../dominio/reserva');

const COLUMNAS_ASIGNACION = 'id, codigo, pool_id, cidr::text, vpc, vlan, vlan_nombre, solicitante, ticket, origen, creado_en';
// Fracción del pool que ocupan los segmentos asignados (para la barra de uso de la interfaz).
const USO_POOL = `coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 / (2^(32-masklen(p.cidr)))::float8`;

// Reservas: el estado «real» considera el plazo con el reloj de la BASE (no el de cada réplica): una reserva «reservada» vencida cuenta como expirada.
const ESTADO_EFECTIVO = `case when estado = 'reservada' and expira_en <= now() then 'expirada' else estado end`;
const COLUMNAS_RESERVA = `id, pool_id, cidr::text, vpc, vlan, vlan_nombre, solicitante, ticket, creado_en, expira_en, resuelto_en, asignacion_id,
  ${ESTADO_EFECTIVO} as estado, estado as estado_registrado,
  case when estado = 'reservada' and expira_en > now() then floor(extract(epoch from (expira_en - now())))::int else 0 end as segundos_restantes`;
const RESERVA_VIGENTE = `estado = 'reservada' and expira_en > now()`;
const SQL_RESERVA_POR_ID = `select ${COLUMNAS_RESERVA} from reservas where id=$1`;
const SQL_RESERVA_POR_ID_BLOQUEADA = `${SQL_RESERVA_POR_ID} for update`; // FOR UPDATE: nadie más cambia esta reserva mientras decidimos

// Tokens de servicio (nunca se devuelve el hash). El estado y el «por vencer» se calculan con el reloj de la base.
const COLUMNAS_TOKEN = `id, nombre, prefijo, rol, cuota_reservas, creado_por, creado_en, expira_en, ultimo_uso, revocado_en,
  case when revocado_en is not null then 'revocado' when expira_en <= now() then 'vencido' else 'activo' end as estado,
  (revocado_en is null and expira_en > now() and expira_en < now() + interval '7 days') as por_vencer`;

/** Traduce los errores de restricción de PostgreSQL a un error de negocio. */
function traducir(e) {
  if (e && (e.code === '23P01' || e.code === '23514' || e.code === '23503' || e.code === '23505')) return new ConflictoDeDatos(e.message, e.code);
  return e;
}

/** Consultas compartidas por el repositorio y por las transacciones (`x` = pool o cliente). */
function consultas(x) {
  const q = (texto, params) => x.query(texto, params);
  return {
    async obtenerPool(id) {
      return (await q('select id, tipo, ambiente, proveedor, cidr::text from pools where id=$1', [id])).rows[0];
    },
    /** Todos los pools (para analizar una importación). */
    async todosLosPools() {
      return (await q('select id, tipo, ambiente, proveedor, cidr::text from pools order by id')).rows;
    },
    /** Todo lo ocupado en cualquier pool: asignaciones y reservas vigentes. */
    async todosOcupados() {
      return (
        await q(
          `select pool_id, cidr::text, vpc from asignaciones
           union all select pool_id, cidr::text, vpc from reservas where ${RESERVA_VIGENTE}`,
        )
      ).rows;
    },
    async buscarPools({ ambiente, tipo }) {
      return (await q('select id, tipo, ambiente, proveedor, cidr::text from pools where ambiente=$1 and tipo=$2 order by id', [ambiente, tipo])).rows;
    },
    /** Rangos ocupados de un pool: asignaciones + reservas vigentes. */
    async ocupados(poolId) {
      return (
        await q(
          `select cidr::text from asignaciones where pool_id=$1
         union all select cidr::text from reservas where pool_id=$1 and ${RESERVA_VIGENTE}`,
          [poolId],
        )
      ).rows.map((r) => r.cidr);
    },
    /** Primer rango (asignado o reservado) que se solapa con `cidr`, o null. */
    async conflicto(poolId, cidr) {
      const a = (
        await q(
          `select 'asignacion' as fuente, cidr::text, vpc, solicitante, ticket, creado_en from asignaciones where pool_id=$1 and cidr && $2::cidr limit 1`,
          [poolId, cidr],
        )
      ).rows[0];
      if (a) return a;
      return (
        (
          await q(
            `select 'reserva' as fuente, cidr::text, vpc, solicitante, ticket, creado_en, expira_en from reservas where pool_id=$1 and ${RESERVA_VIGENTE} and cidr && $2::cidr limit 1`,
            [poolId, cidr],
          )
        ).rows[0] || null
      );
    },
    async siguienteTicket() {
      return (await q("select 'NET-' || nextval('ticket_seq') as t")).rows[0].t;
    },
    async insertarAsignacion({ pool, cidr, vpc, solicitante, ticket, origen, vlan = null, vlan_nombre = null }) {
      return (
        await q(
          `insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen, vlan, vlan_nombre) values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${COLUMNAS_ASIGNACION}`,
          [pool, cidr, vpc, solicitante, ticket, origen, vlan, vlan_nombre],
        )
      ).rows[0];
    },
    async asignacionPorId(id) {
      if (id === null || id === undefined) return null;
      return (await q(`select ${COLUMNAS_ASIGNACION} from asignaciones where id=$1`, [id])).rows[0] || null;
    },
    // ---------- Reservas ----------
    async reservaPorClave(solicitante, clave) {
      return (await q(`select ${COLUMNAS_RESERVA} from reservas where solicitante=$1 and clave_idem=$2`, [solicitante, clave])).rows[0] || null;
    },
    async reservaPorId(id, { bloquear = false } = {}) {
      return (await q(bloquear ? SQL_RESERVA_POR_ID_BLOQUEADA : SQL_RESERVA_POR_ID, [id])).rows[0] || null;
    },
    async listarReservas({ estado, pool, solicitante, limite }) {
      return (
        await q(
          `select ${COLUMNAS_RESERVA} from reservas
          where ($1::text is null or ${ESTADO_EFECTIVO} = $1) and ($2::text is null or pool_id = $2) and ($3::text is null or solicitante = $3)
          order by creado_en desc, id limit $4`,
          [estado, pool, solicitante, limite],
        )
      ).rows;
    },
    async contarVigentesDe(solicitante) {
      return (await q(`select count(*)::int as n from reservas where solicitante=$1 and ${RESERVA_VIGENTE}`, [solicitante])).rows[0].n;
    },
    async insertarReserva({ pool, cidr, vpc, solicitante, ticket, ttlHoras, clave, vlan = null, vlan_nombre = null }) {
      return (
        await q(
          `with nueva as (
           insert into reservas (pool_id, cidr, vpc, solicitante, ticket, clave_idem, expira_en, vlan, vlan_nombre)
           values ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7::int), $8, $9) returning *)
         select ${COLUMNAS_RESERVA} from nueva`,
          [pool, cidr, vpc, solicitante, ticket, clave, ttlHoras, vlan, vlan_nombre],
        )
      ).rows[0];
    },
    /** Marca como expiradas las reservas vencidas (de un pool o, con null, de todos). Devuelve las que cambió. */
    async expirarVencidas(poolId) {
      return (
        await q(
          `update reservas set estado = 'expirada', resuelto_en = now()
          where estado = 'reservada' and expira_en <= now() and ($1::text is null or pool_id = $1)
          returning id, cidr::text, pool_id, solicitante`,
          [poolId],
        )
      ).rows;
    },
    async marcarExpirada(id) {
      return (
        await q(
          `update reservas set estado = 'expirada', resuelto_en = now() where id = $1 and estado = 'reservada' returning id, cidr::text, pool_id, solicitante`,
          [id],
        )
      ).rows[0];
    },
    async marcarConfirmada(id, asignacionId) {
      return (
        await q(
          `with r as (update reservas set estado = 'confirmada', resuelto_en = now(), asignacion_id = $2 where id = $1 returning *) select ${COLUMNAS_RESERVA} from r`,
          [id, asignacionId],
        )
      ).rows[0];
    },
    async marcarLiberada(id) {
      return (
        await q(`with r as (update reservas set estado = 'liberada', resuelto_en = now() where id = $1 returning *) select ${COLUMNAS_RESERVA} from r`, [id])
      ).rows[0];
    },
    async borrarAsignacion(id) {
      return (await q('delete from asignaciones where id=$1', [id])).rowCount > 0;
    },
    /** Crea la asignación definitiva de una reserva. El ajuste local le dice al disparador que ese rango es el de ESA reserva. */
    async insertarAsignacionDeReserva(r) {
      await q("select set_config('ipam.reserva_confirmando', $1, true)", [r.id]);
      return (
        await q(
          `insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen, vlan, vlan_nombre) values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${COLUMNAS_ASIGNACION}`,
          [r.pool_id, r.cidr, r.vpc, r.solicitante, r.ticket, r.solicitante === SOLICITANTE_JIRA ? 'jira' : 'agente', r.vlan ?? null, r.vlan_nombre ?? null],
        )
      ).rows[0];
    },
  };
}

/** Usuarios, auditoría, eventos, tokens y estadísticas (lo que usa la administración y las métricas). */
function consultasDeAdministracion(db) {
  return {
    async listarUsuarios() {
      return (
        await db.query(
          `select email, nombre, rol, activo, (clave_hash is not null) as local, debe_cambiar_clave, ultimo_acceso, creado_en, creado_por
           from usuarios order by email`,
        )
      ).rows;
    },
    async usuarioPorEmail(email) {
      return (await db.query('select email, nombre, rol, activo, clave_hash, debe_cambiar_clave from usuarios where email=$1', [email])).rows[0] || null;
    },
    /** Alta explícita por un admin. Devuelve null si ya existe. */
    async crearUsuario({ email, nombre, rol, claveHash, debeCambiar, creadoPor }) {
      return (
        (
          await db.query(
            `insert into usuarios (email, nombre, rol, clave_hash, debe_cambiar_clave, creado_por) values ($1,$2,$3,$4,$5,$6)
             on conflict (email) do nothing returning email, nombre, rol, activo`,
            [email, nombre, rol, claveHash, debeCambiar, creadoPor],
          )
        ).rows[0] || null
      );
    },
    async fijarActivo(email, activo) {
      return (await db.query('update usuarios set activo=$2 where email=$1', [email, activo])).rowCount > 0;
    },
    async fijarClave(email, claveHash, debeCambiar) {
      return (
        (await db.query('update usuarios set clave_hash=$2, debe_cambiar_clave=$3 where email=$1 and clave_hash is not null', [email, claveHash, debeCambiar]))
          .rowCount > 0
      );
    },
    async eliminarUsuario(email) {
      return (await db.query('delete from usuarios where email=$1', [email])).rowCount > 0;
    },
    /** Último acceso de una cuenta local, como mucho una vez por minuto (no escribe en cada petición). */
    async marcarAcceso(email) {
      await db.query("update usuarios set ultimo_acceso=now() where email=$1 and (ultimo_acceso is null or ultimo_acceso < now() - interval '1 minute')", [
        email,
      ]);
    },
    async asignarRol(email, rol) {
      await db.query('insert into usuarios (email, rol) values ($1,$2) on conflict (email) do update set rol = excluded.rol', [email, rol]);
    },
    /** Alta o actualización al iniciar sesión; devuelve el rol asignado en la base (o null). */
    async registrarLogin({ email, nombre }) {
      return (
        await db.query(
          `insert into usuarios (email, nombre, ultimo_acceso) values ($1,$2,now())
         on conflict (email) do update set nombre = excluded.nombre, ultimo_acceso = now() returning rol, activo`,
          [email, nombre],
        )
      ).rows[0];
    },
    /** Últimas 200 filas; con `pool` y/o `cidr`, solo las de ese pool o segmento (para el historial de la ficha). */
    async listarAuditoria({ pool, cidr } = {}) {
      return (
        await db.query(
          `select id, ts, usuario, rol, accion, detalle, ip, request_id from auditoria
            where ($1::text is null or coalesce(detalle->>'pool', detalle->>'pool_id') = $1)
              and ($2::text is null or detalle->>'cidr' = $2)
            order by id desc limit 200`,
          [pool || null, cidr || null],
        )
      ).rows;
    },
    async registrarAuditoria({ usuario, rol, accion, detalle, ip, requestId }) {
      await db.query('insert into auditoria (usuario, rol, accion, detalle, ip, request_id) values ($1,$2,$3,$4,$5,$6)', [
        usuario,
        rol,
        accion,
        detalle,
        ip,
        requestId || null,
      ]);
    },
    // ---------- Tokens de servicio ----------
    async insertarToken({ nombre, prefijo, hash, rol, cuota, creadoPor, dias }) {
      return (
        await db
          .query(
            `with t as (
           insert into tokens_servicio (nombre, prefijo, hash, rol, cuota_reservas, creado_por, expira_en)
           values ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7::int)) returning *)
         select ${COLUMNAS_TOKEN} from t`,
            [nombre, prefijo, hash, rol, cuota, creadoPor, dias],
          )
          .catch((e) => {
            throw traducir(e);
          })
      ).rows[0];
    },
    async listarTokens() {
      return (await db.query(`select ${COLUMNAS_TOKEN} from tokens_servicio order by creado_en desc, nombre`)).rows;
    },
    async tokenPorHash(hash) {
      return (await db.query(`select ${COLUMNAS_TOKEN} from tokens_servicio where hash = $1`, [hash])).rows[0] || null;
    },
    async revocarToken(id) {
      return (
        (
          await db.query(
            `with t as (update tokens_servicio set revocado_en = coalesce(revocado_en, now()) where id = $1 returning *) select ${COLUMNAS_TOKEN} from t`,
            [id],
          )
        ).rows[0] || null
      );
    },
    /** Como máximo una vez por minuto (lo decide la base con una sola sentencia atómica). */
    async tocarUltimoUso(id) {
      await db.query("update tokens_servicio set ultimo_uso = now() where id = $1 and (ultimo_uso is null or ultimo_uso < now() - interval '1 minute')", [id]);
    },
    /** Datos para las métricas, todos con el reloj de la base. */
    async estadisticas() {
      const r = (
        await db.query(
          `select (select count(*) from reservas where ${RESERVA_VIGENTE})::int as activas,
                (select count(*) from tokens_servicio where revocado_en is null and expira_en > now())::int as tokens_activos,
                (select count(*) from tokens_servicio where revocado_en is null and expira_en > now() and expira_en < now() + interval '7 days')::int as tokens_por_vencer,
                (select coalesce(extract(epoch from ultima_ejecucion), 0) from barredor_estado where id = 1)::float8 as barredor`,
        )
      ).rows[0];
      const porEstado = {};
      for (const f of (await db.query(`select ${ESTADO_EFECTIVO} as estado, count(*)::int as n from reservas group by 1`)).rows) porEstado[f.estado] = f.n;
      const pools = (
        await db.query(
          `select p.id, ((a.tam + r.tam) / (2^(32-masklen(p.cidr)))::float8) as ratio
           from pools p
           left join lateral (select coalesce(sum(2^(32-masklen(cidr))),0)::float8 as tam from asignaciones where pool_id = p.id) a on true
           left join lateral (select coalesce(sum(2^(32-masklen(cidr))),0)::float8 as tam from reservas where pool_id = p.id and ${RESERVA_VIGENTE}) r on true
          order by p.id`,
        )
      ).rows;
      return {
        reservas: { activas: r.activas, porEstado },
        tokens: { activos: r.tokens_activos, porVencer: r.tokens_por_vencer },
        barredor: r.barredor,
        pools,
      };
    },
    async listarEventos() {
      return (await db.query('select id, ts, tipo, detalle from eventos order by id desc limit 50')).rows;
    },
    async registrarEvento(tipo, detalle) {
      await db.query('insert into eventos (tipo, detalle) values ($1,$2)', [tipo, detalle]);
    },
  };
}

/** @param {import('pg').Pool} db */
function crearRepositorio(db) {
  const base = consultas(db);

  async function transaccion(fn) {
    return reintentar(
      async () => {
        const cl = await db.connect();
        let roto;
        try {
          await cl.query('begin');
          const r = await fn(crearTx(cl));
          await cl.query('commit');
          return r;
        } catch (e) {
          roto = await cl.query('rollback').then(
            () => undefined,
            (er) => er,
          ); // si el rollback falla, la conexión se descarta
          throw traducir(e);
        } finally {
          cl.release(roto);
        }
      },
      { intentos: 3, baseMs: 50, transitorio: (e) => e && (e.code === '40001' || e.code === '40P01') },
    );
  }

  function crearTx(cl) {
    const c = consultas(cl);
    const q = (texto, params) => cl.query(texto, params);
    return {
      ...c,
      consultar: q,
      // Bloqueo de transacción por clave: serializa las operaciones sobre un mismo pool (se libera solo al terminar).
      async bloquear(clave) {
        await q('select pg_advisory_xact_lock(hashtext($1))', [clave]);
      },
      async insertarPoolSiNoExiste(p) {
        return (
          await q('insert into pools (id,tipo,ambiente,proveedor,cidr) values ($1,$2,$3,$4,$5) on conflict (id) do nothing', [
            p.id,
            p.tipo,
            p.ambiente,
            p.proveedor,
            p.cidr,
          ])
        ).rowCount;
      },
      async insertarAsignacionImportada(a) {
        const x = await q(
          `insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen,creado_en,vlan,vlan_nombre)
           select $1,$2::cidr,$3,$4,$5,$6,coalesce($7::timestamptz,now()),$8,$9
            where not exists (select 1 from asignaciones where pool_id=$1 and cidr=$2::cidr)`,
          [a.pool_id, a.cidr, a.vpc, a.solicitante || 'importado', a.ticket, a.origen, a.creado_en || null, a.vlan ?? null, a.vlan_nombre ?? null],
        );
        return x.rowCount;
      },
      async insertarUsuarioSiNoExiste(u) {
        return (
          await q('insert into usuarios (email,nombre,rol) values ($1,$2,$3) on conflict (email) do nothing', [
            String(u.email).toLowerCase(),
            u.nombre || '',
            u.rol,
          ])
        ).rowCount;
      },
      /** Borra contadores de minutos ya pasados (el límite solo mira el minuto actual y el anterior). */
      async purgarLimite() {
        return (await q('delete from limite_contador where ventana < (extract(epoch from now())::bigint / 60) - 3')).rowCount;
      },
      async ajustarSecuenciaTicket() {
        await q(
          "select setval('ticket_seq', greatest((select last_value from ticket_seq), coalesce((select max(substring(ticket from 5)::int) from asignaciones where ticket ~ '^NET-[0-9]+$'),0)))",
        );
      },
    };
  }

  /**
   * Ejecuta `fn` solo si esta réplica obtiene el advisory lock del barredor y nadie lo ejecutó hace poco.
   * El lock es de transacción (pg_try_advisory_xact_lock): se libera solo y funciona tras un pooler en modo sesión.
   */
  async function conBarredor({ minimoMs, instancia }, fn) {
    return transaccion(async (tx) => {
      const lock = (await tx.consultar("select pg_try_advisory_xact_lock(hashtext('ipam:barredor')) as ok")).rows[0].ok;
      if (!lock) return { ejecutado: false, motivo: 'otra_instancia' };
      // «Hace poco» se mide con el reloj de la base: todas las réplicas coinciden.
      const reciente = (
        await tx.consultar(
          'select coalesce(ultima_ejecucion > now() - make_interval(secs => $1::float8 / 1000), false) as r from barredor_estado where id = 1',
          [minimoMs],
        )
      ).rows[0];
      if (reciente && reciente.r) return { ejecutado: false, motivo: 'reciente' };
      const inicio = Date.now();
      const resultado = await fn(tx);
      await tx.consultar('update barredor_estado set ultima_ejecucion = now(), duracion_ms = $1, instancia = $2 where id = 1', [
        Date.now() - inicio,
        instancia,
      ]);
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
      return (await db.query('delete from asignaciones where id=$1 returning id, codigo, cidr::text, ticket, pool_id', [id])).rows[0] || null;
    },
    async poolsConUso({ ambiente, tipo } = {}) {
      return (
        await db.query(
          `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, a.n::int as asignaciones, a.tam / (2^(32-masklen(p.cidr)))::float8 as uso,
                r.n::int as reservas_vigentes, r.tam / (2^(32-masklen(p.cidr)))::float8 as uso_reservado
           from pools p
           left join lateral (select count(*) as n, coalesce(sum(2^(32-masklen(cidr))),0)::float8 as tam from asignaciones where pool_id = p.id) a on true
           left join lateral (select count(*) as n, coalesce(sum(2^(32-masklen(cidr))),0)::float8 as tam from reservas where pool_id = p.id and ${RESERVA_VIGENTE}) r on true
          where ($1::text is null or p.ambiente = $1) and ($2::text is null or p.tipo = $2)
          order by p.ambiente desc, p.id`,
          [ambiente || null, tipo || null],
        )
      ).rows;
    },
    async resumen() {
      return (
        await db.query(
          `select (select count(*) from pools)::int as pools, (select count(*) from asignaciones)::int as asignaciones,
                (select coalesce(avg(u),0) from (select ${USO_POOL} as u from pools p left join asignaciones a on a.pool_id=p.id group by p.id) x)::float8 as uso_promedio`,
        )
      ).rows[0];
    },
    async listarAsignaciones() {
      return (await db.query(`select ${COLUMNAS_ASIGNACION} from asignaciones order by id desc`)).rows;
    },
    async asignacionesParaExcel() {
      const filas = (
        await db.query(
          `select a.id, a.codigo, a.pool_id, p.tipo, p.ambiente, p.proveedor, p.cidr::text as pool_cidr, a.cidr::text, a.vpc,
                a.vlan, a.vlan_nombre, a.solicitante, a.ticket, a.origen, a.creado_en
           from asignaciones a join pools p on p.id = a.pool_id order by p.ambiente desc, a.pool_id, a.cidr`,
        )
      ).rows;
      const pools = (
        await db.query(
          `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones, ${USO_POOL} as uso
           from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`,
        )
      ).rows;
      return { filas, pools };
    },
    async exportarDatos() {
      const pools = (await db.query('select id, tipo, ambiente, proveedor, cidr::text from pools order by id')).rows;
      const asignaciones = (
        await db.query('select pool_id, cidr::text, vpc, vlan, vlan_nombre, solicitante, ticket, origen, creado_en from asignaciones order by pool_id, cidr')
      ).rows;
      const usuarios = (await db.query('select email, nombre, rol from usuarios where rol is not null order by email')).rows;
      return { pools, asignaciones, usuarios };
    },
    ...consultasDeAdministracion(db),
  };
}

module.exports = { crearRepositorio, consultas, traducir, COLUMNAS_ASIGNACION, USO_POOL, ESTADO_EFECTIVO, RESERVA_VIGENTE };
