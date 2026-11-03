// @ts-check
'use strict';
// Reserva en grupo (lote): validación del pedido y comparación de pedidos repetidos. Reglas PURAS (sin base de datos ni red).
// Un pedido es UN grupo: todos sus rangos se reservan, se aprueban y se liberan juntos, aunque sean de varias subredes.
const R = require('./reserva');
const { validarNombres } = require('./nombres');
const { AMBIENTES, normalizarAmbiente } = require('./ambiente');

const USOS = ['nodos', 'pods', 'servicios'];
const RANGO_DE = { nodos: 'principal', pods: 'pods', servicios: 'servicios' };
// Una subred de GCP no admite más chico que /29. El tamaño por defecto, el mínimo y el máximo de cada pool los define el admin (pool).
const MASCARA_MIN = 8;
const MASCARA_MAX = 29;
const MAX_RANGOS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIN_CONTROL = /^[^\p{Cc}]+$/u;
const malo = (error, mensaje) => ({ ok: /** @type {false} */ (false), error, mensaje });
const vacio = (v) => v === undefined || v === null || String(v).trim() === '';

/** Texto opcional de hasta `max` caracteres, sin caracteres de control. */
function textoOpcional(v, max, etiqueta) {
  if (vacio(v)) return { ok: true, valor: null };
  const t = String(v).trim();
  if (t.length > max || !SIN_CONTROL.test(t)) return malo(`${etiqueta}_invalido`, `${etiqueta} admite hasta ${max} caracteres.`);
  return { ok: true, valor: t };
}

/** Un rango pedido: uso, máscara (o la de GKE por defecto), nombre opcional y subred opcional (si no, la del pedido). */
function validarRango(r) {
  const uso = r && typeof r === 'object' ? String(r.uso) : '';
  if (!USOS.includes(uso)) return malo('uso_invalido', `El uso debe ser uno de: ${USOS.join(', ')}.`);
  const pedida = vacio(r.mascara) ? null : Number(r.mascara); // sin máscara: la del pool (mascara_defecto); si no tiene, falta_tamano
  if (pedida !== null && (!Number.isInteger(pedida) || pedida < MASCARA_MIN || pedida > MASCARA_MAX))
    return malo('mascara_invalida', `La máscara de «${uso}» debe ser un entero entre ${MASCARA_MIN} y ${MASCARA_MAX}.`);
  const nombre = textoOpcional(r.nombre, 80, 'nombre');
  if (!nombre.ok) return nombre;
  const subred = textoOpcional(r.subred, 80, 'subred');
  if (!subred.ok) return subred;
  return { ok: true, rango: { uso, mascara: pedida, nombre: nombre.valor, subred: subred.valor } };
}

/** La lista de rangos: de 1 a 20, en el orden pedido (sirve para varias subredes y para varios rangos del mismo uso). */
function validarRangos(lista) {
  if (!Array.isArray(lista) || !lista.length || lista.length > MAX_RANGOS) return malo('rangos_invalidos', `Indica de 1 a ${MAX_RANGOS} rangos.`);
  const salida = [];
  for (const r of lista) {
    const v = validarRango(r);
    if (!v.ok) return v;
    salida.push(v.rango);
  }
  return { ok: true, rangos: salida };
}

/** Valida y normaliza el pedido completo. `grupo` opcional: agrega rangos a un grupo que ya existe. */
function normalizarLote(e, claveHeader, config) {
  const ambiente = normalizarAmbiente(e.ambiente);
  if (!AMBIENTES.includes(/** @type {string} */ (ambiente)))
    return malo('ambiente_invalido', `El ambiente debe ser uno de: ${AMBIENTES.join(', ')} (prd = prod).`);
  const rangos = validarRangos(e.rangos);
  if (!rangos.ok) return rangos;
  const nom = validarNombres(e);
  if (!nom.ok) return malo(nom.error, nom.mensaje);
  if (e.vpc !== undefined && e.vpc !== null && (typeof e.vpc !== 'string' || e.vpc.trim().length > 120))
    return malo('vpc_invalido', 'La VPC admite hasta 120 caracteres.');
  if (!vacio(e.grupo) && !UUID.test(String(e.grupo))) return malo('grupo_invalido', 'grupo debe ser el identificador (UUID) de un grupo existente.');
  const ttl = R.validarTtl(e.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
  if (!ttl.ok) return malo(ttl.error, ttl.mensaje);
  const t = R.validarTicket(e.ticket);
  if (!t.ok) return malo(t.error, t.mensaje);
  const k = R.validarClaveIdem(claveHeader);
  if (!k.ok) return malo(k.error, k.mensaje);
  const rangosConSubred = rangos.rangos.map((r) => ({ ...r, subred: r.subred ?? nom.subred }));
  return {
    ok: true,
    d: {
      ambiente,
      rangos: rangosConSubred,
      proyecto: nom.proyecto,
      vpc: (e.vpc || '').trim(),
      ticket: t.ticket,
      ttlHoras: ttl.horas,
      clave: k.clave,
      grupo: vacio(e.grupo) ? null : String(e.grupo),
      versionTabla: vacio(e.version_tabla) ? null : String(e.version_tabla).slice(0, 64),
    },
  };
}

const largoDe = (/** @type {string} */ cidr) => Number(String(cidr).split('/')[1]);

/**
 * ¿El pedido repetido es «el mismo» que el grupo ya creado? Compara los rangos (tipo, nombre, subred y tamaño, sin importar el orden)
 * y lo que el agente indicó (proyecto, VPC, ticket); lo que no indicó no cuenta.
 * @param {Array<{rango: string|null, nombre?: string|null, subred?: string|null, cidr: string, proyecto?: string|null, vpc?: string, ticket?: string}>} filas
 */
function mismoLote(filas, d) {
  const pedidos = d.rangos;
  const existentes = filas.map((f) => ({ rango: f.rango, nombre: f.nombre, subred: f.subred, largo: largoDe(f.cidr) }));
  if (pedidos.length !== existentes.length) return false;
  // Se empareja cada rango pedido con uno existente (el comodín «*» acepta cualquier tamaño).
  const libres = [...existentes];
  for (const r of d.rangos) {
    const i = libres.findIndex(
      (f) =>
        f.rango === RANGO_DE[r.uso] &&
        (f.nombre ?? '') === (r.nombre ?? '') &&
        (f.subred ?? '') === (r.subred ?? '') &&
        (r.mascara === null || f.largo === r.mascara),
    );
    if (i < 0) return false;
    libres.splice(i, 1);
  }
  const f0 = filas[0];
  return (!d.proyecto || f0.proyecto === d.proyecto) && (!d.vpc || f0.vpc === d.vpc) && (!d.ticket || f0.ticket === d.ticket);
}

module.exports = { USOS, RANGO_DE, MASCARA_MIN, MASCARA_MAX, MAX_RANGOS, UUID, normalizarLote, validarRangos, mismoLote };
