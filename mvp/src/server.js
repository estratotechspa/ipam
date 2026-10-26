const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const { parse, libres } = require('./cidr');
const jira = require('./jira');
const auth = require('./auth');
const marca = require('./marca');
const limites = require('./limites');

const PORT = process.env.PORT || 8080;
jira.validarSecretoWebhook(); // en producción, sin secreto propio la app no arranca
const WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || jira.SECRETO_DE_EJEMPLO;
const entero = (v, defecto) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : defecto);

// Pool de conexiones: tiempos máximos para que una base lenta o caída no cuelgue las peticiones, y un
// manejador de «error» (sin él, un fallo en una conexión inactiva tumbaría el proceso).
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: entero(process.env.DB_POOL_MAX, 10),
  connectionTimeoutMillis: entero(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
  statement_timeout: entero(process.env.DB_STATEMENT_TIMEOUT_MS, 15000),
  idleTimeoutMillis: 30000,
});
db.on('error', (e) => console.error('pool pg (conexión inactiva):', e.message));
const app = express();
app.disable('x-powered-by');
// Detrás de un ingress/balanceador: TRUST_PROXY=1 (número de saltos) para que req.ip/protocolo sean los reales.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
// Cabeceras de seguridad. La interfaz no usa scripts en línea (todo en /app.js); los estilos en atributo sí.
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
    upgradeInsecureRequests: null,   // el TLS lo termina el ingress del cliente; no forzar https desde la app
  } },
  hsts: process.env.HSTS === 'true',  // solo cuando el acceso es siempre por HTTPS
  referrerPolicy: { policy: 'no-referrer' },
}));
// helmet no trae Permissions-Policy: la interfaz no usa ninguna de estas capacidades del navegador, así que se desactivan.
const PERMISOS = ['accelerometer', 'autoplay', 'camera', 'display-capture', 'geolocation', 'gyroscope', 'magnetometer', 'microphone', 'midi', 'payment', 'usb'];
app.use((_q, res, next) => { res.set('Permissions-Policy', PERMISOS.map((p) => `${p}=()`).join(', ')); next(); });
// Cuerpos JSON: 100 KB por defecto (JSON_LIMIT). Solo la importación de respaldos admite más (IMPORT_LIMIT, 5 MB) y su
// parser va después de la autenticación, para que quien no tiene sesión no pueda hacernos procesar 5 MB.
const guardarCrudo = (req, _res, buf) => { req.raw = buf; };
const jsonGeneral = express.json({ limit: process.env.JSON_LIMIT || '100kb', verify: guardarCrudo });
app.use((req, res, next) => (req.path === '/api/importar' ? next() : jsonGeneral(req, res, next)));
const jsonImportar = express.json({ limit: process.env.IMPORT_LIMIT || '5mb', verify: guardarCrudo });

// Auditoría: nunca bloquea la operación; un fallo queda en el log.
const auditar = (accion, usuario, rol, detalle = {}, ip = null) =>
  db.query('insert into auditoria (usuario, rol, accion, detalle, ip) values ($1,$2,$3,$4,$5)', [usuario, rol, accion, detalle, ip])
    .catch((e) => console.error('auditoría:', e.message));
const audita = (req, accion, detalle) => auditar(accion, req.usuario || 'sistema', req.rol || null, detalle, req.ip);

auth.validarConfiguracion();
auth.montar(app, { db, auditar });
marca.montar(app);
const { requiere } = auth;

// Un error inesperado nunca expone su detalle al cliente: se responde con un id y el detalle completo queda en el log.
const idError = () => crypto.randomBytes(4).toString('hex');
function responderError(req, res, e) {
  const id = idError();
  // Marcadores %s: la URL la controla quien llama y no debe interpretarse como cadena de formato.
  console.error('[error %s] %s %s', id, req.method, req.originalUrl, e);
  if (res.headersSent) return res.destroy(); // p. ej. falló a mitad de una descarga
  res.status(500).json({ error: 'interno', id });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => responderError(req, res, e));
// Registro de eventos: como `auditar`, nunca rompe la operación que lo origina (un fallo queda en el log).
const evento = (tipo, detalle) =>
  db.query('insert into eventos (tipo, detalle) values ($1,$2)', [tipo, detalle]).catch((e) => console.error('evento:', e.message));
const nuevoTicket = async () => (await db.query("select 'NET-' || nextval('ticket_seq') as t")).rows[0].t;

// ---------- Dominio ----------
async function ocupados(poolId) {
  return (await db.query('select cidr::text from asignaciones where pool_id=$1', [poolId])).rows.map((r) => r.cidr);
}

