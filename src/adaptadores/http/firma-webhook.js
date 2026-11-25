// @ts-check
'use strict';
// Firma del webhook entrante de Jira. La firma cubre el momento Y el cuerpo, para que una petición capturada no se pueda
// reenviar más tarde:
//   x-ipam-timestamp:    segundos desde 1970 (UTC) en que se firmó
//   x-hub-signature-256: sha256=HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")
// Se rechaza lo firmado hace más de 5 minutos (o en el futuro). Un reenvío DENTRO de la ventana es inofensivo: el webhook es
// idempotente por ticket (la reserva usa la clave `jira-<ticket>`), así que devuelve la misma reserva y no crea otra.
const crypto = require('node:crypto');

const VENTANA_SEGUNDOS = 300;

/** @param {string} secreto @param {string} timestamp @param {Buffer} cuerpo */
const firmar = (secreto, timestamp, cuerpo) => 'sha256=' + crypto.createHmac('sha256', secreto).update(`${timestamp}.`).update(cuerpo).digest('hex');

const igual = (/** @type {string} */ a, /** @type {string} */ b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * @param {{secreto: string, headers: Record<string, any>, cuerpo: Buffer, ahoraMs?: number}} p
 * @returns {{ok: true} | {ok: false, motivo: string}}
 */
function verificar({ secreto, headers, cuerpo, ahoraMs = Date.now() }) {
  const ts = String(headers['x-ipam-timestamp'] || '').trim();
  if (!/^\d{9,13}$/.test(ts)) return { ok: false, motivo: 'falta x-ipam-timestamp o no es un número' };
  const segundos = Number(ts) > 1e11 ? Math.floor(Number(ts) / 1000) : Number(ts); // tolera milisegundos
  if (Math.abs(ahoraMs / 1000 - segundos) > VENTANA_SEGUNDOS) return { ok: false, motivo: 'timestamp fuera de la ventana de 5 minutos' };
  if (!igual(String(headers['x-hub-signature-256'] || ''), firmar(secreto, ts, cuerpo))) return { ok: false, motivo: 'firma inválida' };
  return { ok: true };
}

module.exports = { VENTANA_SEGUNDOS, firmar, verificar };
