// @ts-check
'use strict';
const { parse, libres } = require('../dominio/cidr');
const R = require('../dominio/reserva');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIN_CONTROL = /^[^\u0000-\u001f\u007f]{1,120}$/;

/** Lo que ve el cliente de una reserva (sin la clave de idempotencia, que es privada de quien la usó). */
const presentar = (r) => ({
  id: r.id, pool_id: r.pool_id, cidr: r.cidr, vpc: r.vpc, solicitante: r.solicitante, ticket: r.ticket, estado: r.estado,
  creado_en: r.creado_en, expira_en: r.expira_en, resuelto_en: r.resuelto_en, asignacion_id: r.asignacion_id, segundos_restantes: r.segundos_restantes,
});

/**
 * Reservas tentativas: el agente pide un rango, queda apartado un tiempo (TTL) y solo se vuelve asignación definitiva si
 * alguien lo confirma. Sin confirmar, expira solo. La expiración perezosa (al consultar, con el reloj de la base) garantiza
 * la corrección; el barredor solo limpia.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, config: any}} deps
 */
function crearReservas({ repo, eventos, config }) {
  const publicarExpiradas = async (lista) => {
    for (const e of lista || []) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
  };

  /** Valida y normaliza la petición sin tocar la base. */
  function normalizar(e, claveHeader) {
    const malo = (error, mensaje) => fallo('validacion', error, { mensaje });
    if (typeof e.vpc !== 'string' || !SIN_CONTROL.test(e.vpc.trim())) return malo('vpc_invalido', 'Indica el proyecto / VPC (hasta 120 caracteres).');
    const pool = e.pool === undefined || e.pool === null || e.pool === '' ? null : String(e.pool);
    if (pool && pool.length > 100) return malo('pool_invalido', 'El nombre del pool es demasiado largo.');
    let ambiente = null, tipo = null;
    if (!pool) {
      if (!AMBIENTES.includes(e.ambiente) || typeof e.tipo !== 'string' || !e.tipo.trim()) {
        return malo('falta_destino', 'Indica el pool, o bien ambiente (dev, qa, pre o prod) y tipo (p. ej. Nodos, Pods, Servicios).');
      }
      ambiente = e.ambiente; tipo = e.tipo.trim();
    }
    let cidr = null, mascara = null;
    if (e.cidr !== undefined && e.cidr !== null && e.cidr !== '') {
      const c = parse(String(e.cidr));
      if (!c) return malo('cidr_invalido', 'CIDR inválido. Formato: 10.210.16.0/22.');
      if (!c.aligned) return malo('cidr_desalineado', `${e.cidr} no está alineado: la dirección de red debe ser múltiplo de su tamaño.`);
      cidr = String(e.cidr).trim();
      if (e.mascara !== undefined && e.mascara !== null && Number(e.mascara) !== c.len) return malo('mascara_no_coincide', 'mascara y cidr no coinciden; indica solo uno.');
    } else if (e.mascara !== undefined && e.mascara !== null && e.mascara !== '') {
      mascara = Number(e.mascara);
      if (!Number.isInteger(mascara) || mascara < 8 || mascara > 32) return malo('mascara_invalida', 'mascara debe ser un entero entre 8 y 32.');
    } else return malo('falta_tamano', 'Indica mascara (tamaño del bloque) o cidr (rango exacto).');
    const ttl = R.validarTtl(e.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
    if (!ttl.ok) return malo(ttl.error, ttl.mensaje);
    const t = R.validarTicket(e.ticket);
    if (!t.ok) return malo(t.error, t.mensaje);
    const k = R.validarClaveIdem(claveHeader);
    if (!k.ok) return malo(k.error, k.mensaje);
    return ok({ datos: { pool, ambiente, tipo, cidr, mascara, vpc: e.vpc.trim(), ticket: t.ticket, ttlHoras: ttl.horas, clave: k.clave } });
  }

  /** Reserva un rango. Idempotente con Idempotency-Key. */
  async function reservar(actor, entrada, claveHeader) {
    const n = normalizar(entrada || {}, claveHeader);
    if (!n.ok) return n;
    const d = n.datos;

    let p;
    if (d.pool) {
      p = await repo.obtenerPool(d.pool);
      if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool «${d.pool}» no existe.` });
    } else {
      const candidatos = await repo.buscarPools({ ambiente: d.ambiente, tipo: d.tipo });
      const r = R.resolverPool(candidatos);
      if (r.tipo !== 'unico') {
        return fallo('ambiguo', r.tipo === 'ninguno' ? 'sin_pool' : 'ambiguo', {
          mensaje: r.tipo === 'ninguno' ? `No hay pools de tipo ${d.tipo} en ${d.ambiente}.` : `Hay ${candidatos.length} pools de tipo ${d.tipo} en ${d.ambiente}: indica cuál con «pool».`,
          opciones: candidatos.map((c) => ({ pool: c.id, cidr: c.cidr, tipo: c.tipo, ambiente: c.ambiente, proveedor: c.proveedor })),
        });
      }
      p = r.pool;
    }
    const base = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(p.cidr));
    if (d.cidr) {
      const c = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(d.cidr));
      if (c.start < base.start || c.end > base.end) return fallo('validacion', 'cidr_fuera_del_pool', { mensaje: `${d.cidr} queda fuera del pool ${p.id} (${p.cidr}).` });
    } else if (d.mascara < base.len) return fallo('validacion', 'mascara_invalida', { mensaje: `La máscara /${d.mascara} es más grande que el pool ${p.id} (${p.cidr}).` });

    let r;
    try {
      r = await repo.transaccion(async (tx) => {
        // Todo lo de un mismo solicitante se serializa (idempotencia y cuota); luego se serializa por pool. Orden fijo: actor → pool.
        await tx.bloquear(`actor:${actor.nombre}`);
        if (d.clave) {
          const ex = await tx.reservaPorClave(actor.nombre, d.clave);
          if (ex) {
            if (R.decidirIdempotencia(ex.estado) === 'rechazar') {
              return fallo('conflicto', 'clave_idem_usada', { estado: ex.estado, mensaje: `Esa Idempotency-Key ya se usó para una reserva que está ${ex.estado}. Usa una clave nueva para pedir otra.` });
            }
            if (!R.mismaPeticion(ex, { pool: d.pool, cidr: d.cidr, vpc: d.vpc })) {
              return fallo('conflicto', 'idempotencia_conflicto', { mensaje: 'Esa Idempotency-Key ya se usó con otros parámetros. Usa una clave nueva o repite la misma petición.' });
            }
            return ok({ reserva: ex, repetida: true });
          }
        }
        if (actor.tipo === 'token') {
          const limite = actor.cuota || config.limite.cuotaReservasPorToken;
          const vigentes = await tx.contarVigentesDe(actor.nombre);
          if (vigentes >= limite) {
            return fallo('cuota', 'cuota_excedida', { vigentes, limite, mensaje: `Tienes ${vigentes} reservas vigentes de ${limite} permitidas. Confirma o libera alguna antes de pedir otra.` });
          }
        }
        await tx.bloquear(`pool:${p.id}`);
        const expiradas = await tx.expirarVencidas(p.id); // limpia lo vencido de ESTE pool antes de calcular qué queda libre
        const ocup = await tx.ocupados(p.id);
        const objetivo = d.cidr || libres(p.cidr, ocup, d.mascara, 1)[0];
        if (!objetivo) return { ...fallo('conflicto', 'sin_espacio', { mensaje: `No quedan segmentos /${d.mascara} libres en ${p.id}.` }), expiradas };
        const c = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(objetivo));
        const x = await tx.conflicto(p.id, objetivo);
        if (x) return { ...fallo('conflicto', 'solapamiento', { mensaje: `${objetivo} se solapa con un rango ya ${x.fuente === 'reserva' ? 'reservado' : 'asignado'}.`, conflicto: x, sugeridos: libres(p.cidr, ocup, c.len, 3) }), expiradas };
        const ticket = d.ticket || (await tx.siguienteTicket());
        const reserva = await tx.insertarReserva({ pool: p.id, cidr: objetivo, vpc: d.vpc, solicitante: actor.nombre, ticket, ttlHoras: d.ttlHoras, clave: d.clave });
        return ok({ reserva, repetida: false, expiradas });
      });
    } catch (e) {
      if (e instanceof ConflictoDeDatos && e.codigo === '23505') return fallo('conflicto', 'clave_idem_usada', { mensaje: 'Esa Idempotency-Key se está usando en otra petición simultánea; reintenta.' });
      if (e instanceof ConflictoDeDatos) return fallo('conflicto', 'solapamiento', { mensaje: 'El rango se solapa con otro (detectado por la base de datos).' });
      throw e;
    }
    await publicarExpiradas(r.expiradas);
    if (!r.ok) return r;
    if (!r.repetida) await eventos.publicar('reserva_creada', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, solicitante: actor.nombre, ticket: r.reserva.ticket, expira_en: r.reserva.expira_en });
    return ok({ reserva: presentar(r.reserva), repetida: r.repetida });
  }

  /** Busca la reserva y comprueba que quien opera sea el dueño o un admin. */
  async function paraOperar(actor, id) {
    if (!UUID.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    const previa = await repo.reservaPorId(id);
    if (!previa) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    if (!R.puedeOperar(actor, previa)) return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó la reserva (o un admin) puede operar sobre ella.' });
    return ok({ previa });
  }

  /** Convierte la reserva en asignación definitiva (origen «agente»). Idempotente. */
  async function confirmar(actor, id, cuerpo) {
    const ap = R.validarAprobacion(cuerpo, actor.tipo === 'token' && config.reservas.exigeAprobador);
    if (!ap.ok) return fallo('validacion', ap.error, { mensaje: ap.mensaje });
    const o = await paraOperar(actor, id);
    if (!o.ok) return o;
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`pool:${o.previa.pool_id}`);
      const actual = await tx.reservaPorId(id, { bloquear: true });
      if (!actual) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
      const dec = R.decidirConfirmacion(actual.estado);
      if (dec.accion === 'repetida') return ok({ reserva: actual, asignacion: await tx.asignacionPorId(actual.asignacion_id), repetida: true });
      if (dec.accion === 'rechazar') {
        const expiradas = actual.estado_registrado === 'reservada' ? [await tx.marcarExpirada(id)] : [];
        return { ...fallo('conflicto', 'reserva_no_vigente', { estado: dec.estado, mensaje: `La reserva está ${dec.estado}: ya no se puede confirmar. Pide una nueva.` }), expiradas };
      }
      const asignacion = await tx.insertarAsignacionDeReserva(actual);
      const reserva = await tx.marcarConfirmada(id, asignacion.id);
      return ok({ reserva, asignacion, repetida: false });
    });
    await publicarExpiradas(r.expiradas);
    if (!r.ok) return r;
    if (!r.repetida) await eventos.publicar('reserva_confirmada', { reserva: id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, ticket: r.reserva.ticket, aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia });
    return ok({ reserva: presentar(r.reserva), asignacion: r.asignacion, repetida: r.repetida, aprobacion: { aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia } });
  }

  /** Libera la reserva; si ya estaba confirmada, borra también la asignación. Idempotente. */
  async function liberar(actor, id) {
    const o = await paraOperar(actor, id);
    if (!o.ok) return o;
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`pool:${o.previa.pool_id}`);
      const actual = await tx.reservaPorId(id, { bloquear: true });
      if (!actual) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
      const dec = R.decidirLiberacion(actual.estado);
      if (dec.accion === 'repetida') return ok({ reserva: actual, repetida: true, asignacionBorrada: false });
      let borrada = false;
      if (dec.accion === 'borrar_asignacion' && actual.asignacion_id) borrada = await tx.borrarAsignacion(actual.asignacion_id);
      return ok({ reserva: await tx.marcarLiberada(id), repetida: false, asignacionBorrada: borrada });
    });
    if (!r.ok) return r;
    if (!r.repetida) await eventos.publicar('reserva_liberada', { reserva: id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, asignacion_borrada: r.asignacionBorrada });
    return ok({ reserva: presentar(r.reserva), repetida: r.repetida, asignacionBorrada: r.asignacionBorrada });
  }

  async function obtener(id) {
    if (!UUID.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    const r = await repo.reservaPorId(id);
    return r ? ok({ reserva: presentar(r) }) : fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
  }

  async function listar({ estado, pool, solicitante, limite } = {}) {
    if (estado && !R.ESTADOS.includes(estado)) return fallo('validacion', 'estado_invalido', { mensaje: `estado debe ser uno de: ${R.ESTADOS.join(', ')}.` });
    const max = Math.min(Math.max(Number(limite) || 200, 1), 500);
    const filas = await repo.listarReservas({ estado: estado || null, pool: pool || null, solicitante: solicitante || null, limite: max });
    return ok({ reservas: filas.map(presentar) });
  }

  return { reservar, confirmar, liberar, obtener, listar, normalizar };
}

module.exports = { crearReservas, presentar };
