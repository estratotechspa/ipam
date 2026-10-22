'use strict';
// Ayudas para las pruebas de integración (no es una prueba). Cada archivo de prueba trabaja en su PROPIA base de datos
// temporal, creada a partir de DATABASE_URL: así los archivos no se pisan entre sí y se pueden repetir sin limpiar nada.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');

const RAIZ = path.join(__dirname, '..', '..');
const SQL = (n) => fs.readFileSync(path.join(RAIZ, 'db', n), 'utf8');
const hayBase = !!process.env.DATABASE_URL;

const conBase = (url, nombre) => { const u = new URL(url); u.pathname = `/${nombre}`; return u.toString(); };

/** Crea una base vacía y devuelve { url, sql(texto, params), aplicarEsquema(), aplicarSemilla(), borrar() }. */
async function crearBaseAislada({ esquema = true, semilla = true } = {}) {
  const admin = new Client({ connectionString: conBase(process.env.DATABASE_URL, 'postgres') });
  await admin.connect();
  const nombre = `ipam_t_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`create database ${nombre}`);
  const url = conBase(process.env.DATABASE_URL, nombre);
  const c = new Client({ connectionString: url });
  await c.connect();
  const base = {
    url, nombre,
    sql: (t, p) => c.query(t, p),
    aplicar: (texto) => c.query(texto),
    aplicarEsquema: () => c.query(SQL('schema.sql')),
    aplicarSemilla: () => c.query(SQL('seed.sql')),
    async borrar() {
      await c.end().catch(() => {});
      await admin.query(`drop database if exists ${nombre} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
  if (esquema) await base.aplicarEsquema();
  if (esquema && semilla) await base.aplicarSemilla();
  return base;
}

// Se prueba en todas las interfaces (como escucha el servicio) para no elegir un puerto que otro proceso ya usa en «::».
const puertoLibre = () => new Promise((ok, mal) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', mal); });
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Lanza `node src/server.js` como proceso aparte con el entorno indicado (no hereda variables del IPAM).
 * Devuelve { url, puerto, proceso, logs(), parar(senal), salida: Promise<{codigo, senal}> }.
 */
async function lanzarServicio(env, opciones = {}) {
  // Entre elegir un puerto libre y que el servicio lo abra, otro proceso puede ganarle: si pasa, se reintenta con otro puerto.
  for (let intento = 1; ; intento++) {
    try { return await lanzarUnaVez(env, opciones); } catch (e) {
      if (intento >= 5 || !/EADDRINUSE/.test(String(e.message))) throw e;
    }
  }
}

async function lanzarUnaVez(env, { esperar = true } = {}) {
  const puerto = await puertoLibre();
  const limpio = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE|APP_|OIDC_|SESSION_|ALLOW_|ROL$|NODE_ENV|PORT|JIRA|METRICS|RATE_|CUOTA|RESERVA|MIGRAR|EVENTOS|OTEL|TRUST|LOG_|LIMITE|BARREDOR|COOKIE|DB_|TOKEN_|CONFIRMACION|HSTS|APAGADO|SOLICITUD|JSON_)/.test(k)));
  const proceso = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { env: { ...limpio, PORT: String(puerto), LOG_LEVEL: 'info', NODE_OPTIONS: '--throw-deprecation', RATE_LIMIT_POR_MINUTO: '100000', RATE_LIMIT_ESCRITURA_POR_MINUTO: '100000', RATE_LIMIT_IP_POR_MINUTO: '100000', RATE_LIMIT_AUTH_FALLOS_POR_MINUTO: '100000', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let texto = '';
  proceso.stdout.on('data', (d) => { texto += d; });
  proceso.stderr.on('data', (d) => { texto += d; });
  const salida = new Promise((ok) => proceso.on('exit', (codigo, senal) => ok({ codigo, senal })));
  const servicio = {
    puerto, url: `http://127.0.0.1:${puerto}`, proceso, salida,
    logs: () => texto.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { mensaje: l }; } }),
    crudo: () => texto,
    parar: async (senal = 'SIGTERM') => { if (proceso.exitCode === null) proceso.kill(senal); return salida; },
  };
  if (esperar) {
    const limite = Date.now() + 40000;
    while (Date.now() < limite) {
      if (proceso.exitCode !== null) throw new Error(`El servicio terminó al arrancar (código ${proceso.exitCode}):\n${texto}`);
      if (/IPAM escuchando/.test(texto)) break;
      await dormir(50);
    }
    if (!/IPAM escuchando/.test(texto)) { proceso.kill('SIGKILL'); throw new Error(`El servicio no arrancó a tiempo:\n${texto}`); }
  }
  return servicio;
}

module.exports = { hayBase, crearBaseAislada, lanzarServicio, puertoLibre, dormir, RAIZ, SQL, conBase };
