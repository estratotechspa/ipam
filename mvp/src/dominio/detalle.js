// @ts-check
'use strict';
// Datos descriptivos opcionales de un segmento: descripción libre, responsable, uso del rango y fecha original de creación
// (para segmentos que ya existían antes del IPAM). Todos pueden faltar.

const SIN_CONTROL = /^[^\p{Cc}]+$/u;
const vacio = (/** @type {unknown} */ v) => v === undefined || v === null || String(v).trim() === '';
const CAMPOS = [
  { campo: 'descripcion', max: 500, etiqueta: 'la descripción' },
  { campo: 'responsable', max: 120, etiqueta: 'el responsable' },
  { campo: 'uso', max: 60, etiqueta: 'el uso' },
];
const ANIO_MINIMO = 1990;
const UN_DIA = 86400000;

/**
 * Fecha original → ISO (UTC, mediodía, para que no cambie de día en ninguna zona horaria). Acepta `2024-08-29` (con hora opcional,
 * que se descarta: solo importa el día) y `29/08/2024` o `29-08-2024` (día primero). Devuelve null si no es una fecha real.
 * @param {unknown} v @param {Date} [ahora]
 * @returns {string|null}
 */
function parsearFecha(v, ahora = new Date()) {
  const t = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(t);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  const [a, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!a) return null;
  const f = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d), 12));
  if (f.getUTCFullYear() !== Number(a) || f.getUTCMonth() !== Number(m) - 1 || f.getUTCDate() !== Number(d)) return null; // 31/02, mes 13…
  if (Number(a) < ANIO_MINIMO || f.getTime() > ahora.getTime() + UN_DIA) return null; // anterior a 1990 o en el futuro
  return f.toISOString();
}

/**
 * Valida y normaliza (recorta). `fecha` es la de creación original; si falta, el IPAM usa la de la importación.
 * @param {{descripcion?: unknown, responsable?: unknown, uso?: unknown, fecha?: unknown}} e @param {Date} [ahora]
 * @returns {{ok: true, descripcion: string|null, responsable: string|null, uso: string|null, creado_en: string|null} | {ok: false, error: string, mensaje: string}}
 */
function validarDetalle(e, ahora = new Date()) {
  /** @type {Record<string, string|null>} */
  const salida = { descripcion: null, responsable: null, uso: null };
  for (const { campo, max, etiqueta } of CAMPOS) {
    const valor = /** @type {Record<string, unknown>} */ (e)[campo];
    if (vacio(valor)) continue;
    const t = String(valor).trim();
    if (t.length > max || !SIN_CONTROL.test(t)) return { ok: false, error: `${campo}_invalido`, mensaje: `${cap(etiqueta)} admite hasta ${max} caracteres.` };
    salida[campo] = t;
  }
  let creado_en = null;
  if (!vacio(e.fecha)) {
    creado_en = parsearFecha(e.fecha, ahora);
    if (!creado_en)
      return {
        ok: false,
        error: 'fecha_invalida',
        mensaje: `Fecha inválida («${String(e.fecha).slice(0, 30)}»): usa día/mes/año (29/08/2024) o año-mes-día (2024-08-29), sin fechas futuras.`,
      };
  }
  return { ok: true, descripcion: salida.descripcion, responsable: salida.responsable, uso: salida.uso, creado_en };
}
const cap = (/** @type {string} */ t) => t.charAt(0).toUpperCase() + t.slice(1);

module.exports = { validarDetalle, parsearFecha };
