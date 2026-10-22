'use strict';
// Construcción del libro Excel de segmentos y pools (presentación; los datos vienen del caso de uso).
const ExcelJS = require('exceljs');

function hoja(wb, nombre, columnas, datos) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columnas;
  ws.addRows(datos);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12203A' } };
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columnas.length } };
  return ws;
}

function construirLibro({ filas, pools }, creador) {
  const wb = new ExcelJS.Workbook();
  wb.creator = creador;
  hoja(
    wb,
    'Segmentos',
    [
      { header: 'ID', key: 'id', width: 12 },
      { header: 'Segmento (CIDR)', key: 'cidr', width: 20 },
      { header: 'Máscara', key: 'mascara', width: 9 },
      { header: 'Direcciones', key: 'dir', width: 13, style: { numFmt: '#,##0' } },
      { header: 'Pool', key: 'pool', width: 20 },
      { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Ambiente', key: 'amb', width: 10 },
      { header: 'Proveedor', key: 'prov', width: 12 },
      { header: 'CIDR del pool', key: 'pcidr', width: 18 },
      { header: 'Proyecto / VPC', key: 'vpc', width: 22 },
      { header: 'VLAN', key: 'vlan', width: 8 },
      { header: 'Nombre VLAN / subred', key: 'vlan_nombre', width: 22 },
      { header: 'Solicitó', key: 'sol', width: 16 },
      { header: 'Origen', key: 'origen', width: 10 },
      { header: 'Ticket', key: 'ticket', width: 11 },
      { header: 'Fecha', key: 'fecha', width: 17, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
    ],
    filas.map((r) => {
      const len = Number(r.cidr.split('/')[1]);
      return {
        id: r.codigo,
        cidr: r.cidr,
        mascara: `/${len}`,
        dir: 2 ** (32 - len),
        pool: r.pool_id,
        tipo: r.tipo,
        amb: r.ambiente,
        prov: r.proveedor,
        pcidr: r.pool_cidr,
        vpc: r.vpc,
        vlan: r.vlan ?? '',
        vlan_nombre: r.vlan_nombre || '',
        sol: r.solicitante,
        origen: r.origen,
        ticket: r.ticket,
        fecha: r.creado_en,
      };
    }),
  );
  hoja(
    wb,
    'Pools',
    [
      { header: 'Pool', key: 'id', width: 20 },
      { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Ambiente', key: 'amb', width: 10 },
      { header: 'Proveedor', key: 'prov', width: 12 },
      { header: 'CIDR base', key: 'cidr', width: 18 },
      { header: 'Asignaciones', key: 'n', width: 13 },
      { header: 'Uso', key: 'uso', width: 9, style: { numFmt: '0.0%' } },
    ],
    pools.map((p) => ({ id: p.id, tipo: p.tipo, amb: p.ambiente, prov: p.proveedor, cidr: p.cidr, n: p.asignaciones, uso: p.uso })),
  );
  return wb;
}

module.exports = { construirLibro };
