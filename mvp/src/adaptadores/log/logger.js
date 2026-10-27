'use strict';
// Logger a stdout en JSON estructurado (una línea por evento). Redacta credenciales automáticamente.
// Campos habituales: nivel, mensaje, request_id, trace_id, actor, ruta, metodo, estado, duracion_ms.
const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };
const CLAVES_SECRETAS = /pass(word|wd)?|secret|token|authorization|cookie|credential|api[_-]?key|clave|firma|signature|hash|database_?url|dsn/i;
const REDACTADO = '[REDACTADO]';

// Patrones que delatan una credencial aunque aparezca dentro de un texto cualquiera.
const PATRONES = [
  [/ipam_[A-Za-z0-9_-]{20,}/g, 'ipam_[REDACTADO]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:***@'], // postgres://usuario:clave@host
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTADO]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT-REDACTADO]'],
  [/(sha256=)[a-f0-9]{16,}/gi, '$1[REDACTADO]'],
  [/(password|passwd|pwd|secret|token|api[_-]?key)=([^&\s]+)/gi, '$1=[REDACTADO]'],
];

/** Redacta un texto. */
function redactarTexto(t) {
  let s = String(t);
  for (const [re, reemplazo] of PATRONES) s = s.replace(re, reemplazo);
  return s;
}

/** Copia profunda con credenciales ocultas (por nombre de campo y por patrón de contenido). */
function redactar(valor, profundidad = 0) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return redactarTexto(valor);
  if (typeof valor !== 'object') return valor;
  if (profundidad > 6) return '[profundidad máxima]';
  if (valor instanceof Error) return redactar(serializarError(valor), profundidad + 1);
  if (Buffer.isBuffer(valor)) return `[Buffer ${valor.length} bytes]`;
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.slice(0, 50).map((x) => redactar(x, profundidad + 1));
  const o = {};
  for (const [k, v] of Object.entries(valor)) o[k] = CLAVES_SECRETAS.test(k) ? REDACTADO : redactar(v, profundidad + 1);
  return o;
}

function serializarError(e) {
  return { tipo: e.name, mensaje: e.message, codigo: e.code, pila: e.stack ? String(e.stack).split('\n').slice(0, 8).join('\n') : undefined };
}

/**
 * @param {{nivel?: string, salida?: {write: (s: string) => unknown}, base?: object, contexto?: () => object}} opciones
 */
function crearLogger({ nivel = 'info', salida = process.stdout, base = {}, contexto = () => ({}) } = {}) {
  const minimo = NIVELES[nivel] ?? NIVELES.info;
  const escribir = (n, mensaje, campos) => {
    if (NIVELES[n] < minimo) return;
    const extra = campos instanceof Error ? { error: campos } : campos || {};
    const linea = { ts: new Date().toISOString(), nivel: n, mensaje: redactarTexto(mensaje), ...base, ...contexto(), ...redactar(extra) };
    salida.write(`${JSON.stringify(linea)}\n`);
  };
  const log = {
    debug: (m, c) => escribir('debug', m, c),
    info: (m, c) => escribir('info', m, c),
    warn: (m, c) => escribir('warn', m, c),
    error: (m, c) => escribir('error', m, c),
    hijo: (campos) => crearLogger({ nivel, salida, base: { ...base, ...campos }, contexto }),
  };
  return log;
}

module.exports = { crearLogger, redactar, redactarTexto, REDACTADO };
