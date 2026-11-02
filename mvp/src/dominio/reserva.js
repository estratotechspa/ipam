// @ts-check
'use strict';
// Ciclo de vida de una reserva tentativa. Reglas puras: sin base de datos, sin red, sin reloj propio.
//
//   reservada ──confirmar──▶ confirmada ──liberar──▶ liberada
//       │  ╲                                              ▲
//       │   ╲──── liberar ───────────────────────────────┘
//       └── (vence el plazo, sin confirmar) ──▶ expirada
//
// Regla human-in-the-loop: una reserva NUNCA se vuelve asignación definitiva sin una confirmación explícita
// (que en el flujo de agentes llega después de que una persona aprobó el cambio) y una reserva sin confirmar expira sola.

const ESTADOS = ['reservada', 'confirmada', 'liberada', 'expirada'];
const CLAVE_IDEM = /^[A-Za-z0-9._:-]{1,128}$/;
const TICKET = /^[A-Za-z0-9._#:/-]{1,64}$/;
const REFERENCIA_MAX = 300;

/**
 * @typedef {{id: string, pool_id: string, cidr: string, vpc: string, solicitante: string, ticket: string,
 *            estado: string, expira_en: Date|string, asignacion_id?: number|string|null}} Reserva
 * @typedef {{nombre: string, rol: string, tipo?: string}} Actor
 */

/** Estado real en este instante: una reserva «reservada» cuyo plazo ya pasó está expirada aunque nadie la haya barrido todavía. */
const estadoEfectivo = (/** @type {Reserva} */ r, /** @type {Date} */ ahora) =>
  r.estado === 'reservada' && new Date(r.expira_en).getTime() <= ahora.getTime() ? 'expirada' : r.estado;

/** Solo el dueño o un admin opera sobre una reserva. */
/** Quien figura como solicitante de las reservas que crea el webhook de Jira (no es una persona: la aprobación la da un admin). */
const SOLICITANTE_JIRA = 'jira-webhook';

const puedeOperar = (/** @type {Actor} */ actor, /** @type {{solicitante: string}} */ reserva) => actor.rol === 'admin' || actor.nombre === reserva.solicitante;

/**
 * Plazo de la reserva en horas. Se rechaza (no se recorta en silencio) lo que supera el máximo.
 * @param {unknown} pedido  @param {{defecto: number, max: number}} limites
 * @returns {{ok: true, horas: number} | {ok: false, error: string, mensaje: string}}
 */
function validarTtl(pedido, { defecto, max }) {
  if (pedido === undefined || pedido === null || pedido === '') return { ok: true, horas: defecto };
  const n = Number(pedido);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'ttl_invalido', mensaje: 'ttl_horas debe ser un número entero de horas, de 1 en adelante.' };
  if (n > max) return { ok: false, error: 'ttl_excede_maximo', mensaje: `ttl_horas no puede superar ${max} horas (recibido ${n}).` };
  return { ok: true, horas: n };
}

/** @param {unknown} v */
function validarClaveIdem(v) {
  if (v === undefined || v === null || v === '') return { ok: true, clave: null };
  const s = String(v);
  return CLAVE_IDEM.test(s)
    ? { ok: true, clave: s }
    : {
        ok: false,
        error: 'clave_idem_invalida',
        mensaje: 'Idempotency-Key admite 1 a 128 caracteres: letras, números, punto, guion, guion bajo y dos puntos.',
      };
}

/** @param {unknown} v */
function validarTicket(v) {
  if (v === undefined || v === null || v === '') return { ok: true, ticket: null };
  const s = String(v).trim();
  return TICKET.test(s)
    ? { ok: true, ticket: s }
    : { ok: false, error: 'ticket_invalido', mensaje: 'ticket admite hasta 64 caracteres: letras, números y . _ # : / -' };
}

/**
 * Entre los pools candidatos de un ambiente y tipo: uno solo → ese; ninguno o varios → hay que devolver las opciones (422).
 * @template T @param {T[]} candidatos
 * @returns {{tipo: 'unico', pool: T} | {tipo: 'ninguno'} | {tipo: 'ambiguo', opciones: T[]}}
 */
function resolverPool(candidatos) {
  if (candidatos.length === 1) return { tipo: 'unico', pool: candidatos[0] };
  if (candidatos.length === 0) return { tipo: 'ninguno' };
  return { tipo: 'ambiguo', opciones: candidatos };
}

