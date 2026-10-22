// @ts-check
'use strict';
const { ROLES_USUARIO } = require('../dominio/roles');
const { crearAsignaciones } = require('./asignaciones');
const { crearRespaldo } = require('./respaldo');
const { crearJira } = require('./jira');
const { crearAdministracion } = require('./administracion');
const { crearBarrido } = require('./barrido');

/** Une todos los casos de uso con sus puertos. @param {any} deps */
function crearCasos({ repo, eventos, auditor, tickets, reloj, config, instancia }) {
  const asignaciones = crearAsignaciones({ repo, eventos, tickets, reloj });
  return {
    asignaciones,
    respaldo: crearRespaldo({ repo, reloj, rolesUsuario: ROLES_USUARIO }),
    jira: crearJira({ repo, eventos, auditor, tickets, asignaciones }),
    admin: crearAdministracion({ repo, reloj, rolesUsuario: ROLES_USUARIO }),
    barrido: crearBarrido({ repo, eventos, reloj, intervaloMs: config.reservas.barredorIntervaloSeg * 1000, instancia }),
  };
}

module.exports = { crearCasos };
