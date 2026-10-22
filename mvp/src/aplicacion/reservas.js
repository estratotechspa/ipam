// @ts-check
'use strict';
const { parse, libres } = require('../dominio/cidr');
const R = require('../dominio/reserva');
const { validarVlan } = require('../dominio/vlan');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIN_CONTROL = /^[^\p{Cc}]{1,120}$/u; // sin caracteres de control

/** Lo que ve el cliente de una reserva (sin la clave de idempotencia, que es privada de quien la usó). */
const presentar = (r) => ({
  id: r.id,
  pool_id: r.pool_id,
  cidr: r.cidr,
  vpc: r.vpc,
  vlan: r.vlan ?? null,
  vlan_nombre: r.vlan_nombre ?? null,
  solicitante: r.solicitante,
  ticket: r.ticket,
  estado: r.estado,
  creado_en: r.creado_en,
  expira_en: r.expira_en,
  resuelto_en: r.resuelto_en,
  asignacion_id: r.asignacion_id,
  segundos_restantes: r.segundos_restantes,
});

const malo = (error, mensaje) => fallo('validacion', error, { mensaje });

/** Destino: un pool, o ambiente + tipo. */
function validarDestino(e) {
  const pool = e.pool === undefined || e.pool === null || e.pool === '' ? null : String(e.pool);
  if (pool && pool.length > 100) return malo('pool_invalido', 'El nombre del pool es demasiado largo.');
  if (pool) return ok({ pool, ambiente: null, tipo: null });
  if (!AMBIENTES.includes(e.ambiente) || typeof e.tipo !== 'string' || !e.tipo.trim()) {
    return malo('falta_destino', 'Indica el pool, o bien ambiente (dev, qa, pre o prod) y tipo (p. ej. Nodos, Pods, Servicios).');
  }
  return ok({ pool: null, ambiente: e.ambiente, tipo: e.tipo.trim() });
}

/** Tamaño: un CIDR exacto (alineado) o una máscara. */
function validarTamano(e) {
  const hayCidr = e.cidr !== undefined && e.cidr !== null && e.cidr !== '';
  const hayMascara = e.mascara !== undefined && e.mascara !== null && e.mascara !== '';
  if (hayCidr) {
    const c = parse(String(e.cidr));
    if (!c) return malo('cidr_invalido', 'CIDR inválido. Formato: 10.210.16.0/22.');
    if (!c.aligned) return malo('cidr_desalineado', `${e.cidr} no está alineado: la dirección de red debe ser múltiplo de su tamaño.`);
    if (hayMascara && Number(e.mascara) !== c.len) return malo('mascara_no_coincide', 'mascara y cidr no coinciden; indica solo uno.');
    return ok({ cidr: String(e.cidr).trim(), mascara: null });
  }
  if (!hayMascara) return malo('falta_tamano', 'Indica mascara (tamaño del bloque) o cidr (rango exacto).');
  const mascara = Number(e.mascara);
  if (!Number.isInteger(mascara) || mascara < 8 || mascara > 32) return malo('mascara_invalida', 'mascara debe ser un entero entre 8 y 32.');
  return ok({ cidr: null, mascara });
}

