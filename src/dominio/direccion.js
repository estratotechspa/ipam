// @ts-check
'use strict';
// Direcciones IP fijas (interfaces de equipos, gateways, VIP…): validación y ubicación. Reglas puras, sin base de datos.
const { parse, n2ip } = require('./cidr');

const ROLES = ['interfaz', 'gateway', 'gestion', 'loopback', 'vip', 'servidor', 'otro'];
const LIMITES = { dispositivo: 80, interfaz: 80, dns: 253, descripcion: 200, excepcion: 200 };
const SIN_CONTROL = /^[^\p{Cc}]*$/u;
const malo = (error, mensaje) => ({ ok: /** @type {false} */ (false), error, mensaje });

/** Texto opcional: recortado, sin caracteres de control y con largo máximo; vacío → null. */
function textoOpcional(v, campo) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: /** @type {true} */ (true), valor: null };
  const t = String(v).trim();
  if (t.length > LIMITES[campo] || !SIN_CONTROL.test(t)) return malo(`${campo}_invalido`, `«${campo}» admite hasta ${LIMITES[campo]} caracteres.`);
  return { ok: /** @type {true} */ (true), valor: t };
}

/** Normaliza una IPv4 («10.0.0.1» o «10.0.0.1/32»). */
function normalizarIp(v) {
  const t = String(v ?? '').trim();
  const c = parse(t.includes('/') ? t : `${t}/32`);
  if (!c || c.len !== 32) return null;
  return n2ip(c.start);
}

/** Valida los datos descriptivos (todo menos la IP). Sirve para crear y para editar. */
function validarDatos(e) {
  /** @type {{dispositivo: string|null, interfaz: string|null, dns: string|null, descripcion: string|null, excepcion: string|null}} */
  const datos = { dispositivo: null, interfaz: null, dns: null, descripcion: null, excepcion: null };
  for (const campo of Object.keys(LIMITES)) {
    const r = textoOpcional(e[campo], campo);
    if (!r.ok) return r;
    datos[campo] = r.valor;
  }
  const rol = e.rol === undefined || e.rol === null || e.rol === '' ? 'interfaz' : String(e.rol).trim().toLowerCase();
  if (!ROLES.includes(rol)) return malo('rol_invalido', `El rol debe ser uno de: ${ROLES.join(', ')}.`);
  return { ok: /** @type {true} */ (true), datos: { ...datos, rol } };
}

/** Valida una dirección nueva. */
function validarDireccion(e) {
  const ip = normalizarIp(e.ip);
  if (!ip) return malo('ip_invalida', 'IP inválida: escribe una IPv4 como 10.20.0.1.');
  const d = validarDatos(e);
  if (!d.ok) return d;
  return { ok: /** @type {true} */ (true), datos: { ip, ...d.datos } };
}

/** Aviso (no error) si la IP es la dirección de red o de difusión de su segmento (en bloques de /30 o más grandes). */
function avisoDeSegmento(ip, cidrSegmento) {
  const c = parse(cidrSegmento);
  const n = parse(`${ip}/32`);
  if (!c || !n || c.len > 30) return null;
  if (n.start === c.start) return `${ip} es la dirección de red de ${cidrSegmento}; normalmente no se asigna a una interfaz.`;
  if (n.start === c.end) return `${ip} es la dirección de difusión (broadcast) de ${cidrSegmento}; normalmente no se asigna a una interfaz.`;
  return null;
}

module.exports = { ROLES, validarDireccion, validarDatos, normalizarIp, avisoDeSegmento };
