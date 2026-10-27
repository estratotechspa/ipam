'use strict';
// Direcciones IP fijas (interfaces de equipos, gateways, VIP…). Leer: cualquier rol; registrar y editar: agente o más; borrar: admin.
const { api } = require('../registro');
const { requiere } = require('../../auth/acceso');
const { enviarFallo, error } = require('../errores');

const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
// Lo que va al historial: el pool y el CIDR del segmento (así aparece en la ficha del segmento y del pool).
const detalle = (d, segmento, extra = {}) => ({
  pool: d.pool_id,
  ...(segmento ? { cidr: segmento.cidr } : {}),
  ip: d.ip,
  dispositivo: d.dispositivo,
  interfaz: d.interfaz,
  ...(d.excepcion ? { excepcion: d.excepcion } : {}),
  ...extra,
});

/** @param {import('express').Express} app @param {{casos: any, audita: Function, validacion: any}} deps */
function montar(app, { casos, audita, validacion }) {
  const { direcciones } = casos;
  const idValido = (req, res) => (/^\d+$/.test(req.params.id) ? true : (error(res, 404, 'no_encontrado', 'Esa dirección no existe.'), false));

  api(app, 'get', '/direcciones', async (req, res) => {
    const asignacion = texto(req.query.asignacion);
    if (asignacion && !/^\d+$/.test(asignacion)) return error(res, 400, 'validacion', 'asignacion debe ser el id numérico del segmento.');
    res.json(await direcciones.listar({ asignacion, pool: texto(req.query.pool), q: texto(req.query.q) }));
  });

  api(app, 'post', '/direcciones', requiere('agente'), validacion.cuerpo('DireccionCrear'), async (req, res) => {
    const r = await direcciones.registrar(req.actor, req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'registrar_ip', detalle(r.direccion, r.segmento));
    res
      .status(201)
      .json({ ...r.direccion, segmento: r.segmento ? r.segmento.cidr : null, segmento_codigo: r.segmento ? r.segmento.codigo : null, aviso: r.aviso });
  });

  api(app, 'patch', '/direcciones/:id', requiere('agente'), validacion.cuerpo('DireccionEditar'), async (req, res) => {
    if (!idValido(req, res)) return;
    const r = await direcciones.editar(req.params.id, req.body);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'editar_ip', detalle(r.direccion, r.segmento));
    res.json(r.direccion);
  });

  api(app, 'delete', '/direcciones/:id', requiere('admin'), async (req, res) => {
    if (!idValido(req, res)) return;
    const r = await direcciones.eliminar(req.params.id);
    if (!r.ok) return enviarFallo(res, r, { legado: false });
    await audita(req, 'eliminar_ip', detalle(r.direccion, r.segmento));
    res.json({ eliminada: r.direccion });
  });
}

module.exports = { montar };
