'use strict';
// Protección contra SSRF (Server-Side Request Forgery: que el servidor sea usado para llegar a redes internas).
// Se bloquean destinos privados, de loopback, enlace local y de metadatos de nube, salvo una lista explícita de hosts permitidos.
const net = require('node:net');
const dns = require('node:dns');

const bloqueadas = new net.BlockList();
for (const [red, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) bloqueadas.addSubnet(red, bits, 'ipv4');
for (const [red, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) bloqueadas.addSubnet(red, bits, 'ipv6');

const NOMBRES_BLOQUEADOS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

/** Si es una dirección IPv6 que lleva una IPv4 dentro (::ffff:a.b.c.d o 64:ff9b::a.b.c.d), devuelve esa IPv4. */
function ipv4Incrustada(ip) {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return null;
}

/** ¿Esta dirección IP es un destino prohibido? @param {string} ip */
function esDireccionBloqueada(ip) {
  const limpia = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const tipo = net.isIP(limpia);
  if (!tipo) return true; // no es una IP: por prudencia, bloqueada
  if (tipo === 6) {
    const v4 = ipv4Incrustada(limpia);
    if (v4) return bloqueadas.check(v4, 'ipv4');
    return bloqueadas.check(limpia, 'ipv6');
  }
  return bloqueadas.check(limpia, 'ipv4');
}

/**
 * Valida la URL antes de conectar. Devuelve la URL ya parseada o lanza un Error con el motivo.
 * @param {string} texto @param {string[]} permitirHosts
 */
function validarDestino(texto, permitirHosts = []) {
  let u;
  try { u = new URL(texto); } catch { throw new Error('URL de destino inválida'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Solo se permiten destinos http o https');
  if (u.username || u.password) throw new Error('La URL de destino no puede llevar credenciales');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const permitido = permitirHosts.includes(host);
  if (!permitido && NOMBRES_BLOQUEADOS.has(host)) throw new Error(`Destino bloqueado (SSRF): ${host}`);
  if (net.isIP(host) && !permitido && esDireccionBloqueada(host)) throw new Error(`Destino bloqueado (SSRF): ${host}`);
  return u;
}

/**
 * `lookup` para http.request: resuelve el nombre y descarta direcciones prohibidas. Como la conexión usa la IP ya
 * validada, un DNS que cambie de respuesta entre la validación y la conexión (rebinding) no sirve para engañarla.
 */
function lookupSeguro(permitirHosts = []) {
  return (hostname, opciones, cb) => {
    dns.lookup(hostname, { ...opciones, all: true, verbatim: true }, (err, direcciones) => {
      if (err) return cb(err);
      const permitido = permitirHosts.includes(String(hostname).toLowerCase());
      const buenas = direcciones.filter((d) => permitido || !esDireccionBloqueada(d.address));
      if (!buenas.length) return cb(new Error(`Destino bloqueado (SSRF): ${hostname}`));
      if (opciones && opciones.all) return cb(null, buenas);
      return cb(null, buenas[0].address, buenas[0].family);
    });
  };
}

module.exports = { esDireccionBloqueada, validarDestino, lookupSeguro };
