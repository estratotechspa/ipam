// @ts-check
'use strict';
const { ROLES_USUARIO } = require('../dominio/roles');
const { crearAsignaciones } = require('./asignaciones');
const { crearRespaldo } = require('./respaldo');
const { crearJira } = require('./jira');
const { crearAdministracion } = require('./administracion');
const { crearBarrido } = require('./barrido');
const { crearReservas } = require('./reservas');
const { crearTokens } = require('./tokens');

/** Une todos los casos de uso con sus puertos. @param {any} deps */
function crearCasos({ repo, eventos, auditor, tickets, reloj, config, instancia, generadorToken, contrasenas }) {
  const asignaciones = crearAsignaciones({ repo, eventos, tickets });
  // Jira reserva y la aprobación (confirmar la reserva) lo avisa de vuelta: los dos casos de uso se conocen por este gancho.
  const reservas = crearReservas({ repo, eventos, config, alConfirmar: (...args) => jira.alAprobar(...args) });
  const jira = crearJira({ repo, eventos, auditor, tickets, asignaciones, reservas });
  return {
    asignaciones,
    respaldo: crearRespaldo({ repo, reloj, rolesUsuario: ROLES_USUARIO }),
    jira,
    admin: crearAdministracion({ repo, rolesUsuario: ROLES_USUARIO, contrasenas, cuentasLocales: () => config.auth.cuentasLocales }),
    reservas,
    tokens: crearTokens({ repo, generador: generadorToken, config }),
    barrido: crearBarrido({ repo, eventos, intervaloMs: config.reservas.barredorIntervaloSeg * 1000, instancia }),
  };
}

module.exports = { crearCasos };
