'use strict';
// Libro Excel de segmentos, pools e IPs fijas, escrito por streaming (ExcelJS WorkbookWriter): cada fila se escribe al llegar
// y se descarta, así que la memoria no crece con el tamaño de la base. Los datos llegan por lotes desde el caso de uso.
const ExcelJS = require('exceljs');

const ENCABEZADO = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12203A' } } };

/** Hoja con la fila de títulos ya escrita; las filas de datos se añaden después con `ws.addRow(…).commit()`. */
function hoja(wb, nombre, columnas) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columnas.map(({ key, width, style }) => ({ key, width, style }));
  const titulos = ws.addRow(columnas.map((c) => c.header));
  titulos.eachCell((celda) => Object.assign(celda, ENCABEZADO));
  titulos.commit();
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columnas.length } };
  return ws;
}

/** Escribe todas las filas de un generador de lotes en la hoja. Devuelve cuántas. */
async function volcar(ws, lotes, aFila) {
  let n = 0;
  for await (const lote of lotes) {
    for (const r of lote) {
      ws.addRow(aFila(r)).commit();
      n++;
    }
  }
  ws.commit();
  return n;
}

/**
 * @param {import('node:stream').Writable} salida  la respuesta HTTP
 * @param {{pools: () => Promise<any[]>, filas: () => AsyncIterable<any[]>, direcciones: () => AsyncIterable<any[]>}} lector
 * @returns {Promise<{segmentos: number, direcciones: number}>}
 */
const COLUMNAS_SEGMENTOS = [
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
];
const COLUMNAS_POOLS = [
  { header: 'Pool', key: 'id', width: 20 },
  { header: 'Tipo', key: 'tipo', width: 14 },
  { header: 'Ambiente', key: 'amb', width: 10 },
  { header: 'Proveedor', key: 'prov', width: 12 },
  { header: 'CIDR base', key: 'cidr', width: 18 },
  { header: 'Asignaciones', key: 'n', width: 13 },
  { header: 'Uso', key: 'uso', width: 9, style: { numFmt: '0.0%' } },
];
const COLUMNAS_IPS = [
  { header: 'IP', key: 'ip', width: 16 },
  { header: 'Dispositivo', key: 'dispositivo', width: 20 },
  { header: 'Interfaz', key: 'interfaz', width: 16 },
  { header: 'Rol', key: 'rol', width: 11 },
  { header: 'DNS', key: 'dns', width: 26 },
  { header: 'Descripción', key: 'descripcion', width: 30 },
  { header: 'Segmento', key: 'segmento', width: 20 },
  { header: 'ID segmento', key: 'codigo', width: 13 },
  { header: 'Pool', key: 'pool', width: 20 },
  { header: 'Excepción (motivo)', key: 'excepcion', width: 28 },
];

async function escribirLibro(salida, lector, creador) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: salida, useStyles: true });
  wb.creator = creador;
  const segmentos = await volcar(hoja(wb, 'Segmentos', COLUMNAS_SEGMENTOS), lector.filas(), (r) => {
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
  });
  const hp = hoja(wb, 'Pools', COLUMNAS_POOLS);
  for (const p of await lector.pools())
    hp.addRow({ id: p.id, tipo: p.tipo, amb: p.ambiente, prov: p.proveedor, cidr: p.cidr, n: p.asignaciones, uso: p.uso }).commit();
  hp.commit();
  const direcciones = await volcar(hoja(wb, 'Direcciones IP', COLUMNAS_IPS), lector.direcciones(), (d) => ({
    ip: d.ip,
    dispositivo: d.dispositivo || '',
    interfaz: d.interfaz || '',
    rol: d.rol,
    dns: d.dns || '',
    descripcion: d.descripcion || '',
    segmento: d.segmento || '',
    codigo: d.segmento_codigo || '',
    pool: d.pool_id || '',
    excepcion: d.excepcion || '',
  }));
  await wb.commit(); // cierra el archivo y la respuesta
  return { segmentos, direcciones };
}

module.exports = { escribirLibro };
