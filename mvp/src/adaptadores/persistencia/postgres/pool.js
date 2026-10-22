'use strict';
// Fábrica del pool de conexiones. Solo PostgreSQL estándar: nada propio de un proveedor.
//  - TLS con la semántica de libpq (la misma que psql): disable | require (cifra, sin verificar) | verify-full.
//  - Esquema configurable (DATABASE_SCHEMA): se fija con SET en cada conexión nueva (funciona también tras un pooler en modo sesión).
//  - Timeouts explícitos. Un pooler en modo TRANSACCIÓN no es compatible (advisory locks): ver docs/PORTABILIDAD.md.
const { Pool, Client } = require('pg');
const { ErrorDeConfiguracion, IDENTIFICADOR } = require('../../../config');

const PARAMS_SSL = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcompression'];
const EQUIVALENCIAS = { disable: 'disable', require: 'require', 'verify-ca': 'verify-full', 'verify-full': 'verify-full' };

/**
 * Separa la URL de los parámetros de TLS y decide el modo.
 * No usa `new URL()` a propósito: rechaza las URL con host vacío como la del socket de Cloud SQL
 * (postgres://usuario:clave@/base?host=/cloudsql/proyecto:region:instancia).
 */
function resolverConexion(url, modoSsl = '') {
  const texto = String(url || '');
  if (!/^postgres(ql)?:\/\/.+/i.test(texto))
    throw new ErrorDeConfiguracion(['DATABASE_URL no es una URL de PostgreSQL válida (postgres://usuario:clave@host:5432/base).']);
  const i = texto.indexOf('?');
  const base = i === -1 ? texto : texto.slice(0, i);
  const params = new URLSearchParams(i === -1 ? '' : texto.slice(i + 1));
  const deUrl = params.get('sslmode') || '';
  const pedido = modoSsl || deUrl || 'disable';
  const modo = EQUIVALENCIAS[pedido];
  if (!modo) throw new ErrorDeConfiguracion([`Modo TLS «${pedido}» no soportado. Usa disable, require o verify-full.`]);
  for (const p of PARAMS_SSL) params.delete(p);
  const resto = params.toString();
  return { connectionString: resto ? `${base}?${resto}` : base, modo };
}

function opcionesSsl(modo, ca) {
  if (modo === 'disable') return false;
  // «require» = semántica de libpq: cifra el canal SIN verificar el certificado (los pooler de algunos proveedores usan una CA privada).
  // Es una decisión consciente y documentada (docs/LIMITACIONES.md): para verificar, usa DATABASE_SSL=verify-full con DATABASE_SSL_CA.
  // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
  if (modo === 'require') return { rejectUnauthorized: false };
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

const comillas = (esquema) => {
  if (!IDENTIFICADOR.test(esquema)) throw new ErrorDeConfiguracion(['DATABASE_SCHEMA inválido.']);
  return `"${esquema}"`;
};

/** Parámetros de sesión que se fijan en cada conexión (con consultas parametrizadas). */
function prepararSesion(client, bd) {
  return client.query(
    "select set_config('search_path', $1, false), set_config('statement_timeout', $2, false), set_config('idle_in_transaction_session_timeout', $3, false)",
    [comillas(bd.esquema), String(bd.sentenciaTimeoutMs), String(bd.sentenciaTimeoutMs * 2)],
  );
}

/**
 * Pool que deja cada conexión lista (esquema y timeouts de sesión) ANTES de entregarla a quien la pida.
 * Se hace con SET en vez de parámetros de arranque porque algunos pooler no aceptan parámetros de arranque extra.
 * (Hacerlo en el evento «connect» de pg dispara una consulta concurrente: está deprecado y se elimina en pg 9.)
 */
class PoolConSesion extends Pool {
  constructor(opciones, preparar) {
    super(opciones);
    this._preparar = preparar;
    this._listos = new WeakSet();
  }

  async _listo(cliente) {
    if (this._listos.has(cliente)) return;
    await this._preparar(cliente);
    this._listos.add(cliente);
  }

  connect(cb) {
    if (cb) {
      return super.connect((err, cliente, hecho) => {
        if (err) return cb(err, cliente, hecho);
        return this._listo(cliente).then(
          () => cb(null, cliente, hecho),
          (e) => {
            hecho(e);
            cb(e);
          },
        );
      });
    }
    return super.connect().then(async (cliente) => {
      try {
        await this._listo(cliente);
      } catch (e) {
        cliente.release(e);
        throw e;
      }
      return cliente;
    });
  }
}

/** @param {import('../../../config').config['bd']} bd @param {{error: Function, warn: Function}} log */
function crearPool(bd, log) {
  const { connectionString, modo } = resolverConexion(bd.url, bd.ssl);
  const pool = new PoolConSesion(
    {
      connectionString,
      ssl: opcionesSsl(modo, bd.sslCa),
      max: bd.poolMax,
      connectionTimeoutMillis: bd.conexionTimeoutMs,
      idleTimeoutMillis: bd.ociosoMs,
      application_name: 'ipam',
    },
    (cliente) => prepararSesion(cliente, bd),
  );
  // Un error en una conexión ociosa (reinicio de la base) no debe tumbar el proceso.
  pool.on('error', (e) => log.warn('Conexión ociosa con error (se reabrirá sola)', e));
  return pool;
}

/** Cliente suelto (migraciones). */
async function crearCliente(url, bd) {
  const { connectionString, modo } = resolverConexion(url, bd.ssl);
  const client = new Client({
    connectionString,
    ssl: opcionesSsl(modo, bd.sslCa),
    connectionTimeoutMillis: bd.conexionTimeoutMs,
    application_name: 'ipam-migrar',
  });
  await client.connect();
  return client;
}

module.exports = { crearPool, crearCliente, resolverConexion, opcionesSsl, prepararSesion, comillas };
