// @ts-check
'use strict';
// Importación masiva de segmentos que ya existen (Excel/CSV): reglas PURAS de análisis. No toca la base ni lee archivos.
//  Estados de cada fila:
//   ok                 se puede importar tal cual
//   ya_existe          ese segmento ya está registrado en el mismo pool: se omite (importar dos veces no duplica)
//   solapa_otro_pool   se solapa con un segmento de OTRO pool: se alerta y un admin debe aprobarlo o rechazarlo
//   choca_mismo_pool   se solapa con otro del MISMO pool: no se puede importar (la base lo impide siempre)
//   invalida           dato inválido (CIDR mal escrito, desalineado, proveedor o ambiente inválido…)
const { parse, overlap, contenido, n2ip } = require('./cidr');

const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
const ESTADOS = ['ok', 'ya_existe', 'solapa_otro_pool', 'choca_mismo_pool', 'invalida'];
const MAX_FILAS = 5000;

/** Bloque «familia» del que se cuelga el pool automático: las redes privadas (RFC 1918) y, si no, el /8 de la primera dirección. */
function familia(/** @type {{start: number}} */ c) {
  const a = Math.floor(c.start / 16777216);
  const b = Math.floor(c.start / 65536) % 256;
  if (a === 10) return { sufijo: '10', cidr: '10.0.0.0/8' };
  if (a === 172 && b >= 16 && b <= 31) return { sufijo: '172', cidr: '172.16.0.0/12' };
  if (a === 192 && b === 168) return { sufijo: '192', cidr: '192.168.0.0/16' };
  return { sufijo: `pub${a}`, cidr: `${a}.0.0.0/8` };
}
const slug = (/** @type {string} */ t) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/**
 * @typedef {{n: number, cidr: string, vpc?: string, proveedor?: string, ambiente?: string, tipo?: string, ticket?: string, descripcion?: string}} FilaEntrada
 * @typedef {{id: string, tipo: string, ambiente: string, proveedor: string, cidr: string}} Pool
 * @typedef {{pool_id: string, cidr: string, vpc?: string}} Ocupado
 * @typedef {NonNullable<ReturnType<typeof parse>>} Cidr
 */

/** Valida y normaliza una fila. Devuelve el error (con sugerencia si la hay) o los datos listos. */
function validarFila(/** @type {FilaEntrada} */ f, /** @type {{proveedor?: string, ambiente?: string, tipo?: string}} */ defectos) {
  const cidr = String(f.cidr || '').trim();
  const c = parse(cidr);
  if (!c) return { error: 'CIDR inválido: debe verse como 10.20.0.0/24.' };
  if (!c.aligned) {
    const tam = 2 ** (32 - c.len);
    const red = `${n2ip(Math.floor(c.start / tam) * tam)}/${c.len}`;
    return { error: `El segmento no está alineado a su máscara (parece una dirección con máscara, no una red). ¿Quisiste ${red}?`, sugerido: red };
  }
  if (c.len < 8) return { error: 'Demasiado grande: la máscara mínima es /8.' };
  const proveedor = String(f.proveedor || defectos.proveedor || '').trim();
  if (!proveedor || proveedor.length > 40) return { error: 'Falta el proveedor (p. ej. GCP u On-prem), en la fila o como valor por defecto.' };
  const ambiente = String(f.ambiente || defectos.ambiente || '')
    .trim()
    .toLowerCase();
  if (!AMBIENTES.includes(ambiente)) return { error: `Ambiente inválido o ausente («${ambiente || 'vacío'}»): usa ${AMBIENTES.join(', ')}.` };
  const tipo = String(f.tipo || defectos.tipo || 'Importado')
    .trim()
    .slice(0, 40);
  const vpc =
    String(f.vpc || '').trim() ||
    String(f.descripcion || '')
      .trim()
      .slice(0, 120) ||
    'sin-nombre';
  return { datos: { c, cidr, proveedor, ambiente, tipo, vpc, ticket: String(f.ticket || '').trim() || 'IMPORTADO' } };
}

/** Pool destino: el existente más pequeño del mismo proveedor y ambiente que contiene al segmento; si no, uno automático por familia. */
function elegirPool(d, poolsC, poolsNuevos) {
  const candidatos = poolsC
    .filter((p) => p.proveedor.toLowerCase() === d.proveedor.toLowerCase() && p.ambiente === d.ambiente && contenido(d.c, p.c))
    .sort((x, y) => y.c.len - x.c.len);
  if (candidatos.length) return { pool: candidatos[0], nuevo: false };
  const fam = familia(d.c);
  const id = `imp-${slug(d.proveedor)}-${d.ambiente}-${fam.sufijo}`;
  if (poolsC.some((p) => p.id === id)) return { error: `El pool ${id} ya existe pero no contiene a ${d.cidr}.` };
  const pool = poolsNuevos.get(id) || { id, tipo: 'Importado', ambiente: d.ambiente, proveedor: d.proveedor, cidr: fam.cidr };
  poolsNuevos.set(id, pool);
  return { pool, nuevo: true };
}

