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

const PORT = process.env.PORT || 8080;
const WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || 'dev-secret-cambiar';

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
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
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '5mb', verify: (req, _res, buf) => { req.raw = buf; } }));

// Auditoría: nunca bloquea la operación; un fallo queda en el log.
const auditar = (accion, usuario, rol, detalle = {}, ip = null) =>
  db.query('insert into auditoria (usuario, rol, accion, detalle, ip) values ($1,$2,$3,$4,$5)', [usuario, rol, accion, detalle, ip])
    .catch((e) => console.error('auditoría:', e.message));
const audita = (req, accion, detalle) => auditar(accion, req.usuario || 'sistema', req.rol || null, detalle, req.ip);

auth.validarConfiguracion();
auth.montar(app, { db, auditar });
marca.montar(app);
const { requiere } = auth;

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'interno', detalle: e.message });
});
const evento = (tipo, detalle) => db.query('insert into eventos (tipo, detalle) values ($1,$2)', [tipo, detalle]);
const nuevoTicket = async () => (await db.query("select 'NET-' || nextval('ticket_seq') as t")).rows[0].t;

// ---------- Dominio ----------
async function ocupados(poolId) {
  return (await db.query('select cidr::text from asignaciones where pool_id=$1', [poolId])).rows.map((r) => r.cidr);
}

// Devuelve {ok:true, asignacion} | {ok:false, status, error, ...}
// Las asignaciones de un mismo pool se serializan con un bloqueo de transacción; la restricción de
// exclusión de la base queda como respaldo (también cubre inserciones hechas fuera de la API).
async function asignar({ pool, vpc, cidr, mascara, solicitante, origen, ticket }) {
  if (!vpc || !String(vpc).trim()) return { ok: false, status: 400, error: 'Indica el proyecto / VPC.' };
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
  await sincronizarJira(resultado.asignacion);
  return resultado;
}

// Integración saliente con Jira (apagada por defecto: JIRA_ENABLED=true para activarla).
// Un fallo de Jira nunca deshace la asignación: queda como evento.
async function sincronizarJira(a) {
  if (!jira.enabled()) return;
  const falta = jira.faltantes();
  if (falta.length) return evento('jira_error', { ticket: a.ticket, motivo: `Faltan variables: ${falta.join(', ')}` });
  try {
    if (a.origen === 'jira') {
      await jira.actualizarTicket(a.ticket, a);
      await evento('jira_ticket_actualizado', { ticket: a.ticket, rango: a.cidr });
    } else {
      const clave = await jira.crearTicket(a);
      await db.query('update asignaciones set ticket=$1 where id=$2', [clave, a.id]);
      a.ticket = clave;
      await evento('jira_ticket_creado', { ticket: clave, rango: a.cidr });
    }
  } catch (e) {
    await evento('jira_error', { ticket: a.ticket, motivo: e.message });
  }
}

// ---------- API ----------
app.get('/api/health', wrap(async (_q, res) => {
  await db.query('select 1');
  res.json({ ok: true });
}));

app.get('/api/pools', wrap(async (_q, res) => {
  const rows = (await db.query(
    `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones,
            coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 / (2^(32-masklen(p.cidr)))::float8 as uso
       from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`)).rows;
  res.json(rows);
}));

app.get('/api/resumen', wrap(async (_q, res) => {
  const r = (await db.query(
    `select (select count(*) from pools)::int as pools, (select count(*) from asignaciones)::int as asignaciones,
            (select coalesce(avg(u),0) from (select coalesce(sum(2^(32-masklen(a.cidr))),0)::float8/(2^(32-masklen(p.cidr)))::float8 as u
               from pools p left join asignaciones a on a.pool_id=p.id group by p.id) x)::float8 as uso_promedio`)).rows[0];
  // Con la restricción de exclusión, los solapamientos no pueden existir: se informa 0 y se explica en la UI.
  res.json({ ...r, solapamientos: 0 });
}));

app.get('/api/asignaciones', wrap(async (_q, res) => {
  res.json((await db.query(
    'select id, pool_id, cidr::text, vpc, solicitante, ticket, origen, creado_en from asignaciones order by id desc')).rows);
}));

app.get('/api/jira/estado', (_q, res) => res.json({ activa: jira.enabled(), faltantes: jira.enabled() ? jira.faltantes() : [] }));

