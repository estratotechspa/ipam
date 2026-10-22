'use strict';
// Usuarios, auditoría y eventos (lecturas de administración).
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo } = require('../errores');

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion }) {
  const { admin } = casos;
  // Usuarios y auditoría (solo admin). El rol asignado rige desde el próximo inicio de sesión del usuario.
  api(app, 'get', '/usuarios', requiere('admin'), async (_q, res) => res.json(await admin.usuarios()));
  api(app, 'put', '/usuarios/:email', requiere('admin'), validacion.cuerpo('UsuarioRol'), async (req, res) => {
    const rol = req.body && req.body.rol === null ? null : String((req.body || {}).rol || '');
    const r = await admin.cambiarRol(req.params.email, rol);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'cambiar_rol', { usuario: r.email, rol: r.rol });
    res.json({ email: r.email, rol: r.rol });
  });
  api(app, 'get', '/auditoria', requiere('admin'), async (_q, res) => res.json(await admin.auditoria()));
  api(app, 'get', '/eventos', async (_q, res) => res.json(await admin.eventos()));
}

module.exports = { montar };