/** Clasifica una fila válida según sus choques con lo registrado y con las filas anteriores del archivo. */
function clasificar(fila, pool, nuevo, d, existentes, previas) {
  const choques = [
    ...existentes.filter((o) => overlap(o.c, d.c)).map((o) => ({ pool_id: o.pool_id, cidr: o.cidr, vpc: o.vpc, origen: 'registrado' })),
    ...previas.filter((o) => overlap(o.c, d.c)).map((o) => ({ pool_id: o.pool_id, cidr: o.cidr, vpc: o.vpc, origen: 'archivo' })),
  ];
  const duplicado = choques.find((x) => x.pool_id === pool.id && x.cidr === d.cidr && x.origen === 'registrado');
  const mismo = choques.find((x) => x.pool_id === pool.id);
  const otro = choques.find((x) => x.pool_id !== pool.id);
  const donde = (/** @type {{origen: string}} */ x) => (x.origen === 'archivo' ? ' (otra fila del archivo)' : '');
  if (duplicado) return { ...fila, estado: 'ya_existe', detalle: `Ya está registrado en ${pool.id}: se omite.`, registrada: false };
  if (mismo)
    return {
      ...fila,
      estado: 'choca_mismo_pool',
      detalle: `Se solapa con ${mismo.cidr} (${mismo.vpc || 'sin nombre'}) en el mismo pool ${pool.id}${donde(mismo)}: no se puede importar.`,
      choca_con: mismo,
      registrada: true,
    };
  if (otro)
    return {
      ...fila,
      estado: 'solapa_otro_pool',
      detalle: `Se solapa con ${otro.cidr} (${otro.vpc || 'sin nombre'}) del pool ${otro.pool_id}${donde(otro)}. Un admin debe aprobarlo o rechazarlo.`,
      choca_con: otro,
      registrada: true,
    };
  return { ...fila, estado: 'ok', detalle: nuevo ? `Se creará el pool ${pool.id} (${pool.cidr}).` : `Entra en ${pool.id}.`, registrada: true };
}

/**
 * Analiza las filas contra los pools y lo ocupado. No escribe nada.
 * @param {{filas: FilaEntrada[], pools: Pool[], ocupados: Ocupado[], defectos?: {proveedor?: string, ambiente?: string, tipo?: string}}} e
 */
function analizar({ filas, pools, ocupados, defectos = {} }) {
  const existentes = ocupados.flatMap((o) => {
    const c = parse(o.cidr);
    return c ? [{ pool_id: o.pool_id, cidr: o.cidr, vpc: o.vpc || '', c }] : [];
  });
  const poolsC = pools.flatMap((p) => {
    const c = parse(p.cidr);
    return c ? [{ ...p, c }] : [];
  });
  /** @type {Map<string, Pool>} */
  const poolsNuevos = new Map();
  /** @type {Array<{pool_id: string, cidr: string, vpc: string, c: Cidr}>} */
  const previas = []; // filas ya analizadas (no inválidas): las posteriores se comparan con ellas
  /** @type {any[]} */
  const salida = [];

  for (const f of filas) {
    const base = { n: f.n, cidr: String(f.cidr || '').trim(), vpc: String(f.vpc || '').trim(), ticket: String(f.ticket || '').trim() };
    const v = validarFila(f, defectos);
    if (!v.datos) {
      salida.push({
        ...base,
        proveedor: '',
        ambiente: '',
        tipo: '',
        estado: 'invalida',
        pool: null,
        detalle: v.error,
        ...(v.sugerido ? { sugerido: v.sugerido } : {}),
      });
      continue;
    }
    const d = v.datos;
    const destino = elegirPool(d, poolsC, poolsNuevos);
    if (!destino.pool) {
      salida.push({ ...base, proveedor: d.proveedor, ambiente: d.ambiente, tipo: d.tipo, estado: 'invalida', pool: null, detalle: destino.error });
      continue;
    }
    const fila = {
      ...base,
      vpc: d.vpc,
      ticket: d.ticket,
      proveedor: d.proveedor,
      ambiente: d.ambiente,
      tipo: d.tipo,
      pool: destino.pool.id,
      pool_nuevo: destino.nuevo,
    };
    const { registrada, ...resultado } = clasificar(fila, destino.pool, destino.nuevo, d, existentes, previas);
    salida.push(resultado);
    if (registrada) previas.push({ pool_id: destino.pool.id, cidr: d.cidr, vpc: d.vpc, c: d.c });
  }

  const resumen = Object.fromEntries(ESTADOS.map((e) => [e, salida.filter((s) => s.estado === e).length]));
  const usados = new Set(salida.filter((s) => s.estado === 'ok' || s.estado === 'solapa_otro_pool').map((s) => s.pool));
  const pools_a_crear = [...poolsNuevos.values()].filter((p) => usados.has(p.id));
  return { total: salida.length, resumen, pools_a_crear, filas: salida };
}

/** Qué filas se importan: las `ok` y las `solapa_otro_pool` que un admin aprobó. @template {{n: number, estado: string}} T @param {T[]} filas @param {number[]} aprobadas */
const seleccionar = (filas, aprobadas) => filas.filter((f) => f.estado === 'ok' || (f.estado === 'solapa_otro_pool' && aprobadas.includes(f.n)));

module.exports = { analizar, seleccionar, AMBIENTES, ESTADOS, MAX_FILAS };
