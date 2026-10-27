'use strict';
// Integración con Jira: estado de la salida, webhook de entrada (firmado) y simulador para la demo.
const { ruta, api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');
const { config } = require('../../../config');

const { firmar, verificar } = require('../firma-webhook');

// El simulador es solo para demos: en producción hay que pedirlo con ENABLE_SIMULADOR=true.
const simuladorHabilitado = () => !config.produccion || config.jira.simulador;

/** @param {import('express').Express} app @param {{casos: any, tickets: any, publicador: any}} deps */
function montar(app, { casos, tickets, publicador, validacion }) {
  api(app, 'get', '/jira/estado', (_q, res) =>
    res.json({ activa: tickets.activo(), faltantes: tickets.activo() ? tickets.faltantes() : [], simulador: simuladorHabilitado() }),
  );

  // Cuerpo esperado: { ticket, ambiente, tipo, mascara, vpc }. Firma: x-ipam-timestamp + x-hub-signature-256 = sha256=HMAC(secreto, "<ts>.<cuerpo>").
  ruta(app, 'post', '/webhook/jira', async (req, res) => {
    if (!config.webhookJira.secreto) return error(res, 503, 'webhook_deshabilitado', 'El webhook de Jira no está configurado (falta JIRA_WEBHOOK_SECRET).');
    const v = verificar({ secreto: config.webhookJira.secreto, headers: req.headers, cuerpo: req.raw || Buffer.alloc(0) });
    if (!v.ok) {
      await publicador.publicar('jira_firma_invalida', { motivo: v.motivo });
      return res.status(401).json({ error: 'firma inválida', motivo: v.motivo });
    }
    const forma = validacion.validar('JiraTicket', req.body || {});
    if (!forma.ok) return res.status(400).json({ error: 'faltan campos', detalles: forma.errores });
    const b = req.body;
    const r = await casos.jira.procesarTicket(b);
    if (!r.ok)
      return res
        .status(r.tipo === 'ambiguo' ? 422 : r.tipo === 'conflicto' ? 409 : r.tipo === 'no_encontrado' ? 404 : 400)
        .json({ ticket: b.ticket, error: r.error });
    res.json({ ticket: r.ticket, pool: r.pool, cidr: r.cidr, estado: r.estado, reserva: r.reserva, expira_en: r.expira_en });
  });

  // Simulador para la demo: arma un ticket de Jira, lo firma y lo procesa por el mismo camino del webhook.
  api(app, 'post', '/jira/simular', requiere('solicitante'), validacion.cuerpo('JiraSimular'), async (req, res) => {
    if (!simuladorHabilitado()) return error(res, 404, 'simulador_deshabilitado', 'El simulador no está habilitado en este entorno (ENABLE_SIMULADOR=true).');
    const { ambiente, tipo, mascara, vpc } = req.body || {};
    const cuerpo = Buffer.from(JSON.stringify({ ambiente, tipo, mascara, vpc }));
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await casos.jira.simular({ ambiente, tipo, mascara, vpc }, firmar(config.webhookJira.secreto, ts, cuerpo).slice(0, 23) + '…', ts);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    res.json({ ticket: r.ticket, pool: r.pool, cidr: r.cidr, estado: r.estado, reserva: r.reserva, expira_en: r.expira_en });
  });
}

module.exports = { montar };