// Devuelve {ok:true, asignacion} | {ok:false, status, error, ...}
// Las asignaciones de un mismo pool se serializan con un bloqueo de transacción; la restricción de
// exclusión de la base queda como respaldo (también cubre inserciones hechas fuera de la API).
const MAX = { vpc: 100, pool: 100, cidr: 50, ticket: 50 };
async function asignar({ pool, vpc, cidr, mascara, solicitante, origen, ticket }) {
  if (typeof vpc !== 'string' || !vpc.trim()) return { ok: false, status: 400, error: 'Indica el proyecto / VPC.' };
  if (vpc.trim().length > MAX.vpc) return { ok: false, status: 400, error: `El proyecto / VPC admite hasta ${MAX.vpc} caracteres.` };
  if (typeof pool !== 'string' || !pool || pool.length > MAX.pool) return { ok: false, status: 400, error: 'Indica un pool válido.' };
  if (cidr != null && (typeof cidr !== 'string' || cidr.length > MAX.cidr)) return { ok: false, status: 400, error: 'CIDR inválido. Formato: 10.64.16.0/22.' };
  const p = (await db.query('select id, cidr::text from pools where id=$1', [pool])).rows[0];
  if (!p) return { ok: false, status: 404, error: `Pool «${pool}» no existe.` };
  const base = parse(p.cidr);

  // Validaciones que no dependen del estado de la base.
  let objetivo = cidr ? String(cidr).trim() : null;
  let c = null;
  if (objetivo) {
    c = parse(objetivo);
    if (!c) return { ok: false, status: 400, error: 'CIDR inválido. Formato: 10.64.16.0/22.' };
    if (!c.aligned) return { ok: false, status: 400, error: `${objetivo} no está alineado: la dirección de red debe ser múltiplo de su tamaño.` };
    if (c.start < base.start || c.end > base.end) return { ok: false, status: 400, error: `${objetivo} queda fuera del pool ${p.cidr}.` };
  } else {
    const len = Number(mascara);
    if (!Number.isInteger(len) || len < base.len || len > 32) return { ok: false, status: 400, error: 'Máscara inválida para este pool.' };
  }

  let resultado;
  const cl = await db.connect();
  try {
    await cl.query('begin');
    await cl.query('select pg_advisory_xact_lock(hashtext($1))', [pool]);
    const ocup = (await cl.query('select cidr::text from asignaciones where pool_id=$1', [pool])).rows.map((r) => r.cidr);
    if (!objetivo) {
      [objetivo] = libres(p.cidr, ocup, Number(mascara), 1);
      if (!objetivo) { await cl.query('rollback'); return { ok: false, status: 409, error: `No quedan segmentos /${mascara} libres en ${pool}.` }; }
      c = parse(objetivo);
    }
    const x = (await cl.query(
      'select cidr::text, vpc, solicitante, ticket, creado_en from asignaciones where pool_id=$1 and cidr && $2::cidr limit 1', [pool, objetivo])).rows[0];
    if (x) {
      await cl.query('rollback');
      return { ok: false, status: 409, error: 'solapamiento', conflicto: x, sugeridos: libres(p.cidr, ocup, c.len, 3) };
    }
    const t = ticket || (await cl.query("select 'NET-' || nextval('ticket_seq') as t")).rows[0].t;
    const r = await cl.query(
      `insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen) values ($1,$2,$3,$4,$5,$6)
       returning id, pool_id, cidr::text, vpc, solicitante, ticket, origen, creado_en`,
      [pool, objetivo, String(vpc).trim(), solicitante, t, origen]);
    await cl.query('commit');
    resultado = { ok: true, asignacion: r.rows[0] };
  } catch (e) {
    await cl.query('rollback').catch(() => {});
    throw e;
  } finally {
    cl.release(); // liberar ANTES de usar el pool de nuevo (evento): evita agotarlo bajo concurrencia
  }
  await evento('asignacion', { cidr: resultado.asignacion.cidr, pool, vpc, ticket: resultado.asignacion.ticket, origen });
  // Jira queda fuera del camino crítico: la asignación ya está confirmada y se responde sin esperar a Jira.
  enSegundoPlano(sincronizarJira(resultado.asignacion));
  return resultado;
}

