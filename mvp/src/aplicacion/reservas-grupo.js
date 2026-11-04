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

const exigeVpc = (config, ambiente) => {
  const lista = (config.reservas && config.reservas.exigirPoolVpc) || [];
  return lista.includes('todos') || lista.includes(ambiente);
};

/** Id del pool de una VPC: su nombre; si ya lo usa otro pool, «proyecto-vpc». @param {string} proyecto @param {string} vpc @param {(id: string) => Promise<any>} existe */
async function idParaPoolVpc(proyecto, vpc, existe) {
  const candidatos = [vpc, `${proyecto}-${vpc}`.slice(0, 63).replace(/-+$/, '')];
  for (const id of candidatos) if (!(await existe(id))) return id;
  return null;
}

/**
 * A2: una misma VPC no puede aparecer con distintos proyectos (en el mismo ambiente). Se mira en pools, asignaciones y reservas vigentes.
 * El proyecto es el del pedido; sin proyecto no hay con qué comparar.
 */
async function revisarCoherenciaVpc(repo, d) {
  if (!d.vpc || !d.proyecto) return null;
  const otros = (await repo.proyectosDeVpc({ ambiente: d.ambiente, vpc: d.vpc })).filter((p) => p !== d.proyecto);
  if (!otros.length) return null;
  return fallo('ambiguo', 'vpc_incoherente', {
    mensaje: `La VPC «${d.vpc}» ya figura en ${d.ambiente} con otro proyecto (${otros.join(', ')}) y el pedido trae «${d.proyecto}». Una VPC pertenece a un solo proyecto: corrige el proyecto o el nombre de la VPC.`,
    vpc: d.vpc,
    proyecto: d.proyecto,
    proyectos_existentes: otros,
  });
}

/**
 * C2: ¿de qué pool salen los nodos? Si el pedido trae vpc (y proyecto) y existe un pool con esa identidad, de ese pool. Si no existe:
 * con la bandera `exigir_pool_vpc` del ambiente → 422 `vpc_sin_pool`; sin ella, del pool de «ambiente + uso» como siempre.
 * Devuelve { pool, criterio, motivo }; `pool: null` = usar pool-uso.
 */
async function elegirPoolDeNodos(repo, d, config) {
  const exige = exigeVpc(config, d.ambiente);
  if (!d.vpc) {
    if (exige)
      return fallo('ambiguo', 'vpc_requerida', { mensaje: `En ${d.ambiente} los nodos se reservan por VPC (EXIGIR_POOL_VPC): indica vpc y proyecto.` });
    return ok({ pool: null, criterio: 'pool_uso', motivo: 'El pedido no trae vpc: los nodos salen del pool de «ambiente + uso» (pool-uso).' });
  }
  const pools = await repo.poolesPorVpc({ ambiente: d.ambiente, vpc: d.vpc, proyecto: d.proyecto });
  if (pools.length > 1)
    return fallo('ambiguo', 'vpc_ambigua', {
      mensaje: `Hay ${pools.length} pools con la VPC «${d.vpc}» en ${d.ambiente}: indica también el proyecto.`,
      opciones: pools.map((p) => ({ pool: p.id, proyecto: p.proyecto })),
    });
  if (pools.length === 1)
    return ok({
      pool: pools[0],
      criterio: 'vpc',
      motivo: `La VPC «${d.vpc}»${pools[0].proyecto ? ` (proyecto «${pools[0].proyecto}»)` : ''} tiene su propio pool ${pools[0].id}: los nodos salen de ahí.`,
    });
  if (exige)
    return fallo('ambiguo', 'vpc_sin_pool', {
      mensaje: `La VPC «${d.vpc}»${d.proyecto ? ` del proyecto «${d.proyecto}»` : ''} no tiene pool en ${d.ambiente}. Reserva antes su bloque (uso «vpc») y espera la confirmación de un admin.`,
      vpc: d.vpc,
      proyecto: d.proyecto,
    });
  return ok({
    pool: null,
    criterio: 'pool_uso',
    motivo: `La VPC «${d.vpc}» no tiene pool propio y EXIGIR_POOL_VPC está apagado para ${d.ambiente}: los nodos salen del pool de «ambiente + uso» (pool-uso).`,
  });
}

