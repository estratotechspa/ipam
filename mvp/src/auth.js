'use strict';
// Alias de compatibilidad: la autenticación vive ahora en adaptadores/auth/ y las reglas de roles en dominio/roles.js.
const { config, ErrorDeConfiguracion } = require('./config');
const roles = require('./dominio/roles');
const S = require('./adaptadores/auth/sesion');
const { requiere } = require('./adaptadores/auth/acceso');

const modo = () => config.auth.modo;
const resolverRol = (claims, fila) => roles.resolverRol(claims, fila, config.auth.oidc);
const dominioPermitido = (claims) => roles.dominioPermitido(claims, config.auth.oidc.dominios);

function validarConfiguracion() {
  const { errores } = require('./config').validar();
  const propios = errores.filter((e) => /OIDC|SESSION_SECRET|PUBLIC_URL/.test(e));
  if (propios.length) throw new ErrorDeConfiguracion(propios);
}

module.exports = { ROLES: roles.ROLES_USUARIO, tiene: roles.tiene, modo, requiere, resolverRol, dominioPermitido, validarConfiguracion, sellar: S.sellar, abrir: S.abrir };
