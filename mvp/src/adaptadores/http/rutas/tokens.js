'use strict';
// Tokens de servicio: solo los administra un admin. El token en claro se muestra una sola vez (al crearlo).
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo } = require('../errores');

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita }) {
  const { tokens } = casos;

  api(app, 'post', '/tokens', requiere('admin'), async (req, res) => {
    const r = await tokens.crear(req.actor, req.body || {});
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'crear_token', { token: r.meta.nombre, id: r.meta.id, rol: r.meta.rol, expira_en: r.meta.expira_en }); // nunca el token
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ...r.meta, token: r.token });
  });

  api(app, 'get', '/tokens', requiere('admin'), async (_q, res) => {
    const r = await tokens.listar();
    return res.json(r.tokens);
  });

  api(app, 'delete', '/tokens/:id', requiere('admin'), async (req, res) => {
    const r = await tokens.revocar(req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'revocar_token', { token: r.token.nombre, id: r.token.id });
    return res.json(r.token);
  });
}

module.exports = { montar };
