'use strict';
// Usuarios, auditoría y eventos (lecturas de administración).
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo } = require('../errores');

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion, revalidador }) {
  const { admin } = casos;
  // Usuarios y auditoría (solo admin). Un cambio de rol, una baja o una eliminación rigen para las sesiones abiertas en cuanto se
  // revalidan (SESSION_REVALIDAR_SEG): al instante en esta réplica, y como máximo en ese tiempo en las demás.
  const olvidar = (email) => revalidador && revalidador.olvidar(email);
  api(app, 'get', '/usuarios', requiere('admin'), async (_q, res) => res.json(await admin.usuarios()));
  api(app, 'put', '/usuarios/:email', requiere('admin'), validacion.cuerpo('UsuarioRol'), async (req, res) => {
    const rol = req.body && req.body.rol === null ? null : String((req.body || {}).rol || '');
    const r = await admin.cambiarRol(req.params.email, rol);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    olvidar(r.email);
    await audita(req, 'cambiar_rol', { usuario: r.email, rol: r.rol });
    res.json({ email: r.email, rol: r.rol });
  });
  // Cuentas (solo admin). Camino A (SSO): pre-registrar por correo y dar de baja. Camino B (AUTH_LOCAL): cuentas con clave temporal de un solo uso.
  api(app, 'post', '/usuarios', requiere('admin'), validacion.cuerpo('UsuarioCrear'), async (req, res) => {
    const r = await admin.crearUsuario(req.actor, req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'crear_usuario', { usuario: r.email, rol: r.rol, local: r.local }); // nunca la clave
    const { ok: _ok, ...cuerpo } = r;
    res.status(201).json(cuerpo);
  });
  const accionUsuario = (ruta, metodo, accion, ejecutar) =>
    api(app, metodo, ruta, requiere('admin'), async (req, res) => {
      const r = await ejecutar(req);
      if (!r.ok) return enviarFallo(res, r, { legado: false });
      olvidar(r.email);
      await audita(req, accion, { usuario: r.email });
      const { ok: _ok, ...cuerpo } = r;
      res.json(cuerpo);
    });
  accionUsuario('/usuarios/:email/desactivar', 'post', 'desactivar_usuario', (req) => admin.cambiarActivo(req.actor, req.params.email, false));
  accionUsuario('/usuarios/:email/activar', 'post', 'activar_usuario', (req) => admin.cambiarActivo(req.actor, req.params.email, true));
  accionUsuario('/usuarios/:email/restablecer-clave', 'post', 'restablecer_clave', (req) => admin.restablecerClave(req.params.email));
  accionUsuario('/usuarios/:email', 'delete', 'eliminar_usuario', (req) => admin.eliminarUsuario(req.actor, req.params.email));
  // La propia cuenta local cambia su contraseña (exige la actual).
  api(app, 'post', '/yo/clave', validacion.cuerpo('CambioClave'), async (req, res) => {
    const r = await admin.cambiarClavePropia(req.actor, req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'cambiar_clave', { usuario: r.email });
    res.json({ email: r.email, cambiada: true });
  });
  api(app, 'get', '/auditoria', requiere('admin'), async (req, res) => {
    const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
    res.json(await admin.auditoria({ pool: texto(req.query.pool), cidr: texto(req.query.cidr) }));
  });
  api(app, 'get', '/eventos', async (_q, res) => res.json(await admin.eventos()));
}

module.exports = { montar };
