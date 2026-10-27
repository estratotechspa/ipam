'use strict';
// Pools, asignaciones (segmentos definitivos), exportaciones y respaldo.
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');
const { escribirLibro } = require('../excel');
const marca = require('../marca');
const { leerSegmentos } = require('../archivo-segmentos');

const ORDENES = ['fecha', 'cidr', 'pool', 'vpc', 'solicitante', 'ticket', 'origen', 'codigo', 'direcciones'];
const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
const LIMITE_MAXIMO = 1000;

/** Valida los parámetros de la lista de asignaciones. Devuelve los filtros o { error } con un mensaje claro. */
function leerFiltrosAsignaciones(q) {
  const texto = (k, max) => (q[k] === undefined ? undefined : typeof q[k] === 'string' && q[k].length <= max ? q[k] : null);
  const entero = (k, defecto) => (q[k] === undefined ? defecto : typeof q[k] === 'string' && /^\d{1,9}$/.test(q[k]) ? Number(q[k]) : null);
  const limit = entero('limit', LIMITE_MAXIMO);
  const offset = entero('offset', 0);
  const f = { pool: texto('pool', 100), ambiente: texto('ambiente', 10), q: texto('q', 100), orden: texto('orden', 20), dir: texto('dir', 4) };
  if (limit === null || limit < 1 || limit > LIMITE_MAXIMO) return { error: `limit debe ser un entero entre 1 y ${LIMITE_MAXIMO}.` };
  if (offset === null) return { error: 'offset debe ser un entero mayor o igual a 0.' };
  if (f.pool === null || f.q === null) return { error: 'pool o q inválidos (máximo 100 caracteres).' };
  if (f.ambiente !== undefined && !AMBIENTES.includes(f.ambiente)) return { error: `ambiente debe ser uno de: ${AMBIENTES.join(', ')}.` };
  if (f.orden !== undefined && !ORDENES.includes(f.orden)) return { error: `orden debe ser uno de: ${ORDENES.join(', ')}.` };
  if (f.dir !== undefined && !['asc', 'desc'].includes(f.dir)) return { error: 'dir debe ser asc o desc.' };
  return { ...f, q: f.q && f.q.trim() ? f.q.trim() : undefined, limit, offset };
}

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion }) {
  const { admin, asignaciones, respaldo, importacion, pools } = casos;

  api(app, 'get', '/pools', async (req, res) => {
    const { ambiente, tipo } = req.query;
    res.json(await admin.pools({ ambiente: typeof ambiente === 'string' ? ambiente : undefined, tipo: typeof tipo === 'string' ? tipo : undefined }));
  });
  // Alta, edición (tipo y proveedor) y baja de bloques base. Solo admin; queda en el historial del pool.
  api(app, 'post', '/pools', requiere('admin'), validacion.cuerpo('PoolCrear'), async (req, res) => {
    const r = await pools.crear(req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    const p = r.pool;
    await audita(req, 'crear_pool', { pool: p.id, cidr: p.cidr, ambiente: p.ambiente, proveedor: p.proveedor, tipo: p.tipo });
    res.status(201).json(p);
  });
  api(app, 'patch', '/pools/:id', requiere('admin'), validacion.cuerpo('PoolEditar'), async (req, res) => {
    const r = await pools.editar(req.params.id, req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'editar_pool', {
      pool: r.pool.id,
      antes: { tipo: r.antes.tipo, proveedor: r.antes.proveedor },
      tipo: r.pool.tipo,
      proveedor: r.pool.proveedor,
    });
    res.json(r.pool);
  });
  api(app, 'delete', '/pools/:id', requiere('admin'), async (req, res) => {
    const r = await pools.eliminar(req.params.id);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'eliminar_pool', { pool: r.pool.id, cidr: r.pool.cidr });
    res.json({ eliminado: r.pool });
  });
  api(app, 'get', '/resumen', async (_q, res) => res.json(await admin.resumen()));
  // Lista paginada: limit (1000 por defecto, máx. 1000), offset, filtros pool, ambiente y q (CIDR, ID, proyecto/VPC, solicitante o ticket),
  // y orden=<columna>&dir=asc|desc. El total sin paginar va en la cabecera X-Total-Count.
  api(app, 'get', '/asignaciones', async (req, res) => {
    const f = leerFiltrosAsignaciones(req.query);
    if (f.error) return error(res, 400, 'parametro_invalido', f.error);
    const { filas, total } = await admin.asignaciones(f);
    res.set('X-Total-Count', String(total));
    res.json(filas);
  });

  api(app, 'get', '/pools/:id/libres', async (req, res) => {
    const r = await asignaciones.sugerirLibres(req.params.id, req.query.mascara);
    return r.ok ? res.json(r.libres) : enviarFallo(res, { ...r, error: r.error }, { legado: false });
  });

  api(app, 'get', '/pools/:id/disponibilidad', async (req, res) => {
    const r = await asignaciones.disponibilidadDe(req.params.id);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    const { ok: _ok, ...cuerpo } = r;
    res.json(cuerpo);
  });

  api(app, 'post', '/solicitudes', requiere('admin'), validacion.cuerpo('Solicitud'), async (req, res) => {
    const { pool, vpc, cidr, mascara, vlan, vlan_nombre } = req.body || {};
    const r = await asignaciones.asignar({ pool, vpc, cidr, mascara, vlan, vlan_nombre, solicitante: req.usuario || 'panel', origen: 'panel' });
    if (!r.ok) return enviarFallo(res, r, { legado: true });
    await audita(req, 'asignar', { cidr: r.asignacion.cidr, pool, vpc, ticket: r.asignacion.ticket, vlan: r.asignacion.vlan });
    res.status(201).json(r.asignacion);
  });

  api(app, 'delete', '/asignaciones/:id', requiere('admin'), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return error(res, 404, 'no_encontrado', 'No existe');
    // Motivo opcional (la interfaz lo exige): queda en la auditoría junto con quién liberó.
    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
    if (motivo.length > 200 || /\p{Cc}/u.test(motivo))
      return error(res, 400, 'validacion', 'El motivo debe tener hasta 200 caracteres y sin caracteres de control.');
    const r = await asignaciones.liberar(req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'liberar', motivo ? { ...r.liberado, motivo } : r.liberado);
    res.json({ liberado: r.liberado });
  });

  // Exporta a Excel todos los segmentos asignados (con los datos de su pool) y la lista de pools.
  // Importación masiva de segmentos que ya existen (Excel/CSV). Solo admin. «simular» no escribe nada; «aplicar» importa lo válido
  // (y lo que el admin aprobó con `aprobar`: números de fila que se solapan con OTRO pool). Todo o nada.
  const leerArchivo = async (req) => {
    const b = req.body || {};
    const buffer = Buffer.from(String(b.contenido_base64 || ''), 'base64');
    if (!buffer.length) return { ok: false, tipo: 'validacion', error: 'archivo_vacio', mensaje: 'No llegó ningún archivo.' };
    const l = await leerSegmentos({ formato: b.formato, buffer });
    return l.ok ? l : { ...l, tipo: 'validacion' };
  };
  const defectosDe = (b) => ({ proveedor: b.proveedor, ambiente: b.ambiente, tipo: b.tipo });
  api(app, 'post', '/importaciones/simular', requiere('admin'), validacion.cuerpo('ImportacionSolicitud'), async (req, res) => {
    const l = await leerArchivo(req);
    if (!l.ok) return enviarFallo(res, l, { legado: false });
    const r = await importacion.simular(l.filas, defectosDe(req.body));
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    const { ok: _ok, ...cuerpo } = r;
    res.json({ ...cuerpo, columnas: l.columnas, columnas_ignoradas: l.ignoradas });
  });
  api(app, 'post', '/importaciones/aplicar', requiere('admin'), validacion.cuerpo('ImportacionSolicitud'), async (req, res) => {
    const l = await leerArchivo(req);
    if (!l.ok) return enviarFallo(res, l, { legado: false });
    const aprobar = Array.isArray(req.body.aprobar) ? req.body.aprobar.map(Number).filter(Number.isInteger) : [];
    const r = await importacion.aplicar(req.actor, l.filas, defectosDe(req.body), aprobar);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    const { ok: _ok, ...cuerpo } = r;
    await audita(req, 'importar_segmentos', { ...cuerpo, archivo: String(req.body.nombre || '').slice(0, 120) });
    res.json(cuerpo);
  });

  // Excel por streaming: lee la base por lotes (instantánea consistente) y escribe cada fila al llegar. Si falla a mitad, la conexión
  // se corta (el archivo queda incompleto y el cliente lo nota) y el detalle queda en el log; la auditoría registra lo que se llegó a enviar.
  api(app, 'get', '/exportar.xlsx', requiere('lector'), async (req, res) => {
    const nombre = `ipam-segmentos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nombre}"` });
    const r = await admin.recorrerParaExcel((lector) => escribirLibro(res, lector, marca.config().nombre));
    await audita(req, 'exportar', { filas: r.segmentos, ips: r.direcciones });
  });

  // Portabilidad: respaldo lógico completo (pools, asignaciones y roles asignados) para llevar el IPAM a otra infraestructura.
  api(app, 'get', '/exportar.json', requiere('admin'), async (req, res) => {
    const r = await respaldo.exportar();
    await audita(req, 'exportar_json', r.resumen);
    res.set('Content-Disposition', `attachment; filename="ipam-respaldo-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(r.respaldo);
  });

  // Importa un respaldo de /api/exportar.json. Todo o nada; los pools existentes se conservan y las asignaciones repetidas se omiten.
  api(app, 'post', '/importar', requiere('admin'), validacion.cuerpo('Respaldo'), async (req, res) => {
    const r = await respaldo.importar(req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'importar', r.resultado);
    res.json(r.resultado);
  });
}

module.exports = { montar };
