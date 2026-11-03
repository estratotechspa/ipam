// Resumen de un pool para quien no es técnico: una frase con semáforo, una barra por proyecto y «qué cabe todavía».
import { capacidadRestante, repartoPorProyecto, resumenDelPool } from '../calculos.js';
import { fmt, h, ico, size } from './base.js';

// Tamaños habituales: lo que alguien quiere saber es «¿cabe una subred normal?», no qué es un /24.
const TAMANOS = [
  { etiqueta: 'Una subred pequeña', mascara: 26 },
  { etiqueta: 'Una subred normal para servidores', mascara: 24 },
  { etiqueta: 'Una subred grande', mascara: 21 },
  { etiqueta: 'Los Pods de un clúster GKE (tamaño de GKE)', mascara: 14 },
  { etiqueta: 'Los Servicios de un clúster GKE (tamaño de GKE)', mascara: 20 },
];
const ICONO = { si: 'ok', poco: 'alerta', sin_espacio: 'error', no_cabe: 'error' };

/** @param {{cidr: string}} p  @param {{total: number, libres: number, por_mascara: any[]}} d  @param {Array} items asignaciones y reservas del pool */
export function resumenPool(p, d, uso, items) {
  const r = resumenDelPool({ uso, total: d.total, libres: d.libres });
  const reparto = repartoPorProyecto(items, d.total);
  const libre = Math.max(0, 100 - reparto.reduce((s, x) => s + x.pct, 0));
  const mascaraPool = Number(p.cidr.split('/')[1]);
  const filas = capacidadRestante(d.por_mascara, mascaraPool, TAMANOS);
  const color = (x, i) => (x.tipo === 'reservado' ? 'seg-res' : x.tipo === 'otros' ? 'seg-otros' : `seg-${i % 5}`);
  return h(
    'div',
    { class: 'resumen-pool' },
    h('p', null, h('span', { class: `semaforo ${r.semaforo.clase}` }, r.semaforo.texto)),
    h('p', { class: 'resumen-titulo' }, r.titulo),
    h('p', { class: 'muted' }, r.detalle),
    h(
      'div',
      {
        class: 'reparto',
        role: 'img',
        'aria-label': 'Reparto del espacio: ' + reparto.map((x) => `${x.nombre} ${Math.round(x.pct)} %`).join(', ') + `, libre ${Math.round(libre)} %`,
      },
      reparto.map((x, i) => h('span', { class: color(x, i), style: `width:${x.pct}%`, title: `${x.nombre}: ${fmt(x.direcciones)} direcciones` })),
    ),
    h(
      'ul',
      { class: 'leyenda-reparto' },
      reparto.map((x, i) => h('li', null, h('i', { class: `muestra-reparto ${color(x, i)}` }), `${x.nombre} · ${Math.round(x.pct)} %`)),
      h('li', null, h('i', { class: 'muestra-reparto seg-libre' }), `Libre · ${Math.round(libre)} %`),
    ),
    h('h3', null, '¿Qué cabe todavía en esta red?'),
    h(
      'table',
      { class: 'cabe' },
      h(
        'thead',
        null,
        h('tr', null, h('th', { scope: 'col' }, 'Lo que quieres crear'), h('th', { scope: 'col' }, 'Tamaño'), h('th', { scope: 'col' }, '¿Cabe?')),
      ),
      h(
        'tbody',
        null,
        filas.map((f) =>
          h(
            'tr',
            null,
            h('td', null, f.etiqueta),
            h('td', null, `${fmt(size('0.0.0.0/' + f.mascara))} direcciones`),
            h('td', { class: `cabe-${f.estado}` }, ico(ICONO[f.estado]), ' ', f.texto),
          ),
        ),
      ),
    ),
  );
}