// Exporta a Excel todos los segmentos asignados (con los datos de su pool) y la lista de pools.
app.get('/api/exportar.xlsx', requiere('lector'), wrap(async (req, res) => {
  const filas = (await db.query(
    `select a.id, a.pool_id, p.tipo, p.ambiente, p.proveedor, p.cidr::text as pool_cidr, a.cidr::text, a.vpc,
            a.solicitante, a.ticket, a.origen, a.creado_en
       from asignaciones a join pools p on p.id = a.pool_id order by p.ambiente desc, a.pool_id, a.cidr`)).rows;
  const pools = (await db.query(
    `select p.id, p.tipo, p.ambiente, p.proveedor, p.cidr::text, count(a.id)::int as asignaciones,
            coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 / (2^(32-masklen(p.cidr)))::float8 as uso
       from pools p left join asignaciones a on a.pool_id = p.id group by p.id order by p.ambiente desc, p.id`)).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = marca.config().nombre;
  const hoja = (nombre, columnas, datos) => {
    const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columnas;
    ws.addRows(datos);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12203A' } };
    ws.autoFilter = { from: 'A1', to: { row: 1, column: columnas.length } };
    return ws;
  };
  hoja('Segmentos', [
    { header: 'Segmento (CIDR)', key: 'cidr', width: 20 }, { header: 'Máscara', key: 'mascara', width: 9 },
    { header: 'Direcciones', key: 'dir', width: 13, style: { numFmt: '#,##0' } },
    { header: 'Pool', key: 'pool', width: 20 }, { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Ambiente', key: 'amb', width: 10 }, { header: 'Proveedor', key: 'prov', width: 12 },
    { header: 'CIDR del pool', key: 'pcidr', width: 18 }, { header: 'Proyecto / VPC', key: 'vpc', width: 22 },
    { header: 'Solicitó', key: 'sol', width: 16 }, { header: 'Origen', key: 'origen', width: 10 },
    { header: 'Ticket', key: 'ticket', width: 11 }, { header: 'Fecha', key: 'fecha', width: 17, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
  ], filas.map((r) => {
    const len = Number(r.cidr.split('/')[1]);
    return { cidr: r.cidr, mascara: `/${len}`, dir: 2 ** (32 - len), pool: r.pool_id, tipo: r.tipo, amb: r.ambiente,
      prov: r.proveedor, pcidr: r.pool_cidr, vpc: r.vpc, sol: r.solicitante, origen: r.origen, ticket: r.ticket, fecha: r.creado_en };
  }));
  hoja('Pools', [
    { header: 'Pool', key: 'id', width: 20 }, { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Ambiente', key: 'amb', width: 10 }, { header: 'Proveedor', key: 'prov', width: 12 },
    { header: 'CIDR base', key: 'cidr', width: 18 }, { header: 'Asignaciones', key: 'n', width: 13 },
    { header: 'Uso', key: 'uso', width: 9, style: { numFmt: '0.0%' } },
  ], pools.map((p) => ({ id: p.id, tipo: p.tipo, amb: p.ambiente, prov: p.proveedor, cidr: p.cidr, n: p.asignaciones, uso: p.uso })));

  await audita(req, 'exportar', { filas: filas.length });
  const nombre = `ipam-segmentos-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${nombre}"` });
  await wb.xlsx.write(res);
  res.end();
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
app.post('/api/importar', requiere('admin'), wrap(async (req, res) => {
  const d = req.body || {};
  if (d.formato !== 'ipam-respaldo' || d.version !== 1 || !Array.isArray(d.pools) || !Array.isArray(d.asignaciones)) {
    return res.status(400).json({ error: 'No es un respaldo de IPAM (formato ipam-respaldo, versión 1).' });
  }
  const AMB = ['dev', 'qa', 'pre', 'prod'];
  for (const p of d.pools) {
    if (!p.id || !p.tipo || !AMB.includes(p.ambiente) || !p.proveedor || !parse(String(p.cidr))) return res.status(400).json({ error: `Pool inválido: ${JSON.stringify(p).slice(0, 120)}` });
  }
  for (const a of d.asignaciones) {
    const c = parse(String(a.cidr));
    if (!a.pool_id || !a.vpc || !a.ticket || !c || !c.aligned) return res.status(400).json({ error: `Asignación inválida: ${JSON.stringify(a).slice(0, 120)}` });
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

// Usuarios y auditoría (solo admin). El rol asignado aquí rige desde el próximo inicio de sesión del usuario.
app.get('/api/usuarios', requiere('admin'), wrap(async (_q, res) => {
  res.json((await db.query('select email, nombre, rol, ultimo_acceso from usuarios order by email')).rows);
}));
app.put('/api/usuarios/:email', requiere('admin'), wrap(async (req, res) => {
  const rol = req.body && req.body.rol === null ? null : String((req.body || {}).rol || '');
  if (rol !== null && !auth.ROLES.includes(rol)) return res.status(400).json({ error: 'rol inválido' });
  const email = req.params.email.toLowerCase();
  await db.query(
    'insert into usuarios (email, rol) values ($1,$2) on conflict (email) do update set rol = excluded.rol', [email, rol]);
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
// Cuerpo esperado: { ticket, ambiente, tipo, mascara, vpc }. Firma: x-hub-signature-256 = sha256=HMAC(body, secreto).
const firmar = (buf) => 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(buf).digest('hex');

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

app.post('/webhook/jira', wrap(async (req, res) => {
  const recibida = String(req.headers['x-hub-signature-256'] || '');
  const esperada = firmar(req.raw || Buffer.alloc(0));
  const ok = recibida.length === esperada.length && crypto.timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada));
  if (!ok) { await evento('jira_firma_invalida', {}); return res.status(401).json({ error: 'firma inválida' }); }
  const b = req.body || {};
  if (!b.ticket || !b.ambiente || !b.tipo || !b.mascara || !b.vpc) return res.status(400).json({ error: 'faltan campos' });
  const out = await procesarTicket(b);
  res.status(out.status).json(out.body);
}));

// Simulador para la demo: arma un ticket de Jira, lo firma y lo procesa por el mismo camino del webhook.
app.post('/api/jira/simular', requiere('solicitante'), wrap(async (req, res) => {
  const { ambiente, tipo, mascara, vpc } = req.body || {};
  const ticket = await nuevoTicket();
  const cuerpo = Buffer.from(JSON.stringify({ ticket, ambiente, tipo, mascara, vpc }));
  await evento('jira_webhook_recibido', { ticket, ambiente, tipo, mascara, vpc, firma: firmar(cuerpo).slice(0, 23) + '…' });
  const out = await procesarTicket({ ticket, ambiente, tipo, mascara, vpc });
  res.status(out.status).json(out.body);
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`IPAM MVP escuchando en :${PORT}`));
}
module.exports = { app, db };
