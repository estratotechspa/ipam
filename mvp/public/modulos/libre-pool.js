// Columna «Mayor libre» de Pools y la pregunta «¿dónde cabe una subred de este tamaño?».
// Cada pool pide su disponibilidad (GET /pools/{id}/disponibilidad); se recuerda 60 s para no gastar el límite de lecturas al buscar o filtrar.
import { bloquesQueCaben, fmt, mayorBloqueLibre } from '../calculos.js';
import { ESTADO, api, h } from './base.js';

const MASCARAS = [16, 18, 20, 21, 22, 23, 24, 26, 28];
const VIGENCIA_MS = 60000;
const CACHE = new Map(); // id de pool → { t, promesa }

function porMascaraDe(id) {
  const hit = CACHE.get(id);
  if (hit && Date.now() - hit.t < VIGENCIA_MS) return hit.promesa;
  const promesa = api('/api/v1/pools/' + encodeURIComponent(id) + '/disponibilidad').then((r) => (r.ok ? r.data.por_mascara : null));
  CACHE.set(id, { t: Date.now(), promesa });
  promesa.then((x) => x || CACHE.delete(id));
  return promesa;
}

/** Texto de la celda: sin máscara elegida, el mayor bloque libre; con una elegida, cuántos bloques de ese tamaño caben. */
export function textoLibre(porMascara, mascara) {
  if (!porMascara) return { texto: '—', clase: 'muted', detalle: 'No se pudo calcular la disponibilidad' };
  if (mascara) {
    const n = bloquesQueCaben(porMascara, mascara);
    return n
      ? { texto: `Cabe · ${fmt(n)}`, clase: 'libre-si', detalle: `Caben ${fmt(n)} bloques /${mascara}` }
      : { texto: 'No cabe', clase: 'libre-no', detalle: `No queda un bloque libre /${mascara}` };
  }
  const m = mayorBloqueLibre(porMascara);
  return m === null
    ? { texto: 'Sin espacio', clase: 'libre-no', detalle: 'No queda ningún bloque libre' }
    : { texto: `/${m}`, clase: 'libre-mayor', detalle: `Mayor bloque libre: /${m} (${fmt(2 ** (32 - m))} direcciones)` };
}

/** Rellena la columna de todas las filas de la tabla. Cada celda se completa cuando llega su respuesta. */
export function llenarLibres(raiz, pools) {
  for (const p of pools) {
    const celda = [...raiz.querySelectorAll('[data-libre-pool]')].find((c) => c.dataset.librePool === p.id);
    if (!celda) continue;
    porMascaraDe(p.id).then((por) => {
      if (!celda.isConnected) return;
      const t = textoLibre(por, ESTADO.cabeMascara);
      celda.replaceChildren(h('span', { class: t.clase, title: t.detalle }, t.texto));
    });
  }
}

/** Selector «¿Dónde cabe una subred de tamaño?»; al cambiar, vuelve a rotular la columna sin recargar la tabla. */
export function selectorCabe(alCambiar) {
  const sel = h(
    'select',
    {
      id: 'p-cabe',
      onchange: (e) => {
        ESTADO.cabeMascara = Number(e.target.value) || 0;
        alCambiar();
      },
    },
    h('option', { value: '' }, 'Mostrar el mayor bloque libre'),
    ...MASCARAS.map((m) => h('option', { value: m, selected: ESTADO.cabeMascara === m }, `/${m} (${fmt(2 ** (32 - m))} direcciones)`)),
  );
  return h('div', { class: 'cabe-pools' }, h('label', { for: 'p-cabe' }, '¿Dónde cabe una subred de tamaño?'), sel);
}
