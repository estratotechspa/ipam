'use strict';
// Repositorio PostgreSQL. SOLO consultas parametrizadas ($1, $2…): nada de texto concatenado (lo vigila una regla de lint).
// El IPAM es dueño de sus tablas: ningún otro servicio debe leerlas ni escribirlas; se integran por la API.
const { ConflictoDeDatos } = require('../../../aplicacion/resultado');
const { reintentar } = require('./resiliencia');
const { SOLICITANTE_JIRA } = require('../../../dominio/reserva');
const { USO_POOL, COLUMNAS_DIRECCION } = require('./sql-comun');
const { consultasDeExportacion } = require('./exportacion');

const COLUMNAS_ASIGNACION = 'id, codigo, pool_id, cidr::text, vpc, vlan, vlan_nombre, solicitante, ticket, origen, creado_en';

// Lista de asignaciones con alias de tabla (se une con pools para filtrar por ambiente).
const COLUMNAS_ASIGNACION_A = 'a.id, a.codigo, a.pool_id, a.cidr::text, a.vpc, a.vlan, a.vlan_nombre, a.solicitante, a.ticket, a.origen, a.creado_en';
// Lista blanca de órdenes admitidos: la API nunca arma el ORDER BY con texto del cliente.
const ORDEN_ASIGNACIONES = {
  fecha: 'a.id',
  cidr: 'a.cidr',
  pool: 'a.pool_id',
  vpc: 'a.vpc',
  solicitante: 'a.solicitante',
  ticket: 'a.ticket',
  origen: 'a.origen',
  codigo: 'a.id',
  direcciones: '(32 - masklen(a.cidr))',
};

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

/** Direcciones IP fijas (interfaces, gateways, VIP…). `q` = pool o cliente de una transacción. */
function consultasDeDirecciones(q) {
  return {
    async asignacionesQueContienen(ip) {
      return (await q('select id, codigo, pool_id, cidr::text, vpc from asignaciones where cidr >>= $1::inet order by pool_id', [ip])).rows;
    },
    async poolsQueContienen(ip) {
      return (await q('select id, cidr::text from pools where cidr >>= $1::inet order by masklen(cidr) desc, id', [ip])).rows;
    },
    async direccionEn(poolId, ip) {
      return (
        (await q(`select ${COLUMNAS_DIRECCION} from direcciones_ip d where coalesce(d.pool_id, '') = coalesce($1, '') and d.ip = $2::inet`, [poolId, ip]))
          .rows[0] || null
      );
    },
    async direccionPorId(id) {
      return (await q(`select ${COLUMNAS_DIRECCION} from direcciones_ip d where d.id = $1`, [id])).rows[0] || null;
    },
    async insertarDireccion(d) {
      return (
        await q(
          `with n as (insert into direcciones_ip (ip, pool_id, asignacion_id, dispositivo, interfaz, rol, dns, descripcion, excepcion, creado_por)
             values ($1::inet, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *)
           select ${COLUMNAS_DIRECCION} from n d`,
          [d.ip, d.pool_id, d.asignacion_id, d.dispositivo, d.interfaz, d.rol, d.dns, d.descripcion, d.excepcion, d.creado_por],
        )
      ).rows[0];
    },
    async actualizarDireccion(id, d) {
      return (
        await q(
          `with n as (update direcciones_ip set dispositivo=$2, interfaz=$3, rol=$4, dns=$5, descripcion=$6, excepcion=$7 where id=$1 returning *)
           select ${COLUMNAS_DIRECCION} from n d`,
          [id, d.dispositivo, d.interfaz, d.rol, d.dns, d.descripcion, d.excepcion],
        )
      ).rows[0];
    },
    async eliminarDireccion(id) {
      return (await q(`with n as (delete from direcciones_ip where id=$1 returning *) select ${COLUMNAS_DIRECCION} from n d`, [id])).rows[0] || null;
    },
    /** Con filtros opcionales: segmento (`asignacion`), pool y texto libre (IP, equipo, interfaz, DNS, descripción). */
    async listarDirecciones({ asignacion, pool, q: texto } = {}) {
      return (
        await q(
          `select ${COLUMNAS_DIRECCION}, a.codigo as segmento_codigo, a.cidr::text as segmento
             from direcciones_ip d left join asignaciones a on a.id = d.asignacion_id
            where ($1::bigint is null or d.asignacion_id = $1)
              and ($2::text is null or d.pool_id = $2)
              and ($3::text is null or concat_ws(' ', host(d.ip), d.dispositivo, d.interfaz, d.dns, d.descripcion, d.excepcion, a.codigo) ilike '%' || $3 || '%')
            order by d.pool_id nulls last, d.ip limit 2000`,
          [asignacion || null, pool || null, texto || null],
        )
      ).rows;
    },
    /** Restaura una IP fija: la enlaza con su segmento por pool + CIDR. No duplica (índice único por pool e IP). */
    async insertarDireccionImportada(d) {
      const seg = d.segmento ? (await q('select id from asignaciones where pool_id = $1 and cidr = $2::cidr', [d.pool_id, d.segmento])).rows[0] : null;
      if (d.segmento && !seg) return 0;
      return (
        await q(
          `insert into direcciones_ip (ip, pool_id, asignacion_id, dispositivo, interfaz, rol, dns, descripcion, excepcion, creado_por, creado_en)
           values ($1::inet, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now())) on conflict do nothing`,
          [
            d.ip,
            d.pool_id || null,
            seg ? seg.id : null,
            d.dispositivo,
            d.interfaz,
            d.rol,
            d.dns,
            d.descripcion,
            seg ? null : d.excepcion || 'restaurada sin segmento',
            d.creado_por || 'importado',
            d.creado_en || null,
          ],
        )
      ).rowCount;
    },
    async contarDireccionesDe(asignacionId) {
      return (await q('select count(*)::int as n from direcciones_ip where asignacion_id = $1', [asignacionId])).rows[0].n;
    },
  };
}

