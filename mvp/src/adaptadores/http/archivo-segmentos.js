'use strict';
// Lee un Excel (.xlsx) o un CSV con segmentos y lo convierte en filas para la importación. Solo lectura de formato:
// las reglas de negocio (qué se puede importar) están en dominio/importacion.js.
const ExcelJS = require('exceljs');
const { MAX_FILAS } = require('../../dominio/importacion');

// Nombres de columna aceptados (sin tildes ni mayúsculas): cada campo del IPAM → posibles encabezados del archivo.
const ALIAS = {
  cidr: ['cidr', 'prefijo', 'prefix', 'segmento', 'red', 'subred', 'rango', 'direccion ip', 'network'],
  vpc: ['vpc', 'proyecto', 'project', 'nombre', 'name', 'inquilino', 'tenant', 'proyecto / vpc', 'proyecto vpc'],
  proveedor: ['proveedor', 'provider', 'nube', 'cloud', 'sitio', 'site', 'origen'],
  ambiente: ['ambiente', 'environment', 'entorno', 'env'],
  tipo: ['tipo', 'type', 'rol', 'role', 'funcion'],
  ticket: ['ticket', 'referencia', 'id', 'ref'],
  vlan: ['vlan', 'vlan id', 'vlan_id', 'id vlan', 'vid'],
  vlan_nombre: ['nombre vlan / subred', 'nombre vlan', 'nombre de vlan', 'vlan nombre', 'vlan name', 'nombre subred', 'nombre de subred', 'subnet name'],
  descripcion: ['descripcion', 'description', 'comentario', 'comentarios', 'observacion', 'notas'],
};
const sinTildes = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** Valor de una celda como texto (las celdas con fórmula, hipervínculo o texto enriquecido traen objetos). */
function textoDeCelda(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('result' in v) return textoDeCelda(v.result);
    if ('text' in v) return textoDeCelda(v.text);
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
    return '';
  }
  return String(v).trim();
}

/** CSV con comillas dobles; detecta el separador (coma, punto y coma o tabulador). */
function leerCsv(texto) {
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const primera = t.split(/\r?\n/, 1)[0] || '';
  const sep = [';', '\t', ','].map((s) => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const filas = [];
  let fila = [],
    campo = '',
    entre = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (entre) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') entre = false;
      else campo += c;
    } else if (c === '"') entre = true;
    else if (c === sep) {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo !== '' || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas.map((f) => f.map((x) => x.trim()));
}

async function leerXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const hoja = wb.worksheets[0];
  if (!hoja) return [];
  const filas = [];
  hoja.eachRow({ includeEmpty: false }, (row) => {
    const celdas = [];
    for (let c = 1; c <= row.cellCount; c++) celdas.push(textoDeCelda(row.getCell(c).value));
    filas.push(celdas);
  });
  return filas;
}

/**
 * @param {{formato: 'xlsx'|'csv', buffer: Buffer}} e
 * @returns {Promise<{ok: true, filas: Array<Record<string, string|number>>, columnas: Record<string, string>, ignoradas: string[]} | {ok: false, error: string, mensaje: string}>}
 */
async function leerSegmentos({ formato, buffer }) {
  let matriz;
  try {
    matriz = formato === 'csv' ? leerCsv(buffer.toString('utf8')) : await leerXlsx(buffer);
  } catch {
    return {
      ok: false,
      error: 'archivo_ilegible',
      mensaje: formato === 'csv' ? 'No se pudo leer el CSV.' : 'No se pudo leer el Excel: ¿es un archivo .xlsx válido?',
    };
  }
  // El encabezado es la primera fila que tenga una columna reconocible como CIDR.
  const idx = matriz.findIndex((f) => f.some((c) => ALIAS.cidr.includes(sinTildes(c))));
  if (idx < 0)
    return {
      ok: false,
      error: 'sin_columna_cidr',
      mensaje: `No encontré la columna del segmento. Ponle de encabezado uno de: ${ALIAS.cidr.slice(0, 5).join(', ')}.`,
    };
  const cab = matriz[idx].map(sinTildes);
  /** @type {Record<string, number>} */
  const col = {};
  /** @type {Record<string, string>} */
  const columnas = {};
  for (const [campo, nombres] of Object.entries(ALIAS)) {
    const i = cab.findIndex((c) => nombres.includes(c));
    if (i >= 0) {
      col[campo] = i;
      columnas[campo] = matriz[idx][i];
    }
  }
  const usados = new Set(Object.values(col));
  const ignoradas = matriz[idx].filter((c, i) => c && !usados.has(i));
  const datos = matriz.slice(idx + 1).flatMap((f, k) => {
    if (f.every((c) => !c)) return [];
    const fila = { n: idx + k + 2 }; // número de fila tal como se ve en el archivo
    for (const campo of Object.keys(ALIAS)) fila[campo] = col[campo] === undefined ? '' : f[col[campo]] || '';
    return [fila];
  });
  if (datos.length > MAX_FILAS)
    return {
      ok: false,
      error: 'demasiadas_filas',
      mensaje: `El archivo tiene ${datos.length} filas; el máximo por importación es ${MAX_FILAS}. Divídelo en partes.`,
    };
  return { ok: true, filas: datos, columnas, ignoradas };
}

module.exports = { leerSegmentos, ALIAS };
