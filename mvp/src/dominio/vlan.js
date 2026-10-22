// @ts-check
'use strict';
// VLAN opcional de un segmento: número (1–4094, IEEE 802.1Q) y nombre de la VLAN o subred. Ambos pueden faltar.

const SIN_CONTROL = /^[^\p{Cc}]{1,80}$/u;
const vacio = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Valida y normaliza. Acepta el número como entero o texto («210»); el nombre se recorta.
 * @param {{vlan?: unknown, vlan_nombre?: unknown}} e
 * @returns {{ok: true, vlan: number|null, vlan_nombre: string|null} | {ok: false, error: string, mensaje: string}}
 */
function validarVlan(e) {
  let vlan = null;
  if (!vacio(e.vlan)) {
    const n = Number(String(e.vlan).trim());
    if (!Number.isInteger(n) || n < 1 || n > 4094) return { ok: false, error: 'vlan_invalida', mensaje: 'La VLAN debe ser un número entero entre 1 y 4094.' };
    vlan = n;
  }
  let vlan_nombre = null;
  if (!vacio(e.vlan_nombre)) {
    const t = String(e.vlan_nombre).trim();
    if (!SIN_CONTROL.test(t)) return { ok: false, error: 'vlan_nombre_invalido', mensaje: 'El nombre de la VLAN o subred admite hasta 80 caracteres.' };
    vlan_nombre = t;
  }
  return { ok: true, vlan, vlan_nombre };
}

module.exports = { validarVlan };
