// @ts-check
'use strict';
// Reserva en grupo (lote): validación del pedido y comparación de pedidos repetidos. Reglas PURAS (sin base de datos ni red).
// Un pedido es UN grupo: todos sus rangos se reservan, se aprueban y se liberan juntos, aunque sean de varias subredes.
const R = require('./reserva');
const { parse } = require('./cidr');
const { validarNombreGcp } = require('./nombres');
const { AMBIENTES, normalizarAmbiente } = require('./ambiente');

// «vpc» no es un rango de clúster: es el bloque de una VPC nueva (al confirmarlo, IPAM crea el pool hijo con esa identidad).
// El rango principal de una subred es «subnet». «nodos» era su nombre antes y se sigue aceptando como alias de entrada (se guarda y se
// responde siempre como «subnet»).
const USOS = ['subnet', 'pods', 'servicios', 'vpc'];
const ALIAS_USO = { nodos: 'subnet' };
const RANGO_DE = { subnet: 'principal', pods: 'pods', servicios: 'servicios', vpc: 'vpc' };
const ID_POOL = /^[a-z0-9][a-z0-9-]{1,62}$/;
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

/** Un rango pedido: uso, tamaño (máscara o CIDR exacto), nombre opcional y subred opcional (si no, la del pedido). */
function validarRango(r) {
  const entrada = r && typeof r === 'object' ? String(r.uso) : '';
  const uso = ALIAS_USO[entrada] || entrada;
  if (!USOS.includes(uso)) return malo('uso_invalido', `El uso debe ser uno de: ${USOS.join(', ')} («nodos» se acepta como alias de «subnet»).`);
  let pedida = vacio(r.mascara) ? null : Number(r.mascara); // sin máscara: la del pool (mascara_defecto); si no tiene, falta_tamano
  if (pedida !== null && (!Number.isInteger(pedida) || pedida < MASCARA_MIN || pedida > MASCARA_MAX))
    return malo('mascara_invalida', `La máscara de «${uso}» debe ser un entero entre ${MASCARA_MIN} y ${MASCARA_MAX}.`);
  // CIDR exacto (opcional): solo se permite en los ambientes de CIDR_MANUAL_AMBIENTES (se comprueba en normalizarLote).
  let cidr = null;
  if (!vacio(r.cidr)) {
    const c = parse(String(r.cidr).trim());
    if (!c) return malo('cidr_invalido', `El CIDR de «${uso}» no es válido. Formato: 10.210.16.0/25.`);
    if (!c.aligned) return malo('cidr_desalineado', `${String(r.cidr).trim()} no está alineado: la dirección de red debe ser múltiplo de su tamaño.`);
    if (c.len < MASCARA_MIN || c.len > MASCARA_MAX)
      return malo('mascara_invalida', `El CIDR de «${uso}» debe tener una máscara entre ${MASCARA_MIN} y ${MASCARA_MAX}.`);
    if (pedida !== null && pedida !== c.len)
      return malo('mascara_no_coincide', `La máscara (/${pedida}) y el CIDR (${String(r.cidr).trim()}) de «${uso}» no coinciden: indica solo uno.`);
    cidr = String(r.cidr).trim();
    pedida = c.len;
  }
  const nombre = textoOpcional(r.nombre, 80, 'nombre');
  if (!nombre.ok) return nombre;
  const subred = validarNombreGcp(r.subred, 'subred');
  if (!subred.ok) return subred;
  return { ok: true, rango: { uso, mascara: pedida, cidr, nombre: nombre.valor, subred: subred.valor } };
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

/** ¿Se puede pedir un CIDR exacto en este ambiente? Solo si un admin lo habilitó (CIDR_MANUAL_AMBIENTES, apagado por defecto). */
const permiteCidrManual = (config, ambiente) => {
  const lista = (config.reservas && config.reservas.cidrManualAmbientes) || [];
  return lista.includes('todos') || lista.includes(ambiente);
};

/** Valida y normaliza el pedido completo. `grupo` opcional: agrega rangos a un grupo que ya existe. */
function normalizarLote(e, claveHeader, config) {
  const ambiente = normalizarAmbiente(e.ambiente);
  if (!AMBIENTES.includes(/** @type {string} */ (ambiente)))
    return malo('ambiente_invalido', `El ambiente debe ser uno de: ${AMBIENTES.join(', ')} (prd = prod).`);
  const rangos = validarRangos(e.rangos);
  if (!rangos.ok) return rangos;
  if (rangos.rangos.some((r) => r.cidr) && !permiteCidrManual(config, ambiente))
    return malo(
      'cidr_manual_no_permitido',
      `En ${ambiente} un rango no puede pedirse con un CIDR exacto: IPAM lo elige. Pide solo el tamaño (mascara). El CIDR manual se habilita por ambiente con CIDR_MANUAL_AMBIENTES.`,
    );
  // Proyecto, VPC y subred son nombres de GCP: se normalizan (minúsculas, sin espacios en los bordes) y se validan (RFC 1035).
  const proyecto = validarNombreGcp(e.proyecto, 'proyecto');
  if (!proyecto.ok) return malo(proyecto.error, proyecto.mensaje);
  const subredPedido = validarNombreGcp(e.subred, 'subred');
  if (!subredPedido.ok) return malo(subredPedido.error, subredPedido.mensaje);
  if (e.vpc !== undefined && e.vpc !== null && typeof e.vpc !== 'string') return malo('vpc_invalido', 'La VPC debe ser un texto.');
  const vpc = validarNombreGcp(e.vpc, 'vpc');
  if (!vpc.ok) return malo(vpc.error, vpc.mensaje);
  const bloque = validarBloqueVpc(e, rangos.rangos, proyecto.valor, vpc.valor);
  if (!bloque.ok) return bloque;
  if (!vacio(e.grupo) && !UUID.test(String(e.grupo))) return malo('grupo_invalido', 'grupo debe ser el identificador (UUID) de un grupo existente.');
  const ttl = R.validarTtl(e.ttl_horas, { defecto: config.reservas.ttlHoras, max: config.reservas.ttlMaxHoras });
  if (!ttl.ok) return malo(ttl.error, ttl.mensaje);
  const t = R.validarTicket(e.ticket);
  if (!t.ok) return malo(t.error, t.mensaje);
  const k = R.validarClaveIdem(claveHeader);
  if (!k.ok) return malo(k.error, k.mensaje);
  const rangosConSubred = rangos.rangos.map((r) => ({ ...r, subred: r.subred ?? subredPedido.valor }));
  return {
    ok: true,
    d: {
      ambiente,
      rangos: rangosConSubred,
      proyecto: proyecto.valor,
      vpc: vpc.valor || '',
      padre: bloque.padre,
      ticket: t.ticket,
      ttlHoras: ttl.horas,
      clave: k.clave,
      grupo: vacio(e.grupo) ? null : String(e.grupo),
      versionTabla: vacio(e.version_tabla) ? null : String(e.version_tabla).slice(0, 64),
    },
  };
}

/**
 * Reglas del rango «vpc» (bloque de una VPC nueva): va solo, una vez, con proyecto, vpc y máscara, y no se agrega a un grupo.
 * `padre` (opcional) es el pool del que sale el bloque; si falta, el pool de «ambiente + subnet».
 */
function validarBloqueVpc(e, rangos, proyecto, vpc) {
  const bloques = rangos.filter((r) => r.uso === 'vpc');
  const padre = vacio(e.padre) ? null : String(e.padre).trim().toLowerCase();
  if (!bloques.length) return padre ? malo('padre_sin_vpc', '`padre` solo se usa al reservar el bloque de una VPC (uso «vpc»).') : { ok: true, padre: null };
  if (rangos.length !== 1)
    return malo(
      'vpc_no_se_mezcla',
      'El bloque de la VPC se reserva solo y una vez: pide la subnet, los pods y los servicios en otro lote, cuando el bloque esté confirmado.',
    );
  if (!vpc) return malo('vpc_requerida', 'Para reservar el bloque de una VPC indica `vpc`.');
  if (!proyecto) return malo('proyecto_requerido', 'Para reservar el bloque de una VPC indica el `proyecto`.');
  if (bloques[0].mascara === null) return malo('falta_tamano', 'Indica la `mascara` del bloque de la VPC (p. ej. 20).');
  if (!vacio(e.grupo)) return malo('vpc_no_se_mezcla', 'El bloque de la VPC no se agrega a un grupo existente.');
  if (padre && !ID_POOL.test(padre)) return malo('padre_invalido', '`padre` debe ser el id de un pool existente.');
  return { ok: true, padre };
}

const largoDe = (/** @type {string} */ cidr) => Number(String(cidr).split('/')[1]);

/**
 * ¿El pedido repetido es «el mismo» que el grupo ya creado? Compara los rangos (tipo, nombre, subred y tamaño, sin importar el orden)
 * y lo que el agente indicó (proyecto, VPC, ticket); lo que no indicó no cuenta.
 * @param {Array<{rango: string|null, nombre?: string|null, subred?: string|null, cidr: string, proyecto?: string|null, vpc?: string, ticket?: string}>} filas
 */
function mismoLote(filas, d) {
  const pedidos = d.rangos;
  const existentes = filas.map((f) => ({ rango: f.rango, nombre: f.nombre, subred: f.subred, largo: largoDe(f.cidr), cidr: f.cidr }));
  if (pedidos.length !== existentes.length) return false;
  // Se empareja cada rango pedido con uno existente (el comodín «*» acepta cualquier tamaño).
  const libres = [...existentes];
  for (const r of d.rangos) {
    const i = libres.findIndex(
      (f) =>
        f.rango === RANGO_DE[r.uso] &&
        (f.nombre ?? '') === (r.nombre ?? '') &&
        (f.subred ?? '') === (r.subred ?? '') &&
        (r.mascara === null || f.largo === r.mascara) &&
        (!r.cidr || f.cidr === r.cidr),
    );
    if (i < 0) return false;
    libres.splice(i, 1);
  }
  const f0 = filas[0];
  return (!d.proyecto || f0.proyecto === d.proyecto) && (!d.vpc || f0.vpc === d.vpc) && (!d.ticket || f0.ticket === d.ticket);
}

module.exports = { USOS, ALIAS_USO, RANGO_DE, MASCARA_MIN, MASCARA_MAX, MAX_RANGOS, UUID, normalizarLote, validarRangos, mismoLote };
