// @ts-check
'use strict';
// Nombres opcionales de un segmento: el proyecto al que pertenece y el nombre de su subred. La VPC va aparte (obligatoria).

const SIN_CONTROL = /^[^\p{Cc}]+$/u;
const vacio = (v) => v === undefined || v === null || String(v).trim() === '';
const CAMPOS = [
  { campo: 'proyecto', max: 120, etiqueta: 'proyecto' },
  { campo: 'subred', max: 80, etiqueta: 'subred' },
];

/**
 * Valida y normaliza (recorta). Ambos pueden faltar.
 * @param {{proyecto?: unknown, subred?: unknown}} e
 * @returns {{ok: true, proyecto: string|null, subred: string|null} | {ok: false, error: string, mensaje: string}}
 */
function validarNombres(e) {
  const salida = { proyecto: null, subred: null };
  for (const { campo, max, etiqueta } of CAMPOS) {
    if (vacio(e[campo])) continue;
    const t = String(e[campo]).trim();
    if (t.length > max || !SIN_CONTROL.test(t))
      return { ok: false, error: `${campo}_invalido`, mensaje: `El nombre de ${etiqueta} admite hasta ${max} caracteres.` };
    salida[campo] = t;
  }
  return { ok: true, proyecto: salida.proyecto, subred: salida.subred };
}

module.exports = { validarNombres };
