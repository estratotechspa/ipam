'use strict';
// Reservas tentativas. Quien reserva es «agente» o más; ver y listar, cualquier rol. Opera solo el dueño o un admin.
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo } = require('../errores');

const texto = (v) => (typeof v === 'string' && v ? v : undefined); // ignora repeticiones de parámetros (?a=1&a=2)

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion }) {
  const { reservas } = casos;

  api(app, 'post', '/reservas', requiere('agente'), validacion.cuerpo('ReservaCrear'), async (req, res) => {
    const r = await reservas.reservar(req.actor, req.body || {}, req.get('idempotency-key'));
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida)
      await audita(req, 'reservar', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, vpc: r.reserva.vpc, ticket: r.reserva.ticket });
    return res.status(r.repetida ? 200 : 201).json({ ...r.reserva, repetida: r.repetida });
  });

  api(app, 'get', '/reservas', requiere('lector'), async (req, res) => {
    const r = await reservas.listar({
      estado: texto(req.query.estado),
      pool: texto(req.query.pool),
      solicitante: texto(req.query.solicitante),
      limite: texto(req.query.limite),
    });
    return r.ok ? res.json(r.reservas) : enviarFallo(res, r);
  });

  api(app, 'get', '/reservas/:id', requiere('lector'), async (req, res) => {
    const r = await reservas.obtener(req.params.id);
    return r.ok ? res.json(r.reserva) : enviarFallo(res, r);
  });

  api(app, 'post', '/reservas/:id/confirmar', requiere('admin'), validacion.cuerpo('ReservaConfirmar', { opcional: true }), async (req, res) => {
    const r = await reservas.confirmar(req.actor, req.params.id, req.body || {});
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida)
      await audita(req, 'confirmar_reserva', {
        reserva: r.reserva.id,
        cidr: r.reserva.cidr,
        pool: r.reserva.pool_id,
        ticket: r.reserva.ticket,
        ...r.aprobacion,
      });
    return res.json({ ...r.reserva, asignacion: r.asignacion, repetida: r.repetida });
  });

  // ---------- Reserva en grupo (clúster GKE): todo o nada ----------
  const { reservasGrupo, poolUso } = casos;
  api(app, 'post', '/reservas/lote', requiere('agente'), validacion.cuerpo('LoteCrear'), async (req, res) => {
    const simular = req.query.simular === 'true';
    const r = await reservasGrupo.reservarLote(req.actor, req.body || {}, req.get('idempotency-key'), { simular });
    if (!r.ok) return enviarFallo(res, r);
    if (r.simulacion) return res.json({ simulacion: true, rangos: r.rangos });
    if (!r.repetida)
      await audita(req, 'reservar_grupo', {
        grupo: r.grupo.grupo,
        ticket: r.grupo.ticket,
        rangos: r.grupo.rangos.map((x) => ({ cidr: x.cidr, pool: x.pool_id, rango: x.rango })),
      });
    return res.status(r.repetida ? 200 : 201).json({ grupo: r.grupo, repetida: r.repetida });
  });

  api(app, 'get', '/reservas/grupo/:id', requiere('lector'), async (req, res) => {
    const r = await reservasGrupo.obtenerGrupo(req.params.id);
    return r.ok ? res.json(r.grupo) : enviarFallo(res, r);
  });

  api(app, 'post', '/reservas/grupo/:id/confirmar', requiere('admin'), validacion.cuerpo('ReservaConfirmar', { opcional: true }), async (req, res) => {
    const r = await reservasGrupo.confirmarGrupo(req.actor, req.params.id, req.body || {});
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida)
      await audita(req, 'confirmar_grupo', { grupo: req.params.id, ticket: r.grupo.ticket, rangos: r.grupo.rangos.map((x) => x.cidr), ...r.aprobacion });
    return res.json({ grupo: r.grupo, repetida: r.repetida, aprobacion: r.aprobacion });
  });

  api(app, 'delete', '/reservas/grupo/:id', requiere('agente'), async (req, res) => {
    const r = await reservasGrupo.liberarGrupo(req.actor, req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'liberar_grupo', { grupo: req.params.id, rangos: r.grupo.rangos.map((x) => x.cidr), asignaciones_borradas: r.asignaciones_borradas });
    return res.json({ grupo: r.grupo, asignaciones_borradas: r.asignaciones_borradas });
  });

  // ---------- Qué pool corresponde a cada ambiente y uso ----------
  api(app, 'get', '/pool-uso', requiere('lector'), async (_req, res) => res.json((await poolUso.listar()).filas));
  api(app, 'put', '/pool-uso/:ambiente/:uso', requiere('admin'), validacion.cuerpo('PoolUsoGuardar'), async (req, res) => {
    const r = await poolUso.guardar(req.params.ambiente, req.params.uso, req.body.pool);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'asignar_pool_uso', { ambiente: req.params.ambiente, uso: req.params.uso, pool: req.body.pool });
    return res.json(r.fila);
  });
  api(app, 'delete', '/pool-uso/:ambiente/:uso', requiere('admin'), async (req, res) => {
    const r = await poolUso.borrar(req.params.ambiente, req.params.uso);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'quitar_pool_uso', { ambiente: req.params.ambiente, uso: req.params.uso });
    return res.json({});
  });

  api(app, 'delete', '/reservas/:id', requiere('agente'), async (req, res) => {
    const r = await reservas.liberar(req.actor, req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida)
      await audita(req, 'liberar_reserva', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, asignacion_borrada: r.asignacionBorrada });
    return res.json({ ...r.reserva, repetida: r.repetida, asignacion_borrada: r.asignacionBorrada });
  });
}

module.exports = { montar };
