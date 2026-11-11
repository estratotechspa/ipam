// Lógica pura de la interfaz (sin DOM ni red): aritmética CIDR, umbrales de uso, resumen de pools y mapa de bloques.
// Es la contraparte en el navegador de src/cidr.js: el servidor sigue siendo quien decide; esto solo anticipa errores.

export const fmt = (n) => Number(n).toLocaleString('es-CL');

export function ipANumero(texto) {
  const partes = String(texto).split('.');
  if (partes.length !== 4) return null;
  let n = 0;
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export const numeroAIp = (n) => [Math.floor(n / 16777216), Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');

// → { ip, len, tamano, inicio, fin, alineado } o null si no es un CIDR IPv4 válido.
export function parseCidr(texto) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(texto || '').trim());
  if (!m) return null;
  const ip = ipANumero(m[1]);
  const len = Number(m[2]);
  if (ip === null || len > 32) return null;
  const tamano = 2 ** (32 - len);
  return { ip, len, tamano, inicio: ip, fin: ip + tamano - 1, alineado: ip % tamano === 0 };
}

export const tamanoCidr = (cidr) => 2 ** (32 - Number(String(cidr).split('/')[1]));

// ---------- Uso de los pools ----------
// Verde por debajo de 70 %, ámbar de 70 % a 90 % (incluido), rojo por encima de 90 %.
export function nivelUso(uso) {
  if (uso < 0.7) return 'bajo';
  if (uso <= 0.9) return 'medio';
  return 'alto';
}
// ---------- Espacio libre de un pool ----------
// A partir de «por_mascara» de GET /pools/{id}/disponibilidad: la máscara del mayor bloque libre (la más corta con algún bloque libre) o null.
export function mayorBloqueLibre(porMascara) {
  const libres = (porMascara || []).filter((x) => x.bloques_libres > 0).map((x) => x.mascara);
  return libres.length ? Math.min(...libres) : null;
}
// Cuántos bloques libres de esa máscara quedan (0 si no cabe o la máscara no está en la lista).
export const bloquesQueCaben = (porMascara, mascara) => (porMascara || []).find((x) => x.mascara === mascara)?.bloques_libres || 0;

export const porcentaje = (uso, decimales = 1) => `${(uso * 100).toFixed(decimales).replace('.', ',')} %`;

// Totales del tablero a partir de /api/v1/pools (una sola consulta en el servidor).
export function resumirPools(pools) {
  const uso = pools.length ? pools.reduce((n, p) => n + p.uso, 0) / pools.length : 0;
  return {
    pools: pools.length,
    asignaciones: pools.reduce((n, p) => n + p.asignaciones, 0),
    usoPromedio: uso,
    sobre80: pools.filter((p) => p.uso > 0.8).length,
    libres: pools.reduce((n, p) => n + p.libres, 0),
  };
}

// ---------- Validación del CIDR mientras se escribe ----------
// → { estado: 'vacio' | 'ok' | 'error', mensaje }. `poolCidr` (opcional) permite avisar si queda fuera del pool.
export function validarCidr(texto, poolCidr) {
  const t = String(texto || '').trim();
  if (!t) return { estado: 'vacio', mensaje: '' };
  const error = (mensaje) => ({ estado: 'error', mensaje });
  const m = /^(\d{1,3}(?:\.\d{1,3}){0,3})(?:\/(\d*))?$/.exec(t);
  if (!m || (m[2] === undefined && t.includes('/'))) return error('Formato inválido. Escribe la dirección y la máscara, por ejemplo 10.64.16.0/22.');
  if (m[2] === undefined || m[2] === '') return error('Falta la máscara, por ejemplo 10.64.16.0/22.');
  if (m[1].split('.').length !== 4) return error('La dirección necesita cuatro números separados por puntos, por ejemplo 10.64.16.0/22.');
  if (ipANumero(m[1]) === null) return error('Cada número de la dirección debe estar entre 0 y 255.');
  if (Number(m[2]) > 32) return error('La máscara debe estar entre /0 y /32.');
  const c = parseCidr(t);
  if (!c.alineado) {
    const red = numeroAIp(Math.floor(c.ip / c.tamano) * c.tamano);
    return error(`${t} no está alineado: la dirección de red debe ser múltiplo de su tamaño. ¿Quisiste decir ${red}/${c.len}?`);
  }
  const base = poolCidr ? parseCidr(poolCidr) : null;
  if (base && (c.inicio < base.inicio || c.fin > base.fin)) return error(`${t} queda fuera del pool ${poolCidr}.`);
  return { estado: 'ok', mensaje: `${t} · ${fmt(c.tamano)} direcciones` };
}

