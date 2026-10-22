'use strict';
// Pools, asignaciones (segmentos definitivos), exportaciones y respaldo.
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');
const { construirLibro } = require('../excel');
const marca = require('../marca');

/** @param {import('express').Express} app @param {{casos: any, audita: Function}} deps */
function montar(app, { casos, audita, validacion }) {
  const { admin, asignaciones, respaldo } = casos;

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

  api(app, 'post', '/solicitudes', requiere('admin'), validacion.cuerpo('Solicitud'), async (req, res) => {
    const { pool, vpc, cidr, mascara } = req.body || {};
    const r = await asignaciones.asignar({ pool, vpc, cidr, mascara, solicitante: req.usuario || 'panel', origen: 'panel' });
    if (!r.ok) return enviarFallo(res, r, { legado: true });
    await audita(req, 'asignar', { cidr: r.asignacion.cidr, pool, vpc, ticket: r.asignacion.ticket });
    res.status(201).json(r.asignacion);
  });

  api(app, 'delete', '/asignaciones/:id', requiere('admin'), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return error(res, 404, 'no_encontrado', 'No existe');
    const r = await asignaciones.liberar(req.params.id);
    if (!r.ok) return enviarFallo(res, r);
    await audita(req, 'liberar', r.liberado);
    res.json({ liberado: r.liberado });
  });

  // Exporta a Excel todos los segmentos asignados (con los datos de su pool) y la lista de pools.
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
