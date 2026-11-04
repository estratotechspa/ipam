// @ts-check
'use strict';
// Gestión de un grupo de reservas ya creado: consultarlo, buscarlo, renovarlo, confirmarlo (admin) y liberarlo. Todo o nada.
const R = require('../dominio/reserva');
const { UUID } = require('../dominio/lote');
const { ok, fallo } = require('./resultado');
const { presentarGrupo, idParaPoolVpc } = require('./reservas-grupo');
const { revisarPool } = require('./pools');

const malo = (error, mensaje) => fallo('validacion', error, { mensaje });

/** Para deshacer la transacción de confirmar cuando el pool de la VPC no se puede crear (el repositorio revierte al lanzarse). */
class Revertir extends Error {
  /** @param {any} resultado */
  constructor(resultado) {
    super('revertir');
    this.resultado = resultado;
  }
}

/** Límites de máscara del hijo: hereda los del padre que quepan en el hijo (son los de las subredes que saldrán de él). */
function limitesHeredados(padre, largoHijo) {
  const cabe = (n) => (n === null || n === undefined ? null : n >= largoHijo ? n : null);
  const minima = padre.mascara_minima === null || padre.mascara_minima === undefined ? null : Math.max(padre.mascara_minima, largoHijo);
  return { mascara_defecto: cabe(padre.mascara_defecto), mascara_minima: minima, mascara_maxima: cabe(padre.mascara_maxima) };
}
const ESTADOS_GRUPO = ['reservada', 'confirmada', 'liberada', 'expirada', 'mixto'];

/** Crea, dentro de la transacción de confirmar, el pool hijo del bloque de una VPC. Si no se puede, revierte todo con `Revertir`. */
async function crearPoolDeBloque(tx, x) {
  const padre = await tx.obtenerPool(x.pool_id);
  const idPool = padre && (await idParaPoolVpc(x.proyecto, x.vpc, (i) => tx.obtenerPool(i)));
  if (!idPool) throw new Revertir(fallo('conflicto', 'pool_existe', { mensaje: `No se pudo crear el pool de la VPC «${x.vpc}»: el nombre ya está en uso.` }));
  const datos = {
    id: idPool,
    tipo: 'VPC',
    ambiente: padre.ambiente,
    proveedor: padre.proveedor,
    cidr: x.cidr,
    proyecto: x.proyecto,
    vpc: x.vpc,
    padre_id: padre.id,
    ...limitesHeredados(padre, Number(String(x.cidr).split('/')[1])),
  };
  const rev = await revisarPool(tx, datos);
  if (!rev.ok) throw new Revertir(rev);
  await tx.insertarPoolSiNoExiste(datos);
  return datos;
}

/** El pool hijo de un bloque de VPC ya confirmado (o undefined) y, si tiene algo dentro, el fallo que impide liberar el bloque. */
async function poolDeBloqueALiberar(tx, x) {
  const padre = await tx.obtenerPool(x.pool_id);
  const hijo = (await tx.poolesPorVpc({ ambiente: padre.ambiente, vpc: x.vpc, proyecto: x.proyecto })).find(
    (p) => p.padre_id === x.pool_id && p.cidr === x.cidr,
  );
  if (!hijo) return {};
  const uso = await tx.usoDePool(hijo.id);
  if (uso.asignaciones || uso.reservas_vigentes || uso.direcciones || uso.hijos)
    return {
      fallo: fallo('conflicto', 'pool_en_uso', {
        mensaje: `El pool ${hijo.id} de la VPC «${x.vpc}» tiene ${uso.asignaciones} asignaciones, ${uso.reservas_vigentes} reservas vigentes, ${uso.direcciones} direcciones IP y ${uso.hijos} pools hijos. Libéralos antes de liberar el bloque.`,
        uso,
      }),
    };
  return { hijo };
}

/**
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, config: any}} deps
 */
