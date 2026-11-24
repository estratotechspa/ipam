'use strict';
// Generación del libro Excel de segmentos, pools e IPs fijas usando write-excel-file.
// Genera las hojas 'Segmentos', 'Pools' y 'Direcciones IP' con encabezados destacados y streaming hacia la respuesta.
const { pipeline } = require('node:stream/promises');
const writeXlsxFile = require('write-excel-file/node');

const ENCABEZADO = {
  fontWeight: 'bold',
  color: '#FFFFFF',
  backgroundColor: '#12203A',
};

const filaEncabezado = (columnas) => columnas.map((c) => ({ value: c.header, ...ENCABEZADO }));

const COLUMNAS_SEGMENTOS = [
  { header: 'ID', width: 12 },
  { header: 'Segmento (CIDR)', width: 20 },
  { header: 'Máscara', width: 9 },
  { header: 'Direcciones', width: 13 },
  { header: 'Pool', width: 20 },
  { header: 'Tipo', width: 14 },
  { header: 'Ambiente', width: 10 },
  { header: 'Proveedor', width: 12 },
  { header: 'CIDR del pool', width: 18 },
  { header: 'Proyecto', width: 22 },
  { header: 'VPC', width: 22 },
  { header: 'Nombre subred', width: 22 },
  { header: 'VLAN', width: 8 },
  { header: 'Nombre VLAN', width: 22 },
  { header: 'Uso', width: 22 },
  { header: 'Responsable', width: 20 },
  { header: 'Descripción', width: 40 },
  { header: 'Solicitó', width: 16 },
  { header: 'Origen', width: 10 },
  { header: 'Ticket', width: 11 },
  { header: 'Fecha', width: 17 },
];

const COLUMNAS_POOLS = [
  { header: 'Pool', width: 20 },
  { header: 'Tipo', width: 14 },
  { header: 'Ambiente', width: 10 },
  { header: 'Proveedor', width: 12 },
  { header: 'CIDR base', width: 18 },
  { header: 'Asignaciones', width: 13 },
  { header: 'Uso', width: 9 },
];

const COLUMNAS_IPS = [
  { header: 'IP', width: 16 },
  { header: 'Dispositivo', width: 20 },
  { header: 'Interfaz', width: 16 },
  { header: 'Rol', width: 11 },
  { header: 'DNS', width: 26 },
  { header: 'Descripción', width: 30 },
  { header: 'Segmento', width: 20 },
  { header: 'ID segmento', width: 13 },
  { header: 'Pool', width: 20 },
  { header: 'Excepción (motivo)', width: 28 },
];

function filaSegmento(r) {
  const len = Number(r.cidr.split('/')[1]);
  return [
    { value: r.codigo || '' },
    { value: r.cidr || '' },
    { value: `/${len}` },
    { value: 2 ** (32 - len), type: Number, format: '#,##0' },
    { value: r.pool_id || '' },
    { value: r.tipo || '' },
    { value: r.ambiente || '' },
    { value: r.proveedor || '' },
    { value: r.pool_cidr || '' },
    { value: r.proyecto || '' },
    { value: r.vpc || '' },
    { value: r.subred || '' },
    { value: r.vlan != null ? String(r.vlan) : '' },
    { value: r.vlan_nombre || '' },
    { value: r.uso || '' },
    { value: r.responsable || '' },
    { value: r.descripcion || '' },
    { value: r.solicitante || '' },
    { value: r.origen || '' },
    { value: r.ticket || '' },
    r.creado_en instanceof Date ? { value: r.creado_en, type: Date, format: 'dd-mm-yyyy hh:mm' } : { value: r.creado_en ? String(r.creado_en) : '' },
  ];
}

function filaPool(p) {
  return [
    { value: p.id || '' },
    { value: p.tipo || '' },
    { value: p.ambiente || '' },
    { value: p.proveedor || '' },
    { value: p.cidr || '' },
    { value: p.asignaciones != null ? Number(p.asignaciones) : 0, type: Number },
    { value: p.uso != null ? Number(p.uso) : 0, type: Number, format: '0.0%' },
  ];
}

function filaIP(d) {
  return [
    { value: d.ip || '' },
    { value: d.dispositivo || '' },
    { value: d.interfaz || '' },
    { value: d.rol || '' },
    { value: d.dns || '' },
    { value: d.descripcion || '' },
    { value: d.segmento || '' },
    { value: d.segmento_codigo || '' },
    { value: d.pool_id || '' },
    { value: d.excepcion || '' },
  ];
}

/**
 * @param {import('node:stream').Writable} salida  la respuesta HTTP
 * @param {{pools: () => Promise<any[]>, filas: () => AsyncIterable<any[]>, direcciones: () => AsyncIterable<any[]>}} lector
 * @param {string} [creador]
 * @returns {Promise<{segmentos: number, direcciones: number}>}
 */
async function escribirLibro(salida, lector, creador) {
  const filasSegmentos = [filaEncabezado(COLUMNAS_SEGMENTOS)];
  let segmentos = 0;
  for await (const lote of lector.filas()) {
    for (const r of lote) {
      filasSegmentos.push(filaSegmento(r));
      segmentos++;
    }
  }

  const filasPools = [filaEncabezado(COLUMNAS_POOLS)];
  const pools = await lector.pools();
  for (const p of pools) {
    filasPools.push(filaPool(p));
  }

  const filasDirecciones = [filaEncabezado(COLUMNAS_IPS)];
  let direcciones = 0;
  for await (const lote of lector.direcciones()) {
    for (const d of lote) {
      filasDirecciones.push(filaIP(d));
      direcciones++;
    }
  }

  const stream = await writeXlsxFile([
    {
      sheet: 'Segmentos',
      columns: COLUMNAS_SEGMENTOS.map((c) => ({ width: c.width })),
      stickyRowsCount: 1,
      data: filasSegmentos,
    },
    {
      sheet: 'Pools',
      columns: COLUMNAS_POOLS.map((c) => ({ width: c.width })),
      stickyRowsCount: 1,
      data: filasPools,
    },
    {
      sheet: 'Direcciones IP',
      columns: COLUMNAS_IPS.map((c) => ({ width: c.width })),
      stickyRowsCount: 1,
      data: filasDirecciones,
    },
  ]).toStream();

  await pipeline(stream, salida);
  return { segmentos, direcciones };
}

module.exports = { escribirLibro };
