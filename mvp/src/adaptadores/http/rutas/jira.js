'use strict';
// Integración con Jira: estado de la salida, webhook de entrada (firmado) y simulador para la demo.
const crypto = require('node:crypto');
const { ruta, api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');
const { config } = require('../../../config');

const firmar = (buf) => 'sha256=' + crypto.createHmac('sha256', config.webhookJira.secreto).update(buf).digest('hex');
const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** @param {import('express').Express} app @param {{casos: any, tickets: any, publicador: any}} deps */
function montar(app, { casos, tickets, publicador, validacion }) {
  api(app, 'get', '/jira/estado', (_q, res) => res.json({ activa: tickets.activo(), faltantes: tickets.activo() ? tickets.faltantes() : [] }));

  // Cuerpo esperado: { ticket, ambiente, tipo, mascara, vpc }. Firma: x-hub-signature-256 = sha256=HMAC(body, secreto).
  ruta(app, 'post', '/webhook/jira', async (req, res) => {
    if (!config.webhookJira.secreto) return error(res, 503, 'webhook_deshabilitado', 'El webhook de Jira no está configurado (falta JIRA_WEBHOOK_SECRET).');
    const recibida = String(req.headers['x-hub-signature-256'] || '');
    if (!igual(recibida, firmar(req.raw || Buffer.alloc(0)))) {
      await publicador.publicar('jira_firma_invalida', {});
      return res.status(401).json({ error: 'firma inválida' });
    }
    const forma = validacion.validar('JiraTicket', req.body || {});
    if (!forma.ok) return res.status(400).json({ error: 'faltan campos', detalles: forma.errores });
    const b = req.body;
    const r = await casos.jira.procesarTicket(b);
    if (!r.ok)
      return res
        .status(r.tipo === 'ambiguo' ? 422 : r.tipo === 'conflicto' ? 409 : r.tipo === 'no_encontrado' ? 404 : 400)
        .json({ ticket: b.ticket, error: r.error });
    res.json({ ticket: r.ticket, pool: r.pool, cidr: r.cidr });
  });

  // Simulador para la demo: arma un ticket de Jira, lo firma y lo procesa por el mismo camino del webhook.
  api(app, 'post', '/jira/simular', requiere('solicitante'), validacion.cuerpo('JiraSimular'), async (req, res) => {
    const { ambiente, tipo, mascara, vpc } = req.body || {};
    const cuerpo = Buffer.from(JSON.stringify({ ambiente, tipo, mascara, vpc }));
    const r = await casos.jira.simular({ ambiente, tipo, mascara, vpc }, firmar(cuerpo).slice(0, 23) + '…');
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    res.json({ ticket: r.ticket, pool: r.pool, cidr: r.cidr });
  });
}

module.exports = { montar };