// Tareas en segundo plano (hoy, solo Jira). Se siguen para poder esperarlas al apagar el servidor y en las pruebas.
const pendientes = new Set();
function enSegundoPlano(promesa) {
  const p = promesa.catch((e) => console.error('segundo plano:', e)).finally(() => pendientes.delete(p));
  pendientes.add(p);
  return p;
}
const esperarSegundoPlano = () => Promise.allSettled([...pendientes]);
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Integración saliente con Jira (apagada por defecto: JIRA_ENABLED=true para activarla). Corre en segundo plano, con
// hasta JIRA_REINTENTOS intentos (3) separados por JIRA_REINTENTO_MS × n (2 s). Un fallo de Jira nunca deshace la
// asignación: el resultado queda en `eventos` (jira_ticket_creado / jira_ticket_actualizado / jira_error).
async function sincronizarJira(a) {
  if (!jira.enabled()) return;
  const falta = jira.faltantes();
  if (falta.length) return evento('jira_error', { ticket: a.ticket, motivo: `Faltan variables: ${falta.join(', ')}` });
  const intentos = Math.max(1, entero(process.env.JIRA_REINTENTOS, 3));
  const espera = entero(process.env.JIRA_REINTENTO_MS, 2000);
  let clave = null;
  let ultimo;
  for (let i = 1; i <= intentos; i++) {
    try {
      if (a.origen === 'jira') await jira.actualizarTicket(a.ticket, a);
      else clave = await jira.crearTicket(a);
      ultimo = null;
      break;
    } catch (e) {
      ultimo = e;
      console.error(`jira (intento ${i}/${intentos}) ticket ${a.ticket}:`, e.message);
      if (i < intentos) await dormir(espera * i);
    }
  }
  if (ultimo) return evento('jira_error', { ticket: a.ticket, motivo: ultimo.message, intentos });
  if (a.origen === 'jira') return evento('jira_ticket_actualizado', { ticket: a.ticket, rango: a.cidr });
  // El ticket ya existe en Jira: si guardar su clave falla, no se reintenta la creación (duplicaría el ticket).
  try {
    await db.query('update asignaciones set ticket=$1 where id=$2', [clave, a.id]);
  } catch (e) {
    console.error('jira: no se pudo guardar la clave', clave, e.message);
    return evento('jira_error', { ticket: a.ticket, motivo: `Ticket ${clave} creado en Jira, pero no se pudo guardar: ${e.message}` });
  }
  return evento('jira_ticket_creado', { ticket: clave, rango: a.cidr });
}

// ---------- API ----------
let cerrando = false;
app.get('/api/health', wrap(async (_q, res) => {
  if (cerrando) return res.status(503).json({ ok: false, error: 'cerrando' }); // el balanceador deja de enviarnos tráfico
  await db.query('select 1');
  res.json({ ok: true });
}));

// Única consulta de uso por pool (la usan /api/pools, /api/resumen y la exportación a Excel).
// total = direcciones del pool; usadas = direcciones asignadas; uso = usadas / total.
const SQL_POOLS = `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones,
       (2^(32-masklen(p.cidr)))::float8 as total, coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 as usadas
  from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`;
const poolsConUso = async (cl = db) =>
  (await cl.query(SQL_POOLS)).rows.map((r) => ({ ...r, uso: r.usadas / r.total, libres: r.total - r.usadas }));

app.get('/api/pools', wrap(async (_q, res) => res.json(await poolsConUso())));

// Se conserva por compatibilidad; la interfaz calcula estos totales a partir de /api/pools.
app.get('/api/resumen', wrap(async (_q, res) => {
  const ps = await poolsConUso();
  res.json({
    pools: ps.length, asignaciones: ps.reduce((n, p) => n + p.asignaciones, 0),
    uso_promedio: ps.length ? ps.reduce((n, p) => n + p.uso, 0) / ps.length : 0,
    pools_sobre_80: ps.filter((p) => p.uso > 0.8).length, libres: ps.reduce((n, p) => n + p.libres, 0),
    // Con la restricción de exclusión, los solapamientos no pueden existir: se informa 0 y se explica en la UI.
    solapamientos: 0,
  });
}));

// Lista paginada de asignaciones. Filtros: pool, ambiente, q (cidr, proyecto/VPC, solicitante o ticket).
// Orden: orden=fecha|cidr|pool|vpc|solicitante|ticket|origen|direcciones y dir=asc|desc (por defecto, lo más nuevo primero).
// limit (por defecto 50, máximo 200) y offset; el total sin paginar va en la cabecera X-Total-Count.
const ORDEN = { fecha: 'a.id', cidr: 'a.cidr', pool: 'a.pool_id', vpc: 'a.vpc', solicitante: 'a.solicitante',
  ticket: 'a.ticket', origen: 'a.origen', direcciones: '(32 - masklen(a.cidr))' };
