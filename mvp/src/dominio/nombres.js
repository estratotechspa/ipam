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

// Nombres de recursos de GCP (proyecto, VPC, subred): RFC 1035, en minúsculas. Los espacios de los bordes se recortan y las mayúsculas se
// pasan a minúsculas; un espacio, un guion bajo u otro símbolo DENTRO del nombre se rechaza (GCP no lo acepta).
const RFC1035 = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * Normaliza y valida un nombre de GCP. Vacío → null (opcional). Devuelve el error con código estable `<campo>_invalido`.
 * @param {unknown} v @param {string} campo
 * @returns {{ok: true, valor: string|null} | {ok: false, error: string, mensaje: string}}
 */
function validarNombreGcp(v, campo) {
  if (vacio(v)) return { ok: true, valor: null };
  const t = String(v).trim().toLowerCase();
  if (!RFC1035.test(t))
    return {
      ok: false,
      error: `${campo}_invalido`,
      mensaje: `${campo} «${String(v).slice(0, 80)}» no cumple el formato de nombres de GCP (RFC 1035): minúsculas, números y guiones, empieza con letra, no termina en guion, hasta 63 caracteres y sin espacios.`,
    };
  return { ok: true, valor: t };
}

module.exports = { validarNombres, validarNombreGcp, RFC1035 };