// ---------- Mapa de bloques de un pool ----------
// Divide el pool en hasta 256 bloques iguales (nunca más pequeños que una dirección) y marca cada uno:
//   libre (ninguna dirección asignada), parcial (algunas) u ocupado (todas).
// `asignaciones`: [{cidr, ...}] del pool. Devuelve { granularidad, bloques: [{cidr, estado, asignaciones}], resumen }.
const BITS_DE_BLOQUES = 8;
export function mapaBloques(poolCidr, asignaciones) {
  const p = parseCidr(poolCidr);
  if (!p) return { granularidad: null, bloques: [], resumen: { libre: 0, parcial: 0, ocupado: 0 } };
  const granularidad = Math.min(32, p.len + BITS_DE_BLOQUES);
  const tamano = 2 ** (32 - granularidad);
  const cuantos = 2 ** (granularidad - p.len);
  const ordenadas = asignaciones
    .map((a) => ({ a, c: parseCidr(a.cidr) }))
    .filter((x) => x.c)
    .sort((x, y) => x.c.inicio - y.c.inicio);
  const resumen = { libre: 0, parcial: 0, ocupado: 0 };
  const bloques = [];
  let desde = 0;
  for (let i = 0; i < cuantos; i++) {
    const ini = p.inicio + i * tamano;
    const fin = ini + tamano - 1;
    while (desde < ordenadas.length && ordenadas[desde].c.fin < ini) desde++;
    let ocupadas = 0;
    const tocan = [];
    for (let j = desde; j < ordenadas.length && ordenadas[j].c.inicio <= fin; j++) {
      const solape = Math.min(fin, ordenadas[j].c.fin) - Math.max(ini, ordenadas[j].c.inicio) + 1;
      if (solape > 0) {
        ocupadas += solape;
        tocan.push(ordenadas[j].a);
      }
    }
    const estado = ocupadas === 0 ? 'libre' : ocupadas >= tamano ? 'ocupado' : 'parcial';
    resumen[estado]++;
    bloques.push({ cidr: `${numeroAIp(ini)}/${granularidad}`, estado, asignaciones: tocan });
  }
  return { granularidad, bloques, resumen };
}

// ---------- Resumen de un pool para quien no es técnico ----------
export const SEMAFORO = {
  bajo: { texto: 'Hay espacio', clase: 'sem-ok' },
  medio: { texto: 'Atención: queda poco', clase: 'sem-atencion' },
  alto: { texto: 'Crítico: casi lleno', clase: 'sem-critico' },
};

/** Frase y semáforo de un pool. `uso` es la fracción ocupada (asignado + reservado, de 0 a 1). */
export function resumenDelPool({ uso, total, libres }) {
  const nivel = nivelUso(uso);
  return {
    nivel,
    semaforo: SEMAFORO[nivel],
    titulo: `Se usó el ${Math.round(uso * 100)} % de esta red`,
    detalle: `Quedan ${fmt(libres)} direcciones de ${fmt(total)}.`,
  };
}

/**
 * Qué cabe todavía: una fila por tamaño habitual. `porMascara` es la lista de /disponibilidad ({mascara, direcciones, bloques_libres}).
 * Una máscara más grande que el pool no cabe nunca; sin bloques libres, tampoco.
 */
