// @ts-check
'use strict';
// Gestión de un grupo de reservas ya creado: consultarlo, buscarlo, renovarlo, confirmarlo (admin) y liberarlo. Todo o nada.
const R = require('../dominio/reserva');
const { UUID } = require('../dominio/lote');
const { ok, fallo } = require('./resultado');
const { presentarGrupo } = require('./reservas-grupo');

const malo = (error, mensaje) => fallo('validacion', error, { mensaje });
const ESTADOS_GRUPO = ['reservada', 'confirmada', 'liberada', 'expirada', 'mixto'];

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

  return { obtenerGrupo, confirmarGrupo, liberarGrupo, renovarGrupo, buscarGrupos };
}

module.exports = { crearGestionGrupo };
