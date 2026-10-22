'use strict';
// Pools, asignaciones (segmentos definitivos), exportaciones y respaldo.
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');
const { construirLibro } = require('../excel');
const marca = require('../marca');
const { leerSegmentos } = require('../archivo-segmentos');

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion }) {
  const { admin, asignaciones, respaldo, importacion } = casos;

  api(app, 'get', '/pools', async (req, res) => {
    const { ambiente, tipo } = req.query;
    res.json(await admin.pools({ ambiente: typeof ambiente === 'string' ? ambiente : undefined, tipo: typeof tipo === 'string' ? tipo : undefined }));
  });
  api(app, 'get', '/resumen', async (_q, res) => res.json(await admin.resumen()));
  api(app, 'get', '/asignaciones', async (_q, res) => res.json(await admin.asignaciones()));

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
    const { pool, vpc, cidr, mascara } = req.body || {};
    const r = await asignaciones.asignar({ pool, vpc, cidr, mascara, solicitante: req.usuario || 'panel', origen: 'panel' });
    if (!r.ok) return enviarFallo(res, r, { legado: true });
    await audita(req, 'asignar', { cidr: r.asignacion.cidr, pool, vpc, ticket: r.asignacion.ticket });
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

  api(app, 'get', '/exportar.xlsx', requiere('lector'), async (req, res) => {
    const datos = await admin.asignacionesParaExcel();
    const wb = construirLibro(datos, marca.config().nombre);
    await audita(req, 'exportar', { filas: datos.filas.length });
    const nombre = `ipam-segmentos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nombre}"` });
    await wb.xlsx.write(res);
    res.end();
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