export function capacidadRestante(porMascara, mascaraDelPool, tamanos) {
  return tamanos.map(({ etiqueta, mascara }) => {
    const m = porMascara.find((x) => x.mascara === mascara);
    const direcciones = 2 ** (32 - mascara);
    if (mascara < mascaraDelPool) return { etiqueta, mascara, direcciones, estado: 'no_cabe', texto: 'No cabe en esta red (es más chica)' };
    const n = m ? m.bloques_libres : 0;
    if (!n) return { etiqueta, mascara, direcciones, estado: 'sin_espacio', texto: 'Ya no queda espacio' };
    return { etiqueta, mascara, direcciones, estado: n === 1 ? 'poco' : 'si', texto: n === 1 ? 'Solo 1 más' : `Sí, hasta ${fmt(n)}` };
  });
}

/**
 * Reparto del espacio ocupado entre proyectos. `items`: [{cidr, proyecto?, vpc?, reserva?}]. Las reservas pendientes van juntas;
 * los proyectos que no entran en los primeros `max` se agrupan en «Otros». Devuelve [{nombre, direcciones, pct, tipo}] de mayor a menor.
 */
export function repartoPorProyecto(items, totalDirecciones, max = 5) {
  const por = new Map();
  let reservado = 0;
  for (const x of items) {
    const n = tamanoCidr(x.cidr);
    if (x.reserva) reservado += n;
    else por.set(x.proyecto || x.vpc || 'Sin proyecto', (por.get(x.proyecto || x.vpc || 'Sin proyecto') || 0) + n);
  }
  const ordenados = [...por.entries()].sort((a, b) => b[1] - a[1]);
  const principales = ordenados.slice(0, max).map(([nombre, direcciones]) => ({ nombre, direcciones, tipo: 'proyecto' }));
  const resto = ordenados.slice(max).reduce((s, [, n]) => s + n, 0);
  const salida = [...principales];
  if (resto) salida.push({ nombre: 'Otros proyectos', direcciones: resto, tipo: 'otros' });
  if (reservado) salida.push({ nombre: 'Reservado, esperando aprobación', direcciones: reservado, tipo: 'reservado' });
  return salida.map((s) => ({ ...s, pct: totalDirecciones ? (s.direcciones / totalDirecciones) * 100 : 0 }));
}

/** Agrupa las reservas y asignaciones con `grupo` (clústeres). → [{grupo, filas, estado, ...}] con el más nuevo primero. */
export function agruparPorGrupo(reservas) {
  const mapa = new Map();
  for (const r of reservas) {
    if (!r.grupo) continue;
    if (!mapa.has(r.grupo)) mapa.set(r.grupo, []);
    mapa.get(r.grupo).push(r);
  }
  return [...mapa.entries()]
    .map(([grupo, filas]) => {
      const estados = new Set(filas.map((f) => f.estado));
      const primera = filas[0];
      return {
        grupo,
        filas,
        estado: estados.size === 1 ? [...estados][0] : 'mixto',
        proyecto: primera.proyecto || '',
        solicitante: primera.solicitante,
        ticket: primera.ticket,
        creado_en: filas.map((f) => f.creado_en).sort()[0],
        segundos_restantes: Math.max(...filas.map((f) => f.segundos_restantes || 0)),
      };
    })
    .sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en));
}

export const ETIQUETA_RANGO = { principal: 'Nodos', pods: 'Pods', servicios: 'Servicios' };

// ---------- Primera y última dirección de un bloque ----------
// → { primera, ultima, direcciones } o null si no es un CIDR válido. Son la dirección de red y la última del bloque; sirve de vista previa
// antes de reservar o asignar.
export function limitesCidr(texto) {
  const c = parseCidr(texto);
  if (!c) return null;
  return { primera: numeroAIp(c.inicio), ultima: numeroAIp(c.fin), direcciones: c.tamano };
}