const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
app.get('/api/asignaciones', wrap(async (req, res) => {
  const q = req.query;
  const una = (k, max) => (q[k] === undefined ? undefined : typeof q[k] === 'string' && q[k].length <= max ? q[k] : null);
  const num = (k, defecto, tope) => {
    if (q[k] === undefined) return defecto;
    return typeof q[k] === 'string' && /^\d{1,9}$/.test(q[k]) ? Math.min(Number(q[k]), tope) : null;
  };
  const limit = num('limit', 50, 200), offset = num('offset', 0, 1e9);
  const pool = una('pool', 100), amb = una('ambiente', 10), texto = una('q', 100), orden = una('orden', 20), dir = una('dir', 4);
  const mal = (m) => res.status(400).json({ error: m });
  if (limit === null || limit < 1) return mal('limit debe ser un entero entre 1 y 200.');
  if (offset === null) return mal('offset debe ser un entero mayor o igual a 0.');
  if (pool === null || texto === null) return mal('pool o q inválidos (máximo 100 caracteres).');
  if (amb !== undefined && !AMBIENTES.includes(amb)) return mal(`ambiente debe ser uno de: ${AMBIENTES.join(', ')}.`);
  if (orden !== undefined && !Object.hasOwn(ORDEN, orden)) return mal(`orden debe ser uno de: ${Object.keys(ORDEN).join(', ')}.`);
  if (dir !== undefined && !['asc', 'desc'].includes(dir)) return mal('dir debe ser asc o desc.');

  const where = [], par = [];
  if (pool) { par.push(pool); where.push(`a.pool_id = $${par.length}`); }
  if (amb) { par.push(amb); where.push(`p.ambiente = $${par.length}`); }
  if (texto && texto.trim()) {
    par.push(`%${texto.trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(a.cidr::text ilike $${par.length} or a.vpc ilike $${par.length} or a.solicitante ilike $${par.length} or a.ticket ilike $${par.length})`);
  }
  const desde = `from asignaciones a join pools p on p.id = a.pool_id ${where.length ? 'where ' + where.join(' and ') : ''}`;
  const sentido = (dir || (orden && orden !== 'fecha' ? 'asc' : 'desc')) === 'asc' ? 'asc' : 'desc';
  const total = (await db.query(`select count(*)::int as n ${desde}`, par)).rows[0].n;
  const filas = (await db.query(
    `select a.id, a.pool_id, p.ambiente, a.cidr::text, a.vpc, a.solicitante, a.ticket, a.origen, a.creado_en ${desde}
      order by ${ORDEN[orden || 'fecha']} ${sentido}, a.id ${sentido} limit ${limit} offset ${offset}`, par)).rows;
  res.set('X-Total-Count', String(total));
  res.json(filas);
}));

// El simulador de tickets es solo para demos: en producción hay que pedirlo con ENABLE_SIMULADOR=true.
const simuladorHabilitado = () => process.env.NODE_ENV !== 'production' || process.env.ENABLE_SIMULADOR === 'true';
app.get('/api/jira/estado', (_q, res) =>
  res.json({ activa: jira.enabled(), faltantes: jira.enabled() ? jira.faltantes() : [], simulador: simuladorHabilitado() }));