/**
 * Si la misma clave de idempotencia ya existe: ¿se repite la respuesta o se rechaza?
 *  - reserva viva (reservada vigente o confirmada) → se repite (200, repetida: true);
 *  - reserva liberada o expirada → 409: nunca se «resucita» con la misma clave (usa una clave nueva).
 * @param {string} estadoEfectivoExistente
 */
const decidirIdempotencia = (estadoEfectivoExistente) =>
  estadoEfectivoExistente === 'reservada' || estadoEfectivoExistente === 'confirmada' ? 'repetir' : 'rechazar';

/**
 * ¿La petición repetida es «la misma»? Compara lo que el agente indicó (lo que no indicó no cuenta).
 * @param {{pool_id: string, cidr: string, vpc: string, vlan?: number|null, vlan_nombre?: string|null, ticket?: string|null}} existente
 * @param {{pool?: string|null, cidr?: string|null, mascara?: number|null, vpc: string, vlan?: number|null, vlan_nombre?: string|null, ticket?: string|null}} peticion
 */
const mismaPeticion = (existente, peticion) =>
  existente.vpc === peticion.vpc &&
  (!peticion.pool || existente.pool_id === peticion.pool) &&
  (!peticion.cidr || existente.cidr === peticion.cidr) &&
  (!peticion.mascara || Number(existente.cidr.split('/')[1]) === peticion.mascara) &&
  (!peticion.vlan || existente.vlan === peticion.vlan) &&
  (!peticion.vlan_nombre || existente.vlan_nombre === peticion.vlan_nombre) &&
  (!peticion.ticket || existente.ticket === peticion.ticket);

/** Qué hacer al confirmar. @param {string} efectivo @returns {{accion: 'confirmar'|'repetida'|'rechazar', estado?: string}} */
function decidirConfirmacion(efectivo) {
  if (efectivo === 'reservada') return { accion: 'confirmar' };
  if (efectivo === 'confirmada') return { accion: 'repetida' };
  return { accion: 'rechazar', estado: efectivo };
}

/** Qué hacer al liberar. @param {string} efectivo @returns {{accion: 'liberar'|'borrar_asignacion'|'repetida'}} */
function decidirLiberacion(efectivo) {
  if (efectivo === 'reservada') return { accion: 'liberar' };
  if (efectivo === 'confirmada') return { accion: 'borrar_asignacion' };
  return { accion: 'repetida' }; // ya estaba liberada o expirada: idempotente
}

/**
 * Datos de aprobación humana que debe traer una confirmación hecha por un agente (token de servicio).
 * Quien confirma desde la interfaz ya ES la persona que aprueba, así que ahí no se exige.
 * @param {{aprobado_por?: unknown, referencia?: unknown}|undefined} cuerpo @param {boolean} exigir
 * @returns {{ok: true, aprobadoPor: string|null, referencia: string|null} | {ok: false, error: string, mensaje: string}}
 */
function validarAprobacion(cuerpo, exigir) {
  const aprobadoPor = cuerpo && typeof cuerpo.aprobado_por === 'string' ? cuerpo.aprobado_por.trim() : '';
  const referencia = cuerpo && typeof cuerpo.referencia === 'string' ? cuerpo.referencia.trim() : '';
  if (referencia.length > REFERENCIA_MAX || aprobadoPor.length > 200)
    return { ok: false, error: 'aprobacion_invalida', mensaje: 'aprobado_por o referencia exceden el largo permitido.' };
  if (exigir && (!aprobadoPor || !referencia)) {
    return {
      ok: false,
      error: 'falta_aprobacion',
      mensaje: 'Confirmar exige aprobación humana: indica aprobado_por (quién aprobó) y referencia (p. ej. la URL del MR aprobado).',
    };
  }
  return { ok: true, aprobadoPor: aprobadoPor || null, referencia: referencia || null };
}

module.exports = {
  ESTADOS,
  estadoEfectivo,
  puedeOperar,
  SOLICITANTE_JIRA,
  validarTtl,
  validarClaveIdem,
  validarTicket,
  resolverPool,
  decidirIdempotencia,
  mismaPeticion,
  decidirConfirmacion,
  decidirLiberacion,
  validarAprobacion,
};
