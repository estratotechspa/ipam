// @ts-check
'use strict';
// Plan para llevar las asignaciones de un pool grande (p. ej. dev-gcp-ccla, donde conviven varias VPC) a pools hijos, uno por VPC.
// Reglas PURAS: no leen la base ni escriben nada. El resultado es un plan que una persona revisa antes de aplicarlo.
const { parse, overlap, contenido, aTexto, n2ip } = require('./cidr');
const { validarNombreGcp, RFC1035 } = require('./nombres');

const FATALES = [
  'vpc_invalido',
  'sin_proyecto',
  'vpc_incoherente',
  'bloque_igual_al_padre',
  'bloques_solapados',
  'bloque_con_ajenas',
  'reserva_vigente_en_bloque',
  'pool_hijo_solapado',
  'bloque_invalido',
];

/** Sugerencia de nombre válido para uno que no lo es (minúsculas, símbolos a guion). @param {string} v */
const sugerirNombre = (v) =>
  v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);

/** El bloque alineado más chico que contiene todos los rangos. @param {Array<NonNullable<ReturnType<typeof parse>>>} rangos */
function bloqueCubriente(rangos) {
  const ini = Math.min(...rangos.map((r) => r.start));
  const fin = Math.max(...rangos.map((r) => r.end));
  for (let largo = 32; largo >= 0; largo--) {
    const tam = 2 ** (32 - largo);
    const base = Math.floor(ini / tam) * tam;
    if (base + tam - 1 >= fin) return parse(`${n2ip(base)}/${largo}`);
  }
  return null;
}

/**
 * @typedef {{id: number|string, cidr: string, vpc?: string|null, proyecto?: string|null}} Asignacion
 * @typedef {{vpc: string, proyecto?: string, cidr?: string, id?: string}} Ajuste  Decisión humana para una VPC (proyecto, bloque o id del pool).
 */

