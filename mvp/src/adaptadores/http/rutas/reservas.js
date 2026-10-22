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
    if (!r.repetida) await audita(req, 'reservar', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, vpc: r.reserva.vpc, ticket: r.reserva.ticket });
    return res.status(r.repetida ? 200 : 201).json({ ...r.reserva, repetida: r.repetida });
  });

  api(app, 'get', '/reservas', requiere('lector'), async (req, res) => {
    const r = await reservas.listar({ estado: texto(req.query.estado), pool: texto(req.query.pool), solicitante: texto(req.query.solicitante), limite: texto(req.query.limite) });
    return r.ok ? res.json(r.reservas) : enviarFallo(res, r);
  });

  api(app, 'get', '/reservas/:id', requiere('lector'), async (req, res) => {
    const r = await reservas.obtener(req.params.id);
    return r.ok ? res.json(r.reserva) : enviarFallo(res, r);
  });

  api(app, 'post', '/reservas/:id/confirmar', requiere('agente'), validacion.cuerpo('ReservaConfirmar', { opcional: true }), async (req, res) => {
    const r = await reservas.confirmar(req.actor, req.params.id, req.body || {});
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida) await audita(req, 'confirmar_reserva', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, ticket: r.reserva.ticket, ...r.aprobacion });
    return res.json({ ...r.reserva, asignacion: r.asignacion, repetida: r.repetida });
  });

  api(app, 'delete', '/reservas/:id', requiere('agente'), async (req, res) => {
    const r = await reservas.liberar(req.actor, req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    if (!r.repetida) await audita(req, 'liberar_reserva', { reserva: r.reserva.id, cidr: r.reserva.cidr, pool: r.reserva.pool_id, asignacion_borrada: r.asignacionBorrada });
    return res.json({ ...r.reserva, repetida: r.repetida, asignacion_borrada: r.asignacionBorrada });
  });
}

module.exports = { montar };
