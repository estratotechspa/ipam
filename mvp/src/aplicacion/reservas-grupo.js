// @ts-check
'use strict';
// Reserva en grupo: los rangos de un proyecto con clúster GKE (nodos, pods y servicios) se piden, se aprueban y se liberan juntos.
// Todo o nada: si uno no cabe, no se reserva ninguno. Cada rango sale del pool que la tabla «ambiente + uso → pool» indica.
const { parse, libres } = require('../dominio/cidr');
const R = require('../dominio/reserva');
const { RANGO_DE, UUID, normalizarLote, mismoLote } = require('../dominio/lote');
const { ok, fallo } = require('./resultado');
const { presentar } = require('./reservas');

const malo = (error, mensaje) => fallo('validacion', error, { mensaje });

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
  const rangos = filas.map(presentar);
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

/** Idempotencia del lote: la misma clave devuelve el mismo grupo; liberado o expirado se rechaza; con otros parámetros, conflicto. */
async function revisarIdempotenciaLote(tx, actor, d) {
  if (!d.clave) return null;
  const previa = await tx.reservaPorClave(actor.nombre, `${d.clave}:0`);
  if (!previa || !previa.grupo) return null;
  if (R.decidirIdempotencia(previa.estado) === 'rechazar')
    return fallo('conflicto', 'clave_idem_usada', { mensaje: `Esa Idempotency-Key ya se usó para un grupo que está ${previa.estado}. Usa una clave nueva.` });
  const filas = await tx.reservasDeGrupo(previa.grupo);
  // Al agregar a un grupo existente, el grupo ya tiene otros rangos: solo se comprueba que sea el mismo grupo.
  const igual = d.grupo ? d.grupo === previa.grupo : mismoLote(filas, d);
  if (!igual)
    return fallo('conflicto', 'idempotencia_conflicto', {
      mensaje: 'Esa Idempotency-Key ya se usó con otros parámetros. Usa una clave nueva o repite la misma petición.',
    });
  return ok({ filas, repetida: true, expiradas: [] });
}

/** El grupo al que se agregan rangos: debe existir, ser del dueño (o de un admin), del mismo ambiente y seguir vigente. */
async function validarGrupoExistente(tx, actor, d) {
  const filas = await tx.reservasDeGrupo(d.grupo);
  if (!filas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
  if (!R.puedeOperar(actor, filas[0])) return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó el grupo (o un admin) puede agregarle rangos.' });
  if (filas.every((f) => f.estado === 'liberada' || f.estado === 'expirada'))
    return fallo('conflicto', 'grupo_no_vigente', { mensaje: 'El grupo está liberado o expirado: no se le pueden agregar rangos. Pide uno nuevo.' });
  const pool = await tx.obtenerPool(filas[0].pool_id);
  if (!pool || pool.ambiente !== d.ambiente)
    return fallo('conflicto', 'grupo_de_otro_ambiente', { mensaje: `El grupo es de ${pool ? pool.ambiente : 'otro ambiente'}, no de ${d.ambiente}.` });
  return ok({ filas });
}

/**
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, config: any}} deps
 */
function crearReservasGrupo({ repo, eventos, config }) {
  /** Reserva todos los rangos del grupo o ninguno. Con `simular`, solo dice qué reservaría. Con `grupo`, agrega rangos a un grupo existente. */
  async function reservarLote(actor, entrada, claveHeader, { simular = false } = {}) {
    const n = normalizarLote(entrada || {}, claveHeader, config);
    if (!n.ok) return malo(n.error, n.mensaje);
    const d = n.d;
    const dest = await resolverPools(repo, d);
    if (!dest.ok) return dest;
    const idsPools = [...new Set(dest.destinos.map((x) => x.pool.id))].sort();

    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`actor:${actor.nombre}`);
      if (d.grupo) await tx.bloquear(`grupo:${d.grupo}`); // el mismo orden que confirmar y liberar un grupo: primero el grupo, luego los pools
      const repetido = await revisarIdempotenciaLote(tx, actor, d);
      if (repetido) return repetido;
      const previo = d.grupo ? await validarGrupoExistente(tx, actor, d) : null;
      if (previo && !previo.ok) return previo;
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
      const base = previo ? previo.filas[0] : null;
      const grupo = d.grupo || (await tx.nuevoGrupo());
      const ticket = d.ticket || base?.ticket || (await tx.siguienteTicket());
      const filas = [];
      for (const [k, x] of p.plan.entries())
        filas.push(
          await tx.insertarReserva({
            pool: x.pool.id,
            cidr: x.cidr,
            vpc: d.vpc || base?.vpc || '',
            solicitante: actor.nombre,
            ticket,
            ttlHoras: d.ttlHoras,
            clave: d.clave ? `${d.clave}:${k}` : null,
            proyecto: d.proyecto ?? base?.proyecto ?? null,
            subred: x.subred,
            nombre: x.nombre,
            grupo,
            rango: RANGO_DE[x.uso],
          }),
        );
      return ok({ filas: d.grupo ? await tx.reservasDeGrupo(grupo) : filas, repetida: false, expiradas });
    });
    for (const e of r.expiradas || []) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
    if (!r.ok) return r;
    if (r.simulacion)
      return ok({
        simulacion: true,
        rangos: r.simulacion.map((x) => ({
          uso: x.uso,
          rango: RANGO_DE[x.uso],
          nombre: x.nombre,
          subred: x.subred,
          pool: x.pool.id,
          cidr: x.cidr,
          mascara: x.mascara,
        })),
      });
    const grupo = presentarGrupo(r.filas);
    if (!r.repetida)
      await eventos.publicar('grupo_reservado', {
        grupo: grupo.grupo,
        solicitante: actor.nombre,
        ticket: grupo.ticket,
        rangos: grupo.rangos.map((x) => x.cidr),
        agregado: Boolean(d.grupo),
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
      await tx.bloquear(`grupo:${id}`);
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
      await tx.bloquear(`grupo:${id}`);
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
