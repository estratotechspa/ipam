// @ts-check
'use strict';
// Reserva en grupo: los rangos de un proyecto con clúster GKE (nodos, pods y servicios) se piden, se aprueban y se liberan juntos.
// Todo o nada: si uno no cabe, no se reserva ninguno. Cada rango sale del pool que la tabla «ambiente + uso → pool» indica.
const { parse, libres } = require('../dominio/cidr');
const R = require('../dominio/reserva');
const { RANGO_DE, normalizarLote, mismoLote } = require('../dominio/lote');
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
    const mascara = r.mascara ?? pool.mascara_defecto ?? null;
    if (mascara === null) return malo('falta_tamano', `Indica la máscara de «${r.uso}»: el pool ${pool.id} no tiene un tamaño por defecto.`);
    const limite = R.limiteDeMascara(pool, mascara);
    if (limite) return malo('mascara_invalida', `La máscara /${mascara} de «${r.uso}» no está permitida en ${pool.id}: ${limite}`);
    if (mascara < base.len) return malo('mascara_invalida', `La máscara /${mascara} de «${r.uso}» es más grande que el pool ${pool.id} (${pool.cidr}).`);
    destinos.push({ ...r, mascara, pool });
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

/** Lo que el agente necesita saber de una simulación: si la cuota alcanza, cuánto queda libre en cada pool y la versión de la tabla. */
async function contextoDeSimulacion(tx, actor, config, destinos, version) {
  let cuota = null;
  if (actor.tipo === 'token') {
    const limite = actor.cuota || config.limite.cuotaReservasPorToken;
    const usada = await tx.contarVigentesDe(actor.nombre);
    cuota = { usada, limite, necesaria: destinos.length, alcanza: usada + destinos.length <= limite };
  }
  const pools = [];
  for (const id of [...new Set(destinos.map((x) => x.pool.id))].sort()) {
    const p = destinos.find((x) => x.pool.id === id).pool;
    const base = parse(p.cidr);
    const ocupadas = (await tx.ocupados(id)).reduce((n, c) => n + 2 ** (32 - (parse(c)?.len ?? 32)), 0);
    pools.push({ pool: id, direcciones_libres: Math.max(0, 2 ** (32 - (base?.len ?? 32)) - ocupadas) });
  }
  return { cuota, pools, version_tabla: version };
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

/** Inserta los rangos del plan en un mismo grupo (nuevo, o el existente al que se agregan). Los agregados caducan con el grupo. */
async function insertarPlan(tx, actor, d, plan, previo) {
  const base = previo ? previo.filas[0] : null;
  // Una sola caducidad por grupo; si el grupo ya no tiene reservas vigentes (p. ej. está confirmado), el rango usa su propio ttl.
  const vigentes = previo ? previo.filas.filter((f) => f.estado === 'reservada') : [];
  const expiraEn = vigentes.length ? new Date(Math.max(...vigentes.map((f) => new Date(f.expira_en).getTime()))) : null;
  const grupo = d.grupo || (await tx.nuevoGrupo());
  const ticket = d.ticket || base?.ticket || (await tx.siguienteTicket());
  for (const [k, x] of plan.entries())
    await tx.insertarReserva({
      pool: x.pool.id,
      cidr: x.cidr,
      vpc: d.vpc || base?.vpc || '',
      solicitante: actor.nombre,
      ticket,
      ttlHoras: d.ttlHoras,
      expiraEn,
      clave: d.clave ? `${d.clave}:${k}` : null,
      proyecto: d.proyecto ?? base?.proyecto ?? null,
      subred: x.subred,
      nombre: x.nombre,
      grupo,
      rango: RANGO_DE[x.uso],
    });
  return tx.reservasDeGrupo(grupo);
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
    const version = await repo.versionPoolUso();
    if (d.versionTabla && d.versionTabla !== version)
      return fallo('conflicto', 'version_tabla_cambiada', {
        mensaje: 'La tabla ambiente + uso → pool cambió desde que la consultaste. Simula de nuevo antes de reservar.',
        version_tabla: version,
      });

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
      if (simular) return ok({ simulacion: p.plan, expiradas, contexto: await contextoDeSimulacion(tx, actor, config, dest.destinos, version) });
      const filas = await insertarPlan(tx, actor, d, p.plan, previo);
      return ok({ filas, repetida: false, expiradas });
    });
    for (const e of r.expiradas || []) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
    if (!r.ok) return r;
    if (r.simulacion)
      return ok({
        simulacion: true,
        ...r.contexto,
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
    return ok({ grupo, repetida: r.repetida, version_tabla: version });
  }

  return { reservarLote, versionTabla: () => repo.versionPoolUso() };
}

module.exports = { crearReservasGrupo, presentarGrupo };