/** Valida y normaliza la petición sin tocar la base. */
function normalizarReserva(e, claveHeader, config) {
  if (typeof e.vpc !== 'string' || !SIN_CONTROL.test(e.vpc.trim())) return malo('vpc_invalido', 'Indica el proyecto / VPC (hasta 120 caracteres).');
  const destino = validarDestino(e);
  if (!destino.ok) return destino;
  const tamano = validarTamano(e);
  if (!tamano.ok) return tamano;
  const ttl = R.validarTtl(e.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
  if (!ttl.ok) return malo(ttl.error, ttl.mensaje);
  const t = R.validarTicket(e.ticket);
  if (!t.ok) return malo(t.error, t.mensaje);
  const k = R.validarClaveIdem(claveHeader);
  if (!k.ok) return malo(k.error, k.mensaje);
  const v = validarVlan(e);
  if (!v.ok) return malo(v.error, v.mensaje);
  const { pool, ambiente, tipo } = destino;
  const { cidr, mascara } = tamano;
  return ok({
    datos: {
      pool,
      ambiente,
      tipo,
      cidr,
      mascara,
      vpc: e.vpc.trim(),
      ticket: t.ticket,
      ttlHoras: ttl.horas,
      clave: k.clave,
      vlan: v.vlan,
      vlan_nombre: v.vlan_nombre,
    },
  });
}

/** Elige el pool (directo, o único por ambiente y tipo) y comprueba el tamaño pedido contra él. */
async function resolverDestino(repo, d) {
  let p;
  if (d.pool) {
    p = await repo.obtenerPool(d.pool);
    if (!p) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool «${d.pool}» no existe.` });
  } else {
    const candidatos = await repo.buscarPools({ ambiente: d.ambiente, tipo: d.tipo });
    const r = R.resolverPool(candidatos);
    if (r.tipo !== 'unico') {
      return fallo('ambiguo', r.tipo === 'ninguno' ? 'sin_pool' : 'ambiguo', {
        mensaje:
          r.tipo === 'ninguno'
            ? `No hay pools de tipo ${d.tipo} en ${d.ambiente}.`
            : `Hay ${candidatos.length} pools de tipo ${d.tipo} en ${d.ambiente}: indica cuál con «pool».`,
        opciones: candidatos.map((c) => ({ pool: c.id, cidr: c.cidr, tipo: c.tipo, ambiente: c.ambiente, proveedor: c.proveedor })),
      });
    }
    p = r.pool;
  }
  const base = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(p.cidr));
  if (d.cidr) {
    const c = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(d.cidr));
    if (c.start < base.start || c.end > base.end)
      return fallo('validacion', 'cidr_fuera_del_pool', { mensaje: `${d.cidr} queda fuera del pool ${p.id} (${p.cidr}).` });
  } else if (d.mascara < base.len) {
    return fallo('validacion', 'mascara_invalida', { mensaje: `La máscara /${d.mascara} es más grande que el pool ${p.id} (${p.cidr}).` });
  }
  return ok({ pool: p });
}

/** Idempotencia: ¿esta clave ya se usó? Devuelve la respuesta a dar, o null si es una petición nueva. */
async function revisarIdempotencia(tx, actor, d) {
  if (!d.clave) return null;
  const ex = await tx.reservaPorClave(actor.nombre, d.clave);
  if (!ex) return null;
  if (R.decidirIdempotencia(ex.estado) === 'rechazar') {
    return fallo('conflicto', 'clave_idem_usada', {
      estado: ex.estado,
      mensaje: `Esa Idempotency-Key ya se usó para una reserva que está ${ex.estado}. Usa una clave nueva para pedir otra.`,
    });
  }
  if (!R.mismaPeticion(ex, { pool: d.pool, cidr: d.cidr, vpc: d.vpc })) {
    return fallo('conflicto', 'idempotencia_conflicto', {
      mensaje: 'Esa Idempotency-Key ya se usó con otros parámetros. Usa una clave nueva o repite la misma petición.',
    });
  }
  return ok({ reserva: ex, repetida: true });
}

/** Cuota de reservas vigentes de un token. Devuelve el fallo si se excede, o null. */
async function revisarCuota(tx, actor, config) {
  if (actor.tipo !== 'token') return null;
  const limite = actor.cuota || config.limite.cuotaReservasPorToken;
  const vigentes = await tx.contarVigentesDe(actor.nombre);
  if (vigentes < limite) return null;
  return fallo('cuota', 'cuota_excedida', {
    vigentes,
    limite,
    mensaje: `Tienes ${vigentes} reservas vigentes de ${limite} permitidas. Confirma o libera alguna antes de pedir otra.`,
  });
}

/** El cuerpo de la transacción de reservar. Bloqueos en orden fijo (actor → pool) para no producir interbloqueos. */
async function reservarEnTransaccion(tx, { actor, d, p, config }) {
  await tx.bloquear(`actor:${actor.nombre}`); // todo lo de un mismo solicitante se serializa (idempotencia y cuota)
  const repetida = await revisarIdempotencia(tx, actor, d);
  if (repetida) return repetida;
  const sinCuota = await revisarCuota(tx, actor, config);
  if (sinCuota) return sinCuota;
  await tx.bloquear(`pool:${p.id}`);
  const expiradas = await tx.expirarVencidas(p.id); // limpia lo vencido de ESTE pool antes de calcular qué queda libre
  const ocup = await tx.ocupados(p.id);
  const objetivo = d.cidr || libres(p.cidr, ocup, d.mascara, 1)[0];
  if (!objetivo) return { ...fallo('conflicto', 'sin_espacio', { mensaje: `No quedan segmentos /${d.mascara} libres en ${p.id}.` }), expiradas };
  const c = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(objetivo));
  const x = await tx.conflicto(p.id, objetivo);
  if (x) {
    return {
      ...fallo('conflicto', 'solapamiento', {
        mensaje: `${objetivo} se solapa con un rango ya ${x.fuente === 'reserva' ? 'reservado' : 'asignado'}.`,
        conflicto: x,
        sugeridos: libres(p.cidr, ocup, c.len, 3),
      }),
      expiradas,
    };
  }
  const ticket = d.ticket || (await tx.siguienteTicket());
  const reserva = await tx.insertarReserva({
    pool: p.id,
    cidr: objetivo,
    vpc: d.vpc,
    solicitante: actor.nombre,
    ticket,
    ttlHoras: d.ttlHoras,
    clave: d.clave,
    vlan: d.vlan,
    vlan_nombre: d.vlan_nombre,
  });
  return ok({ reserva, repetida: false, expiradas });
}

/**
 * Reservas tentativas: el agente pide un rango, queda apartado un tiempo (TTL) y solo se vuelve asignación definitiva si
 * alguien lo confirma. Sin confirmar, expira solo. La expiración perezosa (al consultar, con el reloj de la base) garantiza
 * la corrección; el barredor solo limpia.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, config: any, alConfirmar?: (actor: any, reserva: any, asignacion: any, aprobacion: {aprobado_por: string, referencia?: string | null}) => Promise<void>}} deps
 */
function crearReservas({ repo, eventos, config, alConfirmar }) {
  /** @param {Array<{id: string, cidr: string, pool_id: string, solicitante: string}>|undefined} lista */
  const publicarExpiradas = async (lista) => {
    for (const e of lista || []) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
  };

  /** Reserva un rango. Idempotente con Idempotency-Key. */
  async function reservar(actor, entrada, claveHeader) {
    const n = normalizarReserva(entrada || {}, claveHeader, config);
    if (!n.ok) return n;
    const d = n.datos;

    const dest = await resolverDestino(repo, d);
    if (!dest.ok) return dest;
    const p = dest.pool;

    let r;
    try {
      r = await repo.transaccion((tx) => reservarEnTransaccion(tx, { actor, d, p, config }));
    } catch (e) {
      if (e instanceof ConflictoDeDatos && e.codigo === '23505')
        return fallo('conflicto', 'clave_idem_usada', { mensaje: 'Esa Idempotency-Key se está usando en otra petición simultánea; reintenta.' });
      if (e instanceof ConflictoDeDatos)
        return fallo('conflicto', 'solapamiento', { mensaje: 'El rango se solapa con otro (detectado por la base de datos).' });
      throw e;
    }
    await publicarExpiradas(r.expiradas);
    if (!r.ok) return r;
    if (!r.repetida)
      await eventos.publicar('reserva_creada', {
        reserva: r.reserva.id,
        cidr: r.reserva.cidr,
        pool: r.reserva.pool_id,
        solicitante: actor.nombre,
        ticket: r.reserva.ticket,
        expira_en: r.reserva.expira_en,
      });
    return ok({ reserva: presentar(r.reserva), repetida: r.repetida });
  }

  /** Busca la reserva y comprueba que quien opera sea el dueño o un admin. */
  async function paraOperar(actor, id) {
    if (!UUID.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    const previa = await repo.reservaPorId(id);
    if (!previa) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    if (!R.puedeOperar(actor, previa))
      return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó la reserva (o un admin) puede operar sobre ella.' });
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
        return {
          ...fallo('conflicto', 'reserva_no_vigente', {
            estado: dec.estado,
            mensaje: `La reserva está ${dec.estado}: ya no se puede confirmar. Pide una nueva.`,
          }),
          expiradas,
        };
      }
      const asignacion = await tx.insertarAsignacionDeReserva(actual);
      const reserva = await tx.marcarConfirmada(id, asignacion.id);
      return ok({ reserva, asignacion, repetida: false });
    });
    await publicarExpiradas(r.expiradas);
    if (!r.ok) return r;
    if (!r.repetida)
      await eventos.publicar('reserva_confirmada', {
        reserva: id,
        cidr: r.reserva.cidr,
        pool: r.reserva.pool_id,
        ticket: r.reserva.ticket,
        aprobado_por: ap.aprobadoPor || actor.nombre,
        referencia: ap.referencia,
      });
    // Gancho opcional (p. ej. avisar a Jira): un fallo ahí nunca deshace la confirmación.
    if (!r.repetida && alConfirmar) {
      try {
        await alConfirmar(actor, r.reserva, r.asignacion, { aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia });
      } catch (e) {
        await eventos.publicar('reserva_gancho_error', { reserva: id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok({
      reserva: presentar(r.reserva),
      asignacion: r.asignacion,
      repetida: r.repetida,
      aprobacion: { aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia },
    });
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
    if (!r.repetida)
      await eventos.publicar('reserva_liberada', { reserva: id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, asignacion_borrada: r.asignacionBorrada });
    return ok({ reserva: presentar(r.reserva), repetida: r.repetida, asignacionBorrada: r.asignacionBorrada });
  }

  async function obtener(id) {
    if (!UUID.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
    const r = await repo.reservaPorId(id);
    return r ? ok({ reserva: presentar(r) }) : fallo('no_encontrado', 'no_encontrado', { mensaje: 'La reserva no existe.' });
  }

  /** @param {{estado?: string, pool?: string, solicitante?: string, limite?: unknown}} [filtros] */
  async function listar({ estado, pool, solicitante, limite } = {}) {
    if (estado && !R.ESTADOS.includes(estado)) return fallo('validacion', 'estado_invalido', { mensaje: `estado debe ser uno de: ${R.ESTADOS.join(', ')}.` });
    const max = Math.min(Math.max(Number(limite) || 200, 1), 500);
    const filas = await repo.listarReservas({ estado: estado || null, pool: pool || null, solicitante: solicitante || null, limite: max });
    return ok({ reservas: filas.map(presentar) });
  }

  return { reservar, confirmar, liberar, obtener, listar, normalizar: (e, k) => normalizarReserva(e, k, config) };
}

module.exports = { crearReservas, presentar };
