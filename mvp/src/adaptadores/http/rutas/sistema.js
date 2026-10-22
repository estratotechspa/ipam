'use strict';
// Sondas de salud y datos de la sesión actual.
//  /healthz  → «estoy vivo» (no toca la base): para livenessProbe.
//  /readyz   → «puedo atender»: base alcanzable y esquema al día: para readinessProbe, Cloud Run y healthCheckPath.
const { ruta, api } = require('../registro');
const { VERSION_MINIMA, versionActual } = require('../../persistencia/postgres/esquema');

const con = (promesa, ms) => Promise.race([promesa, new Promise((_, rechazo) => setTimeout(() => rechazo(new Error('timeout')), ms))]);

/** @param {import('express').Express} app @param {{db: any, estado: {apagando: boolean}, log: any}} deps */
function montar(app, { db, estado, log }) {
  ruta(app, 'get', '/healthz', (_q, res) => res.json({ ok: true }));

  ruta(app, 'get', '/readyz', async (_q, res) => {
    if (estado.apagando) return res.status(503).json({ ok: false, motivo: 'apagando' });
    try {
      const version = await con(versionActual(db), 2000);
      if (version < VERSION_MINIMA) return res.status(503).json({ ok: false, motivo: 'esquema_desactualizado', esquema: { version, minima: VERSION_MINIMA } });
      return res.json({ ok: true, esquema: { version, minima: VERSION_MINIMA } });
    } catch (e) {
      log.warn('readyz: base de datos no disponible', e);
      return res.status(503).json({ ok: false, motivo: 'bd_inalcanzable' });
    }
  });

  // Alias histórico de salud (conserva la respuesta de siempre).
  ruta(app, 'get', '/api/health', async (_q, res) => {
    try { await con(db.query('select 1'), 2000); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
}

const MODO = { oidc: 'oidc', basic: 'basic', token: 'token', anonimo: 'none' };

/** Datos de la sesión actual. Va DESPUÉS del middleware de acceso. */
function montarSesion(app) {
  api(app, 'get', '/me', (req, res) => res.json({ modo: MODO[req.actor && req.actor.tipo] || 'none', usuario: req.usuario, nombre: req.nombre || req.usuario, rol: req.rol }));
}

module.exports = { montar, montarSesion };