// ---------- Jerarquía de la red: proyecto → VPC → subred → rangos secundarios ----------
export const SIN = { proyecto: '(sin proyecto)', vpc: '(sin VPC)', subred: '(sin subred)' };
const USOS_SECUNDARIOS = new Set(['pods', 'servicios']);

/**
 * Ordena segmentos (asignaciones y reservas) en la jerarquía de GCP. Cada elemento trae `cidr` y, si se conocen, `proyecto`, `vpc`,
 * `subred`, `rango` (`principal`, `pods`, `servicios` o `vpc`) y `nombre`. Sin `rango` (inventario importado) el segmento cuenta como el
 * rango principal de su subred; un `rango: 'vpc'` es el bloque de la VPC. Lo que no trae proyecto, VPC o subred queda bajo «(sin …)»,
 * al final, para que se vea qué falta completar.
 * → [{ nombre, vpcs: [{ nombre, bloques, subredes: [{ nombre, principales, secundarios, direcciones }], direcciones }], subredes, direcciones }]
 */
export function armarJerarquia(items) {
  const proyectos = new Map();
  const clave = (valor, sin) => String(valor || '').trim() || sin;
  for (const it of items || []) {
    const c = parseCidr(it.cidr);
    if (!c) continue;
    const el = { ...it, inicio: c.inicio, tamano: c.tamano };
    const proy = clave(it.proyecto, SIN.proyecto);
    const vpc = clave(it.vpc, SIN.vpc);
    if (!proyectos.has(proy)) proyectos.set(proy, new Map());
    const vpcs = proyectos.get(proy);
    if (!vpcs.has(vpc)) vpcs.set(vpc, { bloques: [], subredes: new Map() });
    const nodoVpc = vpcs.get(vpc);
    if (it.rango === 'vpc') {
      nodoVpc.bloques.push(el);
      continue;
    }
    const sub = clave(it.subred, SIN.subred);
    if (!nodoVpc.subredes.has(sub)) nodoVpc.subredes.set(sub, { principales: [], secundarios: [] });
    nodoVpc.subredes.get(sub)[USOS_SECUNDARIOS.has(it.rango) ? 'secundarios' : 'principales'].push(el);
  }
  const porInicio = (a, b) => a.inicio - b.inicio || a.tamano - b.tamano;
  // Los «(sin …)» van al final; el resto, por nombre.
  const porNombre = (sin) => (a, b) => (a.nombre === sin) - (b.nombre === sin) || a.nombre.localeCompare(b.nombre, 'es');
  const suma = (xs) => xs.reduce((n, x) => n + x.tamano, 0);
  return [...proyectos]
    .map(([nombre, vpcs]) => {
      const lista = [...vpcs]
        .map(([nombreVpc, v]) => {
          const subredes = [...v.subredes]
            .map(([nombreSub, s]) => ({
              nombre: nombreSub,
              principales: s.principales.sort(porInicio),
              secundarios: s.secundarios.sort(porInicio),
              direcciones: suma(s.principales),
            }))
            .sort(
              (a, b) =>
                (a.nombre === SIN.subred) - (b.nombre === SIN.subred) ||
                (a.principales[0]?.inicio ?? Infinity) - (b.principales[0]?.inicio ?? Infinity) ||
                a.nombre.localeCompare(b.nombre, 'es'),
            );
          return { nombre: nombreVpc, bloques: v.bloques.sort(porInicio), subredes, direcciones: suma(subredes.map((s) => ({ tamano: s.direcciones }))) };
        })
        .sort(porNombre(SIN.vpc));
      return {
        nombre,
        vpcs: lista,
        subredes: lista.reduce((n, v) => n + v.subredes.length, 0),
        direcciones: suma(lista.map((v) => ({ tamano: v.direcciones }))),
      };
    })
    .sort(porNombre(SIN.proyecto));
}