/** Todo lo que va en el respaldo lógico (pools, asignaciones, roles e IPs fijas). */
async function exportarDatos(db) {
  const pools = (await db.query('select id, tipo, ambiente, proveedor, cidr::text from pools order by id')).rows;
  const asignaciones = (
    await db.query('select pool_id, cidr::text, vpc, vlan, vlan_nombre, solicitante, ticket, origen, creado_en from asignaciones order by pool_id, cidr')
  ).rows;
  const usuarios = (await db.query('select email, nombre, rol from usuarios where rol is not null order by email')).rows;
  const direcciones = (
    await db.query(
      `select host(d.ip) as ip, d.pool_id, a.cidr::text as segmento, d.dispositivo, d.interfaz, d.rol, d.dns, d.descripcion, d.excepcion,
                d.creado_por, d.creado_en
           from direcciones_ip d left join asignaciones a on a.id = d.asignacion_id order by d.pool_id nulls last, d.ip`,
    )
  ).rows;
  return { pools, asignaciones, usuarios, direcciones };
}

/** Edición y baja de pools (dentro de una transacción). */
function consultasDePools(q) {
  return {
    async actualizarPool(id, { tipo, proveedor }) {
      return (await q('update pools set tipo=$2, proveedor=$3 where id=$1 returning id, tipo, ambiente, proveedor, cidr::text', [id, tipo, proveedor])).rows[0];
    },
    /** Qué impide borrar un pool. */
    async usoDePool(id) {
      return (
        await q(
          `select (select count(*) from asignaciones where pool_id=$1)::int as asignaciones,
                  (select count(*) from reservas where pool_id=$1 and ${RESERVA_VIGENTE})::int as reservas_vigentes,
                  (select count(*) from direcciones_ip where pool_id=$1)::int as direcciones`,
          [id],
        )
      ).rows[0];
    },
    /** Borra un pool vacío y su historial de reservas ya resueltas (expiradas o liberadas; las confirmadas no existen sin asignación). */
    async eliminarPool(id) {
      await q('delete from reservas where pool_id=$1', [id]);
      return (await q('delete from pools where id=$1', [id])).rowCount;
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
      ...consultasDePools(q),
      ...consultasDeDirecciones(q),
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
    ...consultasDeDirecciones((texto, params) => db.query(texto, params)),
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
    /**
     * Asignaciones paginadas, con filtros opcionales por pool, ambiente y texto (CIDR, ID, proyecto/VPC, solicitante o ticket) y orden
     * por una columna de la lista blanca ORDEN_ASIGNACIONES. Devuelve { filas, total } (total = sin paginar, para el encabezado
     * X-Total-Count). Lo único que se concatena son fragmentos FIJOS de esa lista y marcadores $n: nada de lo que envía el cliente.
     */
    async listarAsignaciones({ pool, ambiente, q: texto, orden = 'fecha', dir, limit = 1000, offset = 0 } = {}) {
      const donde = [];
      const par = [];
      const agregar = (valor, condicion) => {
        par.push(valor);
        donde.push(condicion.replaceAll('$$', `$${par.length}`));
      };
      if (pool) agregar(pool, 'a.pool_id = $$');
      if (ambiente) agregar(ambiente, 'p.ambiente = $$');
      if (texto)
        agregar(
          `%${texto.replace(/[\\%_]/g, '\\$&')}%`,
          '(a.cidr::text ilike $$ or a.codigo ilike $$ or a.vpc ilike $$ or a.solicitante ilike $$ or a.ticket ilike $$)',
        );
      const desde = `from asignaciones a join pools p on p.id = a.pool_id ${donde.length ? 'where ' + donde.join(' and ') : ''}`;
      const sentido = (dir || (orden === 'fecha' ? 'desc' : 'asc')) === 'asc' ? 'asc' : 'desc';
      const sqlTotal = `select count(*)::int as n ${desde}`; // solo fragmentos fijos y marcadores $n (ver arriba)
      const total = (await db.query(sqlTotal, par)).rows[0].n;
      const sql = `select ${COLUMNAS_ASIGNACION_A}, p.ambiente ${desde} order by ${ORDEN_ASIGNACIONES[orden] || ORDEN_ASIGNACIONES.fecha} ${sentido}, a.id ${sentido} limit $${par.length + 1} offset $${par.length + 2}`;
      return { filas: (await db.query(sql, [...par, limit, offset])).rows, total };
    },
    exportarDatos: () => exportarDatos(db),
    ...consultasDeAdministracion(db),
    ...consultasDeExportacion(db),
  };
}

module.exports = { crearRepositorio, consultas, traducir, ORDEN_ASIGNACIONES, COLUMNAS_ASIGNACION, USO_POOL, ESTADO_EFECTIVO, RESERVA_VIGENTE };