/** Valida el pool destino de un rango y su máscara. */
function destinoDe(r, pool, criterio, motivo) {
  const base = parse(pool.cidr);
  if (!base) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool configurado para «${r.uso}» ya no existe.` });
  const mascara = r.mascara ?? pool.mascara_defecto ?? null;
  if (mascara === null) return malo('falta_tamano', `Indica la máscara de «${r.uso}»: el pool ${pool.id} no tiene un tamaño por defecto.`);
  const limite = R.limiteDeMascara(pool, mascara);
  if (limite) return malo('mascara_invalida', `La máscara /${mascara} de «${r.uso}» no está permitida en ${pool.id}: ${limite}`);
  if (mascara < base.len) return malo('mascara_invalida', `La máscara /${mascara} de «${r.uso}» es más grande que el pool ${pool.id} (${pool.cidr}).`);
  return ok({ destino: { ...r, mascara, pool, criterio, motivo } });
}

/**
 * A1: el bloque de una VPC nueva sale de un pool padre (`padre` del pedido o, por defecto, el pool de «ambiente + nodos») y no puede
 * repetir la identidad de una VPC que ya tiene pool o un bloque reservado. Aquí no se crea nada: el pool nace al confirmar un admin.
 */
async function resolverBloqueVpc(repo, d, { repeticion = false } = {}) {
  const r = d.rangos[0];
  let padreId = d.padre;
  if (!padreId) {
    const fila = await repo.obtenerPoolUso(d.ambiente, 'nodos');
    if (!fila)
      return fallo('ambiguo', 'uso_sin_pool', {
        mensaje: `No hay un pool para «nodos» en ${d.ambiente} del que sacar el bloque de la VPC. Indica \`padre\` o pide a un admin configurarlo (pool-uso).`,
        uso: 'nodos',
        opciones: [],
      });
    padreId = fila.pool_id;
  }
  const padre = await repo.obtenerPool(padreId);
  if (!padre) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool padre «${padreId}» no existe.` });
  if (padre.ambiente !== d.ambiente)
    return fallo('ambiguo', 'pool_de_otro_ambiente', { mensaje: `El pool ${padre.id} es de ${padre.ambiente}, no de ${d.ambiente}.` });
  const base = parse(padre.cidr);
  if (!base || r.mascara <= base.len)
    return malo('mascara_invalida', `El bloque de la VPC (/${r.mascara}) debe ser más chico que el pool ${padre.id} (${padre.cidr}).`);
  // Una petición repetida (misma Idempotency-Key) devuelve el grupo que ya existe: su propia reserva no cuenta como duplicada.
  const incoherente = repeticion ? null : await revisarCoherenciaVpc(repo, d);
  if (incoherente) return incoherente;
  const ya = repeticion
    ? null
    : (await repo.poolesPorVpc({ ambiente: d.ambiente, vpc: d.vpc, proyecto: d.proyecto })).find(
        (p) => (p.proyecto ?? '') === d.proyecto && p.proveedor.toLowerCase() === padre.proveedor.toLowerCase(),
      );
  const pendiente = ya || repeticion ? null : await repo.reservaDeVpcPendiente({ proyecto: d.proyecto, vpc: d.vpc });
  if (ya || pendiente)
    return fallo('conflicto', 'vpc_duplicada', {
      mensaje: ya
        ? `La VPC «${d.vpc}» del proyecto «${d.proyecto}» ya es el pool ${ya.id}.`
        : `La VPC «${d.vpc}» del proyecto «${d.proyecto}» ya tiene un bloque reservado (${pendiente.cidr}) esperando confirmación.`,
      ...(ya ? { pool: ya.id } : { grupo: pendiente.grupo }),
    });
  const idPool = await idParaPoolVpc(d.proyecto, d.vpc, (id) => repo.obtenerPool(id));
  if (!idPool)
    return fallo('conflicto', 'pool_existe', { mensaje: `Ya existen pools llamados «${d.vpc}» y «${d.proyecto}-${d.vpc}». Elige otro nombre de VPC.` });
  // Los límites de máscara del padre son los de las subredes que salen de él, no los del bloque de la VPC.
  const x = destinoDe(r, { ...padre, mascara_minima: null, mascara_maxima: null }, 'padre', null);
  if (!x.ok) return x;
  x.destino.pool = padre;
  x.destino.motivo = `Bloque de la VPC «${d.vpc}»: sale del pool padre ${padre.id}${d.padre ? '' : ' (el de «ambiente + nodos»)'}; al confirmarlo un admin nace el pool «${idPool}».`;
  x.destino.pool_a_crear = { id: idPool, proyecto: d.proyecto, vpc: d.vpc, padre_id: padre.id };
  return ok({ destinos: [x.destino] });
}

/** Resuelve el pool de cada rango: nodos por VPC si hay pool, el resto con la tabla ambiente + uso → pool; y comprueba que la máscara quepa. */
async function resolverPools(repo, d, config, opciones) {
  if (d.rangos.some((r) => r.uso === 'vpc')) return resolverBloqueVpc(repo, d, opciones);
  const incoherente = await revisarCoherenciaVpc(repo, d);
  if (incoherente) return incoherente;
  let eleccion = null; // la elección por VPC es la misma para todos los rangos de nodos del pedido
  const destinos = [];
  for (const r of d.rangos) {
    if (r.uso === 'nodos') {
      eleccion = eleccion || (await elegirPoolDeNodos(repo, d, config));
      if (!eleccion.ok) return eleccion;
      if (eleccion.pool) {
        const x = destinoDe(r, eleccion.pool, eleccion.criterio, eleccion.motivo);
        if (!x.ok) return x;
        destinos.push(x.destino);
        continue;
      }
    }
    const fila = await repo.obtenerPoolUso(d.ambiente, r.uso);
    if (!fila)
      return fallo('ambiguo', 'uso_sin_pool', {
        mensaje: `No hay un pool configurado para «${r.uso}» en ${d.ambiente}. Un admin debe asignarlo (pool-uso).`,
        uso: r.uso,
        opciones: [],
      });
    const pool = await repo.obtenerPool(fila.pool_id);
    if (!pool) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool configurado para «${r.uso}» ya no existe.` });
    const motivo = r.uso === 'nodos' && eleccion ? eleccion.motivo : `Los ${r.uso} salen del pool de «ambiente + uso» (${d.ambiente}/${r.uso}).`;
    const x = destinoDe(r, pool, 'pool_uso', motivo);
    if (!x.ok) return x;
    destinos.push(x.destino);
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
    const repeticion = Boolean(d.clave && (await repo.reservaPorClave(actor.nombre, `${d.clave}:0`)));
    const dest = await resolverPools(repo, d, config, { repeticion });
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
    for (const e of r.expiradas || [])
      await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante, grupo: e.grupo ?? undefined });
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
          criterio: x.criterio,
          motivo: x.motivo,
          ...(x.pool_a_crear ? { pool_a_crear: x.pool_a_crear } : {}),
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

module.exports = { crearReservasGrupo, presentarGrupo, idParaPoolVpc };