function crearGestionGrupo({ repo, eventos, config }) {
  /** Extiende la vigencia de un grupo vigente sin cambiar sus CIDR. Tope acumulado: ttlMaxHoras desde la creación del grupo. */
  async function renovarGrupo(actor, id, cuerpo) {
    const t = R.validarTtl(cuerpo?.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
    if (!t.ok) return malo(t.error, t.mensaje);
    const previas = UUID.test(String(id)) ? await repo.reservasDeGrupo(id) : [];
    if (!previas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    if (!R.puedeOperar(actor, previas[0])) return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó el grupo (o un admin) puede renovarlo.' });
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`grupo:${id}`);
      for (const idPool of [...new Set(previas.map((x) => x.pool_id))].sort()) await tx.bloquear(`pool:${idPool}`);
      const filas = await tx.reservasDeGrupo(id, { bloquear: true });
      if (!filas.some((x) => x.estado === 'reservada'))
        return fallo('conflicto', 'grupo_no_vigente', {
          mensaje: 'El grupo ya no está vigente (expirado, liberado o confirmado): no se renueva. Reserva de nuevo con otra clave.',
        });
      const dr = await tx.datosRenovacionGrupo(id, t.horas, config.reservas.ttlMaxHoras);
      if (new Date(dr.nueva) > new Date(dr.tope)) {
        const quedan = Math.max(0, Math.floor((new Date(dr.tope).getTime() - new Date(dr.ahora).getTime()) / 3600_000));
        return malo(
          'ttl_excede_maximo',
          `La vigencia acumulada de un grupo no puede pasar de ${config.reservas.ttlMaxHoras} h desde su creación: desde ahora puedes extenderlo hasta ${quedan} h.`,
        );
      }
      await tx.extenderGrupo(id, dr.nueva);
      return ok({ filas: await tx.reservasDeGrupo(id) });
    });
    if (!r.ok) return r;
    const grupo = presentarGrupo(r.filas);
    await eventos.publicar('grupo_renovado', { grupo: id, expira_en: grupo.expira_en });
    return ok({ grupo });
  }

  /**
   * Busca grupos por Idempotency-Key, ticket, estado o por vencer. Un token solo ve los suyos; la clave es siempre del que llama.
   * @param {any} actor @param {{clave?: string, ticket?: string, estado?: string, por_expirar_horas?: unknown}} [filtros]
   */
  async function buscarGrupos(actor, filtros = {}) {
    const { clave, ticket, estado, por_expirar_horas: porExpirar } = filtros;
    if (estado && !ESTADOS_GRUPO.includes(estado)) return malo('estado_invalido', `estado debe ser uno de: ${ESTADOS_GRUPO.join(', ')}.`);
    const horas = porExpirar === undefined ? null : Number(porExpirar);
    if (horas !== null && (!Number.isInteger(horas) || horas < 1))
      return malo('por_expirar_invalido', 'por_expirar_horas debe ser un entero de 1 en adelante.');
    const ids = await repo.gruposDe({ clave: clave || null, ticket: ticket || null, solicitante: actor.tipo === 'token' || clave ? actor.nombre : null });
    const grupos = [];
    for (const id of ids) grupos.push(presentarGrupo(await repo.reservasDeGrupo(id)));
    return ok({
      grupos: grupos.filter((g) => (!estado || g.estado === estado) && (horas === null || (g.estado === 'reservada' && g.segundos_restantes <= horas * 3600))),
    });
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
    const conBloque = previas.some((x) => x.rango === 'vpc');
    let r;
    try {
      r = await repo.transaccion(async (tx) => {
        await tx.bloquear(`grupo:${id}`);
        if (conBloque) await tx.bloquear('pools'); // mismo orden que en los pools: primero «pools», luego cada pool
        for (const idPool of [...new Set(previas.map((x) => x.pool_id))].sort()) await tx.bloquear(`pool:${idPool}`);
        const filas = await tx.reservasDeGrupo(id, { bloquear: true });
        const malas = filas.filter((x) => R.decidirConfirmacion(x.estado).accion === 'rechazar');
        if (malas.length)
          return fallo('conflicto', 'reserva_no_vigente', {
            mensaje: `Una reserva del grupo está ${malas[0].estado}: el grupo ya no se puede confirmar. Pide uno nuevo.`,
            estado: malas[0].estado,
          });
        const nuevas = filas.filter((x) => x.estado === 'reservada');
        const poolsCreados = [];
        for (const x of nuevas) {
          if (x.rango === 'vpc') {
            // El bloque de una VPC no es una asignación: al confirmarlo nace el pool hijo con su identidad (proyecto, vpc, padre).
            await tx.marcarConfirmada(x.id, null);
            const datos = await crearPoolDeBloque(tx, x);
            poolsCreados.push(datos);
            continue;
          }
          const asignacion = await tx.insertarAsignacionDeReserva(x);
          await tx.marcarConfirmada(x.id, asignacion.id);
        }
        return ok({ filas: await tx.reservasDeGrupo(id), repetida: !nuevas.length, poolsCreados });
      });
    } catch (e) {
      if (e instanceof Revertir) return e.resultado;
      throw e;
    }
    if (!r.ok) return r;
    const grupo = presentarGrupo(r.filas);
    if (!r.repetida) {
      for (const p of r.poolsCreados) await eventos.publicar('pool_creado', { ...p, grupo: id });
      await eventos.publicar('grupo_confirmado', {
        grupo: id,
        ticket: grupo.ticket,
        rangos: grupo.rangos.map((x) => x.cidr),
        aprobado_por: ap.aprobadoPor || actor.nombre,
        referencia: ap.referencia,
      });
    }
    return ok({
      grupo,
      repetida: r.repetida,
      pools_creados: r.poolsCreados,
      aprobacion: { aprobado_por: ap.aprobadoPor || actor.nombre, referencia: ap.referencia },
    });
  }

  /** Libera todo el grupo. Reservas vigentes: el dueño o un admin. Si ya se confirmó (asignaciones), solo un admin. Todo o nada. */
  async function liberarGrupo(actor, id) {
    const previas = UUID.test(String(id)) ? await repo.reservasDeGrupo(id) : [];
    if (!previas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    if (!R.puedeOperar(actor, previas[0]))
      return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó el grupo (o un admin) puede operar sobre él.' });
    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`grupo:${id}`);
      if (previas.some((x) => x.rango === 'vpc')) await tx.bloquear('pools');
      for (const idPool of [...new Set(previas.map((x) => x.pool_id))].sort()) await tx.bloquear(`pool:${idPool}`);
      const filas = await tx.reservasDeGrupo(id, { bloquear: true });
      if (filas.some((x) => x.estado === 'confirmada') && actor.rol !== 'admin')
        return fallo('prohibido', 'solo_admin_libera_asignacion', { mensaje: 'El grupo ya es una asignación definitiva: solo un admin puede liberarlo.' });
      const poolsDeVpc = new Map(); // reserva → pool hijo que nació al confirmar su bloque
      for (const x of filas) {
        const dec = R.decidirLiberacion(x.estado);
        if (dec.accion === 'borrar_asignacion' && x.asignacion_id && tx.contarDireccionesDe && (await tx.contarDireccionesDe(x.asignacion_id)))
          return fallo('conflicto', 'tiene_direcciones', {
            mensaje: `La asignación ${x.cidr} tiene direcciones IP registradas. Elimínalas antes de liberar el grupo.`,
          });
        if (dec.accion === 'borrar_asignacion' && x.rango === 'vpc') {
          // Liberar un bloque de VPC ya confirmado retira su pool, pero solo si está vacío: nunca se borran segmentos de otros.
          const { hijo, fallo: bloqueado } = await poolDeBloqueALiberar(tx, x);
          if (bloqueado) return bloqueado;
          if (hijo) poolsDeVpc.set(x.id, hijo);
        }
      }
      let borradas = 0;
      const poolsEliminados = [];
      for (const x of filas) {
        const dec = R.decidirLiberacion(x.estado);
        if (dec.accion === 'repetida') continue;
        if (dec.accion === 'borrar_asignacion' && x.asignacion_id && (await tx.borrarAsignacion(x.asignacion_id))) borradas += 1;
        if (poolsDeVpc.has(x.id)) {
          await tx.eliminarPool(poolsDeVpc.get(x.id).id);
          poolsEliminados.push(poolsDeVpc.get(x.id));
        }
        await tx.marcarLiberada(x.id);
      }
      return ok({ filas: await tx.reservasDeGrupo(id), borradas, poolsEliminados });
    });
    if (!r.ok) return r;
    const grupo = presentarGrupo(r.filas);
    for (const p of r.poolsEliminados) await eventos.publicar('pool_eliminado', { ...p, grupo: id });
    await eventos.publicar('grupo_liberado', { grupo: id, rangos: grupo.rangos.map((x) => x.cidr), asignaciones_borradas: r.borradas });
    return ok({ grupo, asignaciones_borradas: r.borradas, pools_eliminados: r.poolsEliminados });
  }

  /**
   * B1: el historial de un grupo (reservado, renovado, confirmado, liberado, expirado) para quien lo creó o un admin. Sale de los mismos
   * eventos que `/eventos`, pero solo los del grupo: `/eventos` sigue siendo solo para admin.
   */
  async function eventosDeGrupo(actor, id) {
    const previas = UUID.test(String(id)) ? await repo.reservasDeGrupo(id) : [];
    if (!previas.length) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El grupo no existe.' });
    if (!R.puedeOperar(actor, previas[0]))
      return fallo('prohibido', 'no_es_dueno', { mensaje: 'Solo quien creó el grupo (o un admin) puede ver sus eventos.' });
    const filas = await repo.eventosDeGrupo(id);
    return ok({ eventos: filas.map((e) => ({ id: e.id, ts: e.ts, tipo: e.tipo, detalle: e.detalle })) });
  }

  return { obtenerGrupo, confirmarGrupo, liberarGrupo, renovarGrupo, buscarGrupos, eventosDeGrupo };
}

module.exports = { crearGestionGrupo };