// Exporta a Excel todos los segmentos asignados (con los datos de su pool) y la lista de pools.
// Se escribe por streaming (ExcelJS WorkbookWriter) leyendo la base por lotes dentro de una transacción de solo lectura
// con instantánea consistente: la memoria no crece con el número de filas.
const LOTE_EXCEL = 1000;
const hojaExcel = (wb, nombre, columnas) => {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columnas.map(({ key, width, style }) => ({ key, width, style }));
  const cab = ws.addRow(columnas.map((c) => c.header));
  cab.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12203A' } };
  });
  cab.commit();
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columnas.length } };
  return ws;
};
app.get('/api/exportar.xlsx', requiere('lector'), wrap(async (req, res) => {
  const filas = (await db.query('select count(*)::int as n from asignaciones')).rows[0].n;
  await audita(req, 'exportar', { filas });
  const cl = await db.connect();
  try {
    await cl.query('begin transaction isolation level repeatable read read only');
    const pools = await poolsConUso(cl);
    const nombre = `ipam-segmentos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${nombre}"` });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    wb.creator = marca.config().nombre;
    const seg = hojaExcel(wb, 'Segmentos', [
      { header: 'Segmento (CIDR)', key: 'cidr', width: 20 }, { header: 'Máscara', key: 'mascara', width: 9 },
      { header: 'Direcciones', key: 'dir', width: 13, style: { numFmt: '#,##0' } },
      { header: 'Pool', key: 'pool', width: 20 }, { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Ambiente', key: 'amb', width: 10 }, { header: 'Proveedor', key: 'prov', width: 12 },
      { header: 'CIDR del pool', key: 'pcidr', width: 18 }, { header: 'Proyecto / VPC', key: 'vpc', width: 22 },
      { header: 'Solicitó', key: 'sol', width: 16 }, { header: 'Origen', key: 'origen', width: 10 },
      { header: 'Ticket', key: 'ticket', width: 11 }, { header: 'Fecha', key: 'fecha', width: 17, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
    ]);
    for (let desde = 0; ; desde += LOTE_EXCEL) {
      const lote = (await cl.query(
        `select a.pool_id, p.tipo, p.ambiente, p.proveedor, p.cidr::text as pool_cidr, a.cidr::text, a.vpc,
                a.solicitante, a.ticket, a.origen, a.creado_en
           from asignaciones a join pools p on p.id = a.pool_id
          order by p.ambiente desc, a.pool_id, a.cidr, a.id limit $1 offset $2`, [LOTE_EXCEL, desde])).rows;
      for (const r of lote) {
        const len = Number(r.cidr.split('/')[1]);
        seg.addRow({ cidr: r.cidr, mascara: `/${len}`, dir: 2 ** (32 - len), pool: r.pool_id, tipo: r.tipo, amb: r.ambiente,
          prov: r.proveedor, pcidr: r.pool_cidr, vpc: r.vpc, sol: r.solicitante, origen: r.origen, ticket: r.ticket, fecha: r.creado_en }).commit();
      }
      if (lote.length < LOTE_EXCEL) break;
    }
    seg.commit();
    const hp = hojaExcel(wb, 'Pools', [
      { header: 'Pool', key: 'id', width: 20 }, { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Ambiente', key: 'amb', width: 10 }, { header: 'Proveedor', key: 'prov', width: 12 },
      { header: 'CIDR base', key: 'cidr', width: 18 }, { header: 'Asignaciones', key: 'n', width: 13 },
      { header: 'Uso', key: 'uso', width: 9, style: { numFmt: '0.0%' } },
    ]);
    for (const p of pools) hp.addRow({ id: p.id, tipo: p.tipo, amb: p.ambiente, prov: p.proveedor, cidr: p.cidr, n: p.asignaciones, uso: p.uso }).commit();
    hp.commit();
    await wb.commit(); // cierra el archivo y la respuesta
  } finally {
    await cl.query('rollback').catch(() => {});
    cl.release();
  }
}));

// Portabilidad: respaldo lógico completo (pools, asignaciones y roles asignados) para llevar el IPAM a otra infraestructura.
app.get('/api/exportar.json', requiere('admin'), wrap(async (req, res) => {
  const pools = (await db.query('select id, tipo, ambiente, proveedor, cidr::text from pools order by id')).rows;
  const asignaciones = (await db.query(
    'select pool_id, cidr::text, vpc, solicitante, ticket, origen, creado_en from asignaciones order by pool_id, cidr')).rows;
  const usuarios = (await db.query('select email, nombre, rol from usuarios where rol is not null order by email')).rows;
  await audita(req, 'exportar_json', { pools: pools.length, asignaciones: asignaciones.length });
  res.set('Content-Disposition', `attachment; filename="ipam-respaldo-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ formato: 'ipam-respaldo', version: 1, generado: new Date().toISOString(), pools, asignaciones, usuarios });
}));

// Importa un respaldo de /api/exportar.json. Todo o nada: si algún segmento se solapa, no se importa nada.
// Los pools existentes se conservan (no se modifican); las asignaciones repetidas (mismo pool y CIDR) se omiten.
app.post('/api/importar', requiere('admin'), jsonImportar, wrap(async (req, res) => {
  const d = req.body || {};
  if (d.formato !== 'ipam-respaldo' || d.version !== 1 || !Array.isArray(d.pools) || !Array.isArray(d.asignaciones)) {
    return res.status(400).json({ error: 'No es un respaldo de IPAM (formato ipam-respaldo, versión 1).' });
  }
  const AMB = ['dev', 'qa', 'pre', 'prod'];
  for (const p of d.pools) {
    if (!p.id || !p.tipo || !AMB.includes(p.ambiente) || !p.proveedor || !parse(String(p.cidr)) || String(p.id).length > MAX.pool) return res.status(400).json({ error: `Pool inválido: ${JSON.stringify(p).slice(0, 120)}` });
  }
  for (const a of d.asignaciones) {
    const c = parse(String(a.cidr));
    if (!a.pool_id || !a.vpc || !a.ticket || !c || !c.aligned || String(a.vpc).length > MAX.vpc || String(a.ticket).length > MAX.ticket) return res.status(400).json({ error: `Asignación inválida: ${JSON.stringify(a).slice(0, 120)}` });
  }
  const cl = await db.connect();
  const r = { pools: 0, asignaciones: 0, omitidas: 0, usuarios: 0 };
  try {
    await cl.query('begin');
    await cl.query('select pg_advisory_xact_lock(hashtext($1))', ['importar']);
    for (const p of d.pools) {
      r.pools += (await cl.query('insert into pools (id,tipo,ambiente,proveedor,cidr) values ($1,$2,$3,$4,$5) on conflict (id) do nothing', [p.id, p.tipo, p.ambiente, p.proveedor, p.cidr])).rowCount;
    }
    for (const a of d.asignaciones) {
      const origen = ['panel', 'jira', 'semilla'].includes(a.origen) ? a.origen : 'panel';
      const x = await cl.query(
        `insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen,creado_en)
         select $1,$2::cidr,$3,$4,$5,$6,coalesce($7::timestamptz,now())
          where not exists (select 1 from asignaciones where pool_id=$1 and cidr=$2::cidr)
         `, [a.pool_id, a.cidr, a.vpc, a.solicitante || 'importado', a.ticket, origen, a.creado_en || null]);
      if (x.rowCount) r.asignaciones += 1; else r.omitidas += 1;
    }
    for (const u of Array.isArray(d.usuarios) ? d.usuarios : []) {
      if (u.email && auth.ROLES.includes(u.rol)) {
        r.usuarios += (await cl.query('insert into usuarios (email,nombre,rol) values ($1,$2,$3) on conflict (email) do nothing', [String(u.email).toLowerCase(), u.nombre || '', u.rol])).rowCount;
      }
    }
    await cl.query("select setval('ticket_seq', greatest((select last_value from ticket_seq), coalesce((select max(substring(ticket from 5)::int) from asignaciones where ticket ~ '^NET-[0-9]+$'),0)))");
    await cl.query('commit');
  } catch (e) {
    await cl.query('rollback').catch(() => {});
    if (e.code === '23P01' || e.code === '23514' || e.code === '23503') {
      return res.status(409).json({ error: 'Importación rechazada: hay segmentos que se solapan, quedan fuera de su pool o su pool no existe.', detalle: e.message });
    }
    throw e;
  } finally { cl.release(); }
  await audita(req, 'importar', r);
  res.json(r);
}));

app.get('/api/pools/:id/libres', wrap(async (req, res) => {
  const p = (await db.query('select cidr::text from pools where id=$1', [req.params.id])).rows[0];
  if (!p) return res.status(404).json({ error: 'Pool no existe' });
  const len = Number(req.query.mascara);
  if (!Number.isInteger(len) || len < 8 || len > 32) return res.status(400).json({ error: 'mascara inválida' });
  res.json(libres(p.cidr, await ocupados(req.params.id), len, 3));
}));

app.post('/api/solicitudes', requiere('solicitante'), wrap(async (req, res) => {
  const { pool, vpc, cidr, mascara } = req.body || {};
  const r = await asignar({ pool, vpc, cidr, mascara, solicitante: req.usuario || 'panel', origen: 'panel' });
  if (!r.ok) return res.status(r.status).json(r);
  await audita(req, 'asignar', { cidr: r.asignacion.cidr, pool, vpc, ticket: r.asignacion.ticket });
  res.status(201).json(r.asignacion);
}));

app.delete('/api/asignaciones/:id', requiere('admin'), wrap(async (req, res) => {
  const r = await db.query('delete from asignaciones where id=$1 returning cidr::text, ticket, pool_id', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'No existe' });
  await evento('liberacion', r.rows[0]);
  await audita(req, 'liberar', r.rows[0]);
  res.json({ liberado: r.rows[0] });
}));

// Usuarios y auditoría (solo admin). El rol asignado aquí rige en minutos (revalidación de sesiones), sin esperar a que caduque la cookie.
app.get('/api/usuarios', requiere('admin'), wrap(async (_q, res) => {
  res.json((await db.query('select email, nombre, rol, ultimo_acceso from usuarios order by email')).rows);
}));
const EMAIL = /^[\p{L}\p{N}._%+'-]{1,64}@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u;
app.put('/api/usuarios/:email', requiere('admin'), wrap(async (req, res) => {
  const email = String(req.params.email).trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return res.status(400).json({ error: 'correo inválido' });
  const rol = req.body && req.body.rol === null ? null : String((req.body || {}).rol || '');
  if (rol !== null && !auth.ROLES.includes(rol)) return res.status(400).json({ error: 'rol inválido' });
  await db.query(
    'insert into usuarios (email, rol) values ($1,$2) on conflict (email) do update set rol = excluded.rol', [email, rol]);
  auth.olvidar(email); // el cambio rige de inmediato en este proceso (en otras réplicas, al vencer la caché)
  await audita(req, 'cambiar_rol', { usuario: email, rol });
  res.json({ email, rol });
}));
app.get('/api/auditoria', requiere('admin'), wrap(async (_q, res) => {
  res.json((await db.query('select id, ts, usuario, rol, accion, detalle, ip from auditoria order by id desc limit 200')).rows);
}));

app.get('/api/eventos', wrap(async (_q, res) => {
  res.json((await db.query('select id, ts, tipo, detalle from eventos order by id desc limit 50')).rows);
}));

// ---------- Jira → IPAM (webhook firmado) ----------
// Cuerpo esperado: { ticket, ambiente, tipo, mascara, vpc }. La firma cubre el momento y el cuerpo:
//   x-ipam-timestamp:   segundos desde 1970 (UTC) en que se firmó
//   x-hub-signature-256: sha256=HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")
// Se rechaza lo que se firmó hace más de 5 minutos (o en el futuro) y una misma firma no se acepta dos veces dentro de
// esa ventana, de modo que una captura de la petición no se puede reenviar. (La memoria de firmas es por proceso.)
const VENTANA_WEBHOOK_S = 300;
const firmar = (ts, buf) => 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.`).update(buf).digest('hex');
const firmasVistas = new Map(); // firma → instante (s) en que ya no hace falta recordarla

function verificarWebhook(headers, buf, ahoraMs = Date.now()) {
  const ts = String(headers['x-ipam-timestamp'] || '').trim();
  if (!/^\d{9,13}$/.test(ts)) return { ok: false, motivo: 'falta x-ipam-timestamp o no es un número' };
  const t = Number(ts) > 1e11 ? Math.floor(Number(ts) / 1000) : Number(ts); // tolera milisegundos
  if (Math.abs(ahoraMs / 1000 - t) > VENTANA_WEBHOOK_S) return { ok: false, motivo: 'timestamp fuera de la ventana de 5 minutos' };
  const recibida = String(headers['x-hub-signature-256'] || '');
  const esperada = firmar(ts, buf);
  if (!(recibida.length === esperada.length && crypto.timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada)))) {
    return { ok: false, motivo: 'firma inválida' };
  }
  for (const [f, vence] of firmasVistas) if (vence <= ahoraMs / 1000) firmasVistas.delete(f);
  if (firmasVistas.has(recibida)) return { ok: false, repetido: true, motivo: 'petición repetida' };
  firmasVistas.set(recibida, t + 2 * VENTANA_WEBHOOK_S);
  return { ok: true };
}

// Tipos y largos máximos de lo que llega por el webhook (los valores se usan en consultas, en Jira y en el log).
function camposWebhookInvalidos(b) {
  const txt = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
  if (!txt(b.ticket, MAX.ticket) || !/^[\w.-]+$/.test(b.ticket)) return 'ticket';
  if (!txt(b.ambiente, 10)) return 'ambiente';
  if (!txt(b.tipo, 50)) return 'tipo';
  if (!Number.isInteger(Number(b.mascara))) return 'mascara';
  if (!txt(b.vpc, MAX.vpc)) return 'vpc';
  return null;
}

async function procesarTicket({ ticket, ambiente, tipo, mascara, vpc }) {
  const p = (await db.query('select id from pools where ambiente=$1 and tipo=$2 order by id limit 1', [ambiente, tipo])).rows[0];
  if (!p) {
    await evento('jira_rechazo', { ticket, motivo: `sin pool ${tipo}/${ambiente}` });
    return { status: 422, body: { ticket, error: `No hay pool ${tipo}/${ambiente}` } };
  }
  const r = await asignar({ pool: p.id, vpc, mascara, solicitante: 'jira-webhook', origen: 'jira', ticket });
  if (!r.ok) {
    await evento('jira_rechazo', { ticket, motivo: r.error });
    return { status: r.status, body: { ticket, error: r.error } };
  }
  await auditar('asignar_jira', 'jira-webhook', null, { ticket, cidr: r.asignacion.cidr, pool: p.id, vpc });
  // Retorno a Jira: con JIRA_ENABLED=true ya lo hizo sincronizarJira(); apagado, solo queda el evento simulado.
  if (!jira.enabled()) await evento('jira_actualiza_ticket', { ticket, rango: r.asignacion.cidr, estado: 'Hecho', simulado: true });
  return { status: 200, body: { ticket, pool: p.id, cidr: r.asignacion.cidr } };
}

app.post('/webhook/jira', limites.limiteWebhook(), wrap(async (req, res) => {
  const v = verificarWebhook(req.headers, req.raw || Buffer.alloc(0));
  if (!v.ok) {
    await evento('jira_firma_invalida', { motivo: v.motivo });
    return res.status(v.repetido ? 409 : 401).json({ error: v.repetido ? 'petición repetida' : 'firma inválida', motivo: v.motivo });
  }
  const b = req.body || {};
  if (!b.ticket || !b.ambiente || !b.tipo || !b.mascara || !b.vpc) return res.status(400).json({ error: 'faltan campos' });
  const invalido = camposWebhookInvalidos(b);
  if (invalido) return res.status(400).json({ error: `campo inválido: ${invalido}` });
  const out = await procesarTicket(b);
  res.status(out.status).json(out.body);
}));

// Simulador para la demo: arma un ticket de Jira, lo firma como lo haría Jira y lo procesa por el mismo camino del
// webhook (con la misma verificación de firma y de timestamp). Solo fuera de producción o con ENABLE_SIMULADOR=true.
app.post('/api/jira/simular', requiere('solicitante'), wrap(async (req, res) => {
  if (!simuladorHabilitado()) return res.status(404).json({ error: 'El simulador no está habilitado en este entorno.' });
  const { ambiente, tipo, mascara, vpc } = req.body || {};
  const ticket = await nuevoTicket();
  const cuerpo = Buffer.from(JSON.stringify({ ticket, ambiente, tipo, mascara, vpc }));
  const ts = String(Math.floor(Date.now() / 1000));
  const firma = firmar(ts, cuerpo);
  await evento('jira_webhook_recibido', { ticket, ambiente, tipo, mascara, vpc, timestamp: ts, firma: firma.slice(0, 23) + '…' });
  const v = verificarWebhook({ 'x-ipam-timestamp': ts, 'x-hub-signature-256': firma }, cuerpo);
  if (!v.ok) return res.status(401).json({ ticket, error: v.motivo });
  const datos = { ticket, ambiente, tipo, mascara, vpc };
  const invalido = camposWebhookInvalidos(datos);
  if (invalido) return res.status(400).json({ error: `campo inválido: ${invalido}` });
  const out = await procesarTicket(datos);
  res.status(out.status).json(out.body);
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Último recurso: errores de las rutas y de los analizadores (cuerpo demasiado grande, JSON mal formado…).
app.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  if (e.type === 'entity.too.large') return res.status(413).json({ error: 'El cuerpo de la petición es demasiado grande.' });
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  responderError(req, res, e);
});

// ---------- Retención ----------
// `eventos` y `auditoria` crecen sin parar: se borra lo anterior a RETENCION_DIAS (365; 0 = conservar todo).
const retencionDias = () => Math.floor(entero(process.env.RETENCION_DIAS, 365));
async function purgar(dias = retencionDias()) {
  if (!(dias > 0)) return { eventos: 0, auditoria: 0, omitida: true };
  const borrar = async (tabla) => (await db.query(`delete from ${tabla} where ts < now() - make_interval(days => $1::int)`, [dias])).rowCount;
  return { eventos: await borrar('eventos'), auditoria: await borrar('auditoria'), omitida: false };
}
function iniciarPurga() {
  const tarea = () => purgar()
    .then((r) => { if (r.eventos || r.auditoria) console.log(`retención: ${r.eventos} eventos y ${r.auditoria} registros de auditoría borrados`); })
    .catch((e) => console.error('retención:', e.message));
  tarea();
  const cada24h = setInterval(tarea, 24 * 3600 * 1000);
  cada24h.unref();
  return cada24h;
}

// ---------- Arranque y apagado ordenado ----------
function iniciar() {
  const srv = app.listen(PORT, () => console.log(`IPAM MVP escuchando en :${srv.address().port}`));
  const purga = iniciarPurga();
  const apagar = async (senal) => {
    if (cerrando) return;
    cerrando = true; // /api/health responde 503 mientras se drena
    console.log(`${senal}: cerrando el servidor…`);
    clearInterval(purga);
    const limite = setTimeout(() => { console.error('cierre forzado: se agotó el tiempo'); process.exit(1); }, entero(process.env.SHUTDOWN_TIMEOUT_MS, 10000));
    limite.unref();
    try {
      await new Promise((ok) => srv.close(ok)); // deja terminar las peticiones en curso
      await esperarSegundoPlano();
      await db.end();
      process.exit(0);
    } catch (e) {
      console.error('error al cerrar:', e);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));
  return srv;
}

if (require.main === module) iniciar();
module.exports = { app, db, evento, esperarSegundoPlano, purgar, poolsConUso, verificarWebhook, firmar };
