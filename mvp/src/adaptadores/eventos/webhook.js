'use strict';
// Adaptador «webhook» del puerto PublicadorEventos: envía cada evento por HTTP POST firmado (HMAC-SHA256).
// Seguridad: protección SSRF, sin seguir redirecciones, timeouts, reintentos acotados con retroceso, sin secretos en logs.
// Es de mejor esfuerzo: si el proceso se apaga con envíos pendientes, esos eventos se pierden (la tabla `eventos` es la fuente de verdad).
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { validarDestino, lookupSeguro } = require('./ssrf');

const MAX_PENDIENTES = 200;

/** Firma = HMAC-SHA256(`${timestamp}.${cuerpo}`) en hexadecimal. El receptor debe recalcularla y comparar en tiempo constante. */
const firmar = (secreto, timestamp, cuerpo) => crypto.createHmac('sha256', secreto).update(`${timestamp}.${cuerpo}`).digest('hex');

function enviarUnaVez({ url, cuerpo, cabeceras, timeoutMs, permitirHosts }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = validarDestino(url, permitirHosts);
    } catch (e) {
      return reject(Object.assign(e, { definitivo: true }));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'POST', headers: { ...cabeceras, 'Content-Length': Buffer.byteLength(cuerpo) }, timeout: timeoutMs, lookup: lookupSeguro(permitirHosts) },
      (res) => {
        res.resume(); // el cuerpo de la respuesta no interesa
        res.on('end', () => {
          // Redirecciones (3xx) NO se siguen: se tratan como fallo definitivo (podrían apuntar a una red interna).
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.statusCode);
          const transitorio = res.statusCode === 429 || res.statusCode >= 500;
          reject(Object.assign(new Error(`El destino respondió ${res.statusCode}`), { definitivo: !transitorio }));
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Tiempo de espera agotado'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e.definitivo ? e : Object.assign(e, { definitivo: /bloqueado/i.test(e.message) })));
    req.end(cuerpo);
  });
}

/** @param {{url: string, secreto: string, permitirHosts: string[], timeoutMs: number, reintentos: number}} cfg @param {{warn: Function}} log */
function crearWebhook(cfg, log, { espera = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  let pendientes = 0;
  async function entregar(tipo, detalle) {
    const id = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const cuerpo = JSON.stringify({ id, tipo, ts: new Date().toISOString(), detalle });
    const cabeceras = {
      'Content-Type': 'application/json',
      'User-Agent': 'ipam-eventos/1',
      'X-IPAM-Event': tipo,
      'X-IPAM-Delivery': id,
      'X-IPAM-Timestamp': timestamp,
      'X-IPAM-Signature': `sha256=${firmar(cfg.secreto, timestamp, cuerpo)}`,
    };
    for (let n = 1; n <= cfg.reintentos; n++) {
      try {
        await enviarUnaVez({ url: cfg.url, cuerpo, cabeceras, timeoutMs: cfg.timeoutMs, permitirHosts: cfg.permitirHosts });
        return true;
      } catch (e) {
        if (e.definitivo || n === cfg.reintentos) {
          log.warn('Evento no entregado por webhook', { evento: tipo, entrega: id, intentos: n, motivo: e.message });
          return false;
        }
        await espera(Math.min(5000, 500 * 2 ** (n - 1)));
      }
    }
    return false;
  }
  return {
    /** Encola y vuelve de inmediato: un destino lento no frena a la API. Para pruebas, `entregar` devuelve la promesa. */
    async publicar(tipo, detalle = {}) {
      if (pendientes >= MAX_PENDIENTES) {
        log.warn('Cola de webhooks llena: evento descartado', { evento: tipo });
        return;
      }
      pendientes += 1;
      entregar(tipo, detalle).finally(() => {
        pendientes -= 1;
      });
    },
    entregar,
    pendientes: () => pendientes,
  };
}

module.exports = { crearWebhook, firmar, enviarUnaVez };
