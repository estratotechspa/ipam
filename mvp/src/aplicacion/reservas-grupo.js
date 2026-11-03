// @ts-check
'use strict';
// Reserva en grupo: los rangos de un proyecto con clúster GKE (nodos, pods y servicios) se piden, se aprueban y se liberan juntos.
// Todo o nada: si uno no cabe, no se reserva ninguno. Cada rango sale del pool que la tabla «ambiente + uso → pool» indica.
const { parse, libres } = require('../dominio/cidr');
const R = require('../dominio/reserva');
const { validarNombres } = require('../dominio/nombres');
const { ok, fallo } = require('./resultado');
const { presentar } = require('./reservas');

const AMBIENTES = ['dev', 'qa', 'lab', 'pre', 'prod'];
const USOS = ['nodos', 'pods', 'servicios'];
const RANGO_DE = { nodos: 'principal', pods: 'pods', servicios: 'servicios' };
// Tamaños por defecto de GKE (documentación oficial): Pods /14, Servicios /20. Los nodos no tienen un valor por defecto.
const MASCARA_DEFECTO = { pods: 14, servicios: 20 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const malo = (error, mensaje) => fallo('validacion', error, { mensaje });

/** Valida la lista de rangos pedidos: usos válidos, sin repetir, con su máscara (o la de GKE por defecto). */
function validarRangos(lista) {
  if (!Array.isArray(lista) || !lista.length || lista.length > USOS.length)
    return malo('rangos_invalidos', 'Indica de 1 a 3 rangos: nodos, pods y/o servicios.');
  const vistos = new Set();
  const salida = [];
  for (const r of lista) {
    const uso = r && typeof r === 'object' ? String(r.uso) : '';
    if (!USOS.includes(uso)) return malo('uso_invalido', `El uso debe ser uno de: ${USOS.join(', ')}.`);
    if (vistos.has(uso)) return malo('uso_repetido', `El uso «${uso}» está repetido.`);
    vistos.add(uso);
    const pedida = r.mascara === undefined || r.mascara === null || r.mascara === '' ? MASCARA_DEFECTO[uso] : Number(r.mascara);
    if (pedida === undefined) return malo('falta_tamano', `Indica la máscara de «${uso}» (no tiene tamaño por defecto).`);
    if (!Number.isInteger(pedida) || pedida < 8 || pedida > 32) return malo('mascara_invalida', `La máscara de «${uso}» debe ser un entero entre 8 y 32.`);
    salida.push({ uso, mascara: pedida });
  }
  return ok({ rangos: USOS.map((u) => salida.find((x) => x.uso === u)).filter(Boolean) });
}

/** Valida y normaliza el pedido completo sin tocar la base. */
function normalizarLote(e, claveHeader, config) {
  if (!AMBIENTES.includes(e.ambiente)) return malo('ambiente_invalido', `El ambiente debe ser uno de: ${AMBIENTES.join(', ')}.`);
  const rangos = validarRangos(e.rangos);
  if (!rangos.ok) return rangos;
  const nom = validarNombres(e);
  if (!nom.ok) return malo(nom.error, nom.mensaje);
  if (e.vpc !== undefined && e.vpc !== null && (typeof e.vpc !== 'string' || e.vpc.trim().length > 120))
    return malo('vpc_invalido', 'La VPC admite hasta 120 caracteres.');
  const ttl = R.validarTtl(e.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
  if (!ttl.ok) return malo(ttl.error, ttl.mensaje);
  const t = R.validarTicket(e.ticket);
  if (!t.ok) return malo(t.error, t.mensaje);
  const k = R.validarClaveIdem(claveHeader);
  if (!k.ok) return malo(k.error, k.mensaje);
  return ok({
    d: {
      ambiente: e.ambiente,
      rangos: rangos.rangos,
      proyecto: nom.proyecto,
      subred: nom.subred,
      vpc: (e.vpc || '').trim(),
      ticket: t.ticket,
      ttlHoras: ttl.horas,
      clave: k.clave,
    },
  });
}

/** Resuelve el pool de cada rango con la tabla ambiente + uso → pool y comprueba que la máscara quepa. */
async function resolverPools(repo, d) {
  const destinos = [];
  for (const r of d.rangos) {
    const fila = await repo.obtenerPoolUso(d.ambiente, r.uso);
    if (!fila)
      return fallo('ambiguo', 'uso_sin_pool', {
        mensaje: `No hay un pool configurado para «${r.uso}» en ${d.ambiente}. Un admin debe asignarlo (pool-uso).`,
        uso: r.uso,
        opciones: [],
      });
    const pool = await repo.obtenerPool(fila.pool_id);
    const base = pool && parse(pool.cidr);
    if (!pool || !base) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool configurado para «${r.uso}» ya no existe.` });
    if (r.mascara < base.len) return malo('mascara_invalida', `La máscara /${r.mascara} de «${r.uso}» es más grande que el pool ${pool.id} (${pool.cidr}).`);
    destinos.push({ ...r, pool });
  }
  return ok({ destinos });
}

/** Elige el primer rango libre de cada destino, contando lo que los rangos anteriores del mismo grupo ya se llevan. */
async function planificar(tx, destinos) {
  const apartados = new Map(); // pool → rangos que este grupo ya tomó
  const plan = [];
  for (const dest of destinos) {
    const propios = apartados.get(dest.pool.id) || [];
    const ocup = [...(await tx.ocupados(dest.pool.id)), ...propios];
    const cidr = libres(dest.pool.cidr, ocup, dest.mascara, 1)[0];
    if (!cidr)
      return fallo('conflicto', 'sin_espacio', {
        mensaje: `No quedan segmentos /${dest.mascara} libres en ${dest.pool.id} para «${dest.uso}». No se reservó ningún rango del grupo.`,
        uso: dest.uso,
        sugeridos: [],
      });
    apartados.set(dest.pool.id, [...propios, cidr]);
    plan.push({ ...dest, cidr });
  }
  return ok({ plan });
}

/** La cuota cuenta cada rango como una reserva vigente. */
async function revisarCuotaLote(tx, actor, config, cuantas) {
  if (actor.tipo !== 'token') return null;
  const limite = actor.cuota || config.limite.cuotaReservasPorToken;
  const vigentes = await tx.contarVigentesDe(actor.nombre);
  if (vigentes + cuantas <= limite) return null;
  return fallo('cuota', 'cuota_excedida', {
    vigentes,
    limite,
    mensaje: `Tienes ${vigentes} reservas vigentes de ${limite} permitidas y este grupo pide ${cuantas} más. Libera alguna antes de pedir otro.`,
  });
}

/** Presenta el grupo: el estado del conjunto sale de sus rangos. */
function presentarGrupo(filas) {
  const rangos = filas.map(presentar).map((r, i) => ({ ...r, rango: filas[i].rango, grupo: filas[i].grupo }));
  const estados = new Set(rangos.map((r) => r.estado));
  const estado = estados.size === 1 ? [...estados][0] : 'mixto';
  const primera = rangos[0];
  return {
    grupo: primera.grupo,
    estado,
    proyecto: primera.proyecto,
    subred: primera.subred,
    solicitante: primera.solicitante,
    ticket: primera.ticket,
    expira_en: primera.expira_en,
    segundos_restantes: Math.max(...rangos.map((r) => r.segundos_restantes)),
    rangos,
  };
}

/**
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, config: any}} deps
 */
function crearReservasGrupo({ repo, eventos, config }) {
  /** Reserva todos los rangos del grupo o ninguno. Con `simular`, solo dice qué reservaría. */
  async function reservarLote(actor, entrada, claveHeader, { simular = false } = {}) {
    const n = normalizarLote(entrada || {}, claveHeader, config);
    if (!n.ok) return n;
    const d = n.d;
    const dest = await resolverPools(repo, d);
    if (!dest.ok) return dest;
    const idsPools = [...new Set(dest.destinos.map((x) => x.pool.id))].sort();

    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`actor:${actor.nombre}`);
      if (d.clave) {
        const previa = await tx.reservaPorClave(actor.nombre, `${d.clave}:${dest.destinos[0].uso}`);
        if (previa && previa.grupo) {
          if (R.decidirIdempotencia(previa.estado) === 'rechazar')
            return fallo('conflicto', 'clave_idem_usada', {
              mensaje: `Esa Idempotency-Key ya se usó para un grupo que está ${previa.estado}. Usa una clave nueva.`,
            });
          return ok({ filas: await tx.reservasDeGrupo(previa.grupo), repetida: true, expiradas: [] });
        }
      }
      const sinCuota = simular ? null : await revisarCuotaLote(tx, actor, config, dest.destinos.length);
      if (sinCuota) return sinCuota;
      const expiradas = [];
      for (const id of idsPools) {
        await tx.bloquear(`pool:${id}`);
        expiradas.push(...(await tx.expirarVencidas(id)));
      }
      const p = await planificar(tx, dest.destinos);
      if (!p.ok) return { ...p, expiradas };
      if (simular) return ok({ simulacion: p.plan, expiradas });
      const grupo = await tx.nuevoGrupo();
      const ticket = d.ticket || (await tx.siguienteTicket());
      const filas = [];
      for (const x of p.plan)
        filas.push(
          await tx.insertarReserva({
            pool: x.pool.id,
            cidr: x.cidr,
            vpc: d.vpc,
            solicitante: actor.nombre,
            ticket,
            ttlHoras: d.ttlHoras,
            clave: d.clave ? `${d.clave}:${x.uso}` : null,
            proyecto: d.proyecto,
            subred: d.subred,
            grupo,
            rango: RANGO_DE[x.uso],
          }),
        );
      return ok({ filas, repetida: false, expiradas });
    });
    for (const e of r.expiradas || []) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
    if (!r.ok) return r;
    if (r.simulacion)
      return ok({
        simulacion: true,
        rangos: r.simulacion.map((x) => ({ uso: x.uso, rango: RANGO_DE[x.uso], pool: x.pool.id, cidr: x.cidr, mascara: x.mascara })),
      });
    const grupo = presentarGrupo(r.filas);
    if (!r.repetida)
      await eventos.publicar('grupo_reservado', {
        grupo: grupo.grupo,
        solicitante: actor.nombre,
        ticket: grupo.ticket,
        rangos: grupo.rangos.map((x) => x.cidr),
      });
    return ok({ grupo, repetida: r.repetida });
  }

  async function obtenerGrupo(id) {
    if (!UUID.test(String(id))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    const filas = await repo.reservasDeGrupo(id);
    return filas.length ? ok({ grupo: presentarGrupo(filas) }) : fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
  }

  /** Confirma todo el grupo en una sola transacción (solo admin: lo exige la ruta). Todo o nada. */
  async function confirmarGrupo(actor, id, cuerpo) {
    const ap = R.validarAprobacion(cuerpo, false);
    if (!ap.ok) return fallo('validacion', ap.error, { mensaje: ap.mensaje });
    const previas = UUID.test(String(id)) ? await repo.reservasDeGrupo(id) : [];
    if (!previas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    const r = await repo.transaccion(async (tx) => {
      for (const idPool of [...new Set(previas.map((x) => x.pool_id))].sort()) await tx.bloquear(`pool:${idPool}`);
      const filas = await tx.reservasDeGrupo(id, { bloquear: true });
      const malas = filas.filter((x) => R.decidirConfirmacion(x.estado).accion === 'rechazar');
      if (malas.length)
        return fallo('conflicto', 'reserva_no_vigente', {
          mensaje: `Una reserva del grupo está ${malas[0].estado}: el grupo ya no se puede confirmar. Pide uno nuevo.`,
          estado: malas[0].estado,
        });
      const nuevas = filas.filter((x) => x.estado === 'reservada');
      for (const x of nuevas) {
        const asignacion = await tx.insertarAsignacionDeReserva(x);
        await tx.marcarConfirmada(x.id, asignacion.id);
      }
      return ok({ filas: await tx.reservasDeGrupo(id), repetida: !nuevas.length });
    });
    if (!r.ok) return r;
    const grupo = presentarGrupo(r.filas);
    if (!r.repetida)
      await eventos.publicar('grupo_confirmado', {
        grupo: id,
        ticket: grupo.ticket,
        rangos: grupo.rangos.map((x) => x.cidr),
        aprobado_por: ap.aprobadoPor || actor.nombre,
        referencia: ap.referencia,
      });
    return ok({ grupo, repetida: r.repetida, aprobacion: { aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia } });
  }

  /** Libera todo el grupo. Reservas vigentes: el dueño o un admin. Si ya se confirmó (asignaciones), solo un admin. Todo o nada. */
  async function liberarGrupo(actor, id) {
    const previas = UUID.test(String(id)) ? await repo.reservasDeGrupo(id) : [];
    if (!previas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    if (!R.puedeOperar(actor, previas[0]))
      return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó el grupo (o un admin) puede operar sobre él.' });
    const r = await repo.transaccion(async (tx) => {
      for (const idPool of [...new Set(previas.map((x) => x.pool_id))].sort()) await tx.bloquear(`pool:${idPool}`);
      const filas = await tx.reservasDeGrupo(id, { bloquear: true });
      if (filas.some((x) => x.estado === 'confirmada') && actor.rol !== 'admin')
        return fallo('prohibido', 'solo_admin_libera_asignacion', { mensaje: 'El grupo ya es una asignación definitiva: solo un admin puede liberarlo.' });
      for (const x of filas) {
        const dec = R.decidirLiberacion(x.estado);
        if (dec.accion === 'borrar_asignacion' && x.asignacion_id && tx.contarDireccionesDe && (await tx.contarDireccionesDe(x.asignacion_id)))
          return fallo('conflicto', 'tiene_direcciones', {
            mensaje: `La asignación ${x.cidr} tiene direcciones IP registradas. Elimínalas antes de liberar el grupo.`,
          });
      }
      let borradas = 0;
      for (const x of filas) {
        const dec = R.decidirLiberacion(x.estado);
        if (dec.accion === 'repetida') continue;
        if (dec.accion === 'borrar_asignacion' && x.asignacion_id && (await tx.borrarAsignacion(x.asignacion_id))) borradas += 1;
        await tx.marcarLiberada(x.id);
      }
      return ok({ filas: await tx.reservasDeGrupo(id), borradas });
    });
    if (!r.ok) return r;
    const grupo = presentarGrupo(r.filas);
    await eventos.publicar('grupo_liberado', { grupo: id, rangos: grupo.rangos.map((x) => x.cidr), asignaciones_borradas: r.borradas });
    return ok({ grupo, asignaciones_borradas: r.borradas });
  }

  return { reservarLote, obtenerGrupo, confirmarGrupo, liberarGrupo };
}

module.exports = { crearReservasGrupo, presentarGrupo };