/** El proyecto de una VPC: el del ajuste o el único que traen sus asignaciones; si no hay o son varios, un problema. */
function proyectoDe(vpc, filas, aj, problemas) {
  const proyectos = [
    ...new Set(
      filas
        .map((f) =>
          String(f.proyecto ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
  const proyecto = aj.proyecto ? String(aj.proyecto).trim().toLowerCase() : proyectos.length === 1 ? proyectos[0] : '';
  if (proyectos.length > 1 && !aj.proyecto)
    problemas.push({
      tipo: 'vpc_incoherente',
      vpc,
      detalle: `La VPC «${vpc}» figura con ${proyectos.length} proyectos (${proyectos.join(', ')}). Indica el correcto en un ajuste.`,
      proyectos,
    });
  else if (!proyecto) problemas.push({ tipo: 'sin_proyecto', vpc, detalle: `La VPC «${vpc}» no tiene proyecto en sus asignaciones. Indícalo en un ajuste.` });
  else if (!validarNombreGcp(proyecto, 'proyecto').ok)
    problemas.push({ tipo: 'vpc_invalido', vpc, detalle: `El proyecto «${proyecto}» no es un nombre de GCP válido.` });
  return proyecto;
}

/** El bloque de una VPC (el del ajuste o el más chico que contiene sus asignaciones), validado contra el padre. Null si no sirve. */
function bloqueDe(vpc, filas, aj, padre, cPadre, problemas) {
  const rangos = filas.map((f) => parse(f.cidr));
  const bloque = aj.cidr ? parse(aj.cidr) : rangos.every(Boolean) ? bloqueCubriente(/** @type {any} */ (rangos)) : null;
  if (!bloque || !bloque.aligned || !cPadre || !contenido(bloque, cPadre)) {
    problemas.push({
      tipo: 'bloque_invalido',
      vpc,
      detalle: `El bloque de «${vpc}» (${aj.cidr || 'calculado'}) no es un CIDR alineado dentro de ${padre.cidr}.`,
    });
    return null;
  }
  if (bloque.len === cPadre.len)
    problemas.push({
      tipo: 'bloque_igual_al_padre',
      vpc,
      detalle: `Las asignaciones de «${vpc}» cubren todo ${padre.id}: un hijo debe ser más chico. Indica un bloque en un ajuste o deja esa VPC en el padre.`,
    });
  if (rangos.some((r) => r && !contenido(r, bloque)))
    problemas.push({ tipo: 'bloque_invalido', vpc, detalle: `El bloque ${aTexto(bloque)} no contiene todas las asignaciones de «${vpc}».` });
  return bloque;
}

/** Los bloques no se pisan entre sí, no contienen asignaciones de otra VPC (ni sin VPC), no tapan reservas vigentes ni pools hijos que ya existen. */
function revisarCruces(grupos, asignaciones, reservasVigentes, hijosExistentes, problemas) {
  const cruzan = (g, lista) => lista.filter((x) => parse(x.cidr) && overlap(g.c, /** @type {any} */ (parse(x.cidr))));
  for (let i = 0; i < grupos.length; i++) {
    const g = grupos[i];
    for (let j = i + 1; j < grupos.length; j++)
      if (overlap(g.c, grupos[j].c))
        problemas.push({
          tipo: 'bloques_solapados',
          vpc: g.vpc,
          detalle: `Los bloques de «${g.vpc}» (${g.cidr}) y «${grupos[j].vpc}» (${grupos[j].cidr}) se pisan. Ajusta uno de los dos.`,
        });
    const ajenas = cruzan(g, asignaciones).filter((a) => !g.ids.includes(a.id));
    if (ajenas.length)
      problemas.push({
        tipo: 'bloque_con_ajenas',
        vpc: g.vpc,
        detalle: `El bloque ${g.cidr} de «${g.vpc}» contiene ${ajenas.length} asignaciones de otras VPC o sin VPC (${ajenas
          .slice(0, 3)
          .map((a) => a.cidr)
          .join(', ')}…).`,
      });
    const reservas = cruzan(g, reservasVigentes);
    if (reservas.length)
      problemas.push({
        tipo: 'reserva_vigente_en_bloque',
        vpc: g.vpc,
        detalle: `Hay ${reservas.length} reservas vigentes dentro de ${g.cidr}: confírmalas, libéralas o espera a que expiren.`,
      });
    const hijos = cruzan(g, hijosExistentes);
    if (hijos.length) problemas.push({ tipo: 'pool_hijo_solapado', vpc: g.vpc, detalle: `El bloque ${g.cidr} pisa al pool hijo ${hijos[0].id}.` });
  }
}

/** Ids de los pools: el nombre de la VPC; si ya existe otro pool con ese id (o dos VPC lo piden), «proyecto-vpc». */
function asignarIds(grupos, idsEnUso, problemas) {
  const usados = new Set(idsEnUso);
  for (const g of grupos) {
    const id = [g.idSugerido, g.vpc, `${g.proyecto}-${g.vpc}`.slice(0, 63).replace(/-+$/, '')].filter(Boolean).find((c) => !usados.has(c));
    if (!id) problemas.push({ tipo: 'bloque_invalido', vpc: g.vpc, detalle: `No hay un id libre para el pool de «${g.vpc}».` });
    else usados.add(id);
    g.pool_id = id || '';
  }
}

/**
 * @param {{padre: {id: string, cidr: string}, asignaciones: Asignacion[], reservasVigentes?: Array<{cidr: string}>, hijosExistentes?: Array<{id: string, cidr: string}>,
 *   idsEnUso?: string[], ajustes?: Ajuste[]}} e
 */
function planificar({ padre, asignaciones, reservasVigentes = [], hijosExistentes = [], idsEnUso = [], ajustes = [] }) {
  const problemas = [];
  const cPadre = parse(padre.cidr);
  const porVpc = new Map();
  const sinVpc = [];
  for (const a of asignaciones) {
    const nombre = String(a.vpc ?? '')
      .trim()
      .toLowerCase();
    if (nombre) porVpc.set(nombre, [...(porVpc.get(nombre) || []), a]);
    else sinVpc.push(a);
  }
  const avisos = sinVpc.length
    ? [{ tipo: 'sin_vpc', detalle: `${sinVpc.length} asignaciones sin nombre de VPC se quedan en ${padre.id}.`, cidrs: sinVpc.map((a) => a.cidr) }]
    : [];
  const grupos = [];
  for (const [vpc, filas] of [...porVpc.entries()].sort()) {
    const aj = /** @type {Ajuste} */ (ajustes.find((x) => String(x.vpc).trim().toLowerCase() === vpc) || {});
    if (!RFC1035.test(vpc))
      problemas.push({
        tipo: 'vpc_invalido',
        vpc,
        detalle: `«${vpc}» no es un nombre de GCP válido. Sugerencia: «${sugerirNombre(vpc)}» (corrígelo en las asignaciones o indica el nombre en el ajuste).`,
      });
    const proyecto = proyectoDe(vpc, filas, aj, problemas);
    const bloque = bloqueDe(vpc, filas, aj, padre, cPadre, problemas);
    if (bloque)
      grupos.push({ vpc, proyecto, cidr: aTexto(bloque), c: bloque, ids: filas.map((f) => f.id), asignaciones: filas.length, idSugerido: aj.id || '' });
  }
  asignarIds(grupos, idsEnUso, problemas);
  revisarCruces(grupos, asignaciones, reservasVigentes, hijosExistentes, problemas);
  const salida = grupos.map(({ c: _c, idSugerido: _i, ...g }) => g);
  return { padre: padre.id, ok: !problemas.some((p) => FATALES.includes(p.tipo)), grupos: salida, problemas, avisos };
}

module.exports = { planificar, bloqueCubriente, sugerirNombre, FATALES };
