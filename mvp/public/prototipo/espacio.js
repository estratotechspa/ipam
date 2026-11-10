// Prototipo: mapa del espacio de direcciones de cada VPC y la pregunta «¿cabe una subred de este tamaño?».
// Datos de ejemplo: no llama a la API. La unidad del mapa es un /24 (256 direcciones).
import { fmt, numeroAIp, parseCidr } from '../calculos.js';

const UNIDAD = 256;
const COLUMNAS = 32;

const VPCS = [
  {
    hub: 'hub-project-dev',
    nombre: 'shared-vpc-dev',
    ambiente: 'dev',
    cidr: '172.31.128.0/18',
    segmentos: [
      { cidr: '172.31.128.0/20', estado: 'asignado', nombre: 'subred-nodos-a' },
      { cidr: '172.31.144.0/21', estado: 'asignado', nombre: 'subred-nodos-b' },
      { cidr: '172.31.152.0/22', estado: 'asignado', nombre: 'subred-apps' },
      { cidr: '172.31.160.0/21', estado: 'reservado', nombre: 'cluster-ia (reserva)', ticket: 'TKT-1042', vence_min: 300 },
      { cidr: '172.31.168.0/22', estado: 'asignado', nombre: 'subred-datos' },
      { cidr: '172.31.172.0/23', estado: 'asignado', nombre: 'subred-proxy' },
      { cidr: '172.31.174.0/24', estado: 'asignado', nombre: 'subred-psc' },
      { cidr: '172.31.184.0/22', estado: 'asignado', nombre: 'subred-lab' },
      { cidr: '172.31.188.0/24', estado: 'asignado', nombre: 'conector' },
    ],
  },
  {
    hub: 'hub-project-dev',
    nombre: 'shared-vpc-ia-dev',
    ambiente: 'dev',
    cidr: '172.31.192.0/20',
    segmentos: [
      { cidr: '172.31.192.0/22', estado: 'asignado', nombre: 'subred-nodos-ia' },
      { cidr: '172.31.196.0/23', estado: 'reservado', nombre: 'pods-ia (reserva)', ticket: 'TKT-1057', vence_min: 52 },
    ],
  },
];

const TAMANOS = [20, 21, 22, 23, 24];

/** Elemento DOM con atributos y texto. Todo el contenido entra como texto, nunca como HTML. */
function el(tag, attrs = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  e.append(...hijos.filter((x) => x !== null && x !== undefined && x !== false));
  return e;
}

const pct = (x) => (x * 100).toFixed(0) + ' %';
const mascara = (celdas) => 24 - Math.log2(celdas);
const direcciones = (celdas) => celdas * UNIDAD;

/** Estado de cada /24 de la VPC: libre o el segmento que lo ocupa. */
function celdasDe(vpc) {
  const base = parseCidr(vpc.cidr);
  const celdas = Array.from({ length: base.tamano / UNIDAD }, () => ({ segmento: null }));
  for (const s of vpc.segmentos) {
    const p = parseCidr(s.cidr);
    const ini = (p.inicio - base.inicio) / UNIDAD;
    for (let i = 0; i < p.tamano / UNIDAD; i++) celdas[ini + i].segmento = s;
  }
  return { base, celdas };
}

/** Posiciones de inicio de los bloques alineados y libres de `tam` celdas. */
function huecos(celdas, tam) {
  const r = [];
  for (let i = 0; i + tam <= celdas.length; i += tam) {
    if (celdas.slice(i, i + tam).every((c) => !c.segmento)) r.push(i);
  }
  return r;
}

/** Mayor bloque libre alineado (la potencia de 2 más grande que entra), o null si no queda espacio. */
function mayorLibre(celdas) {
  for (let tam = 2 ** Math.floor(Math.log2(celdas.length)); tam >= 1; tam /= 2) {
    const h = huecos(celdas, tam);
    if (h.length) return { ini: h[0], tam };
  }
  return null;
}

const cidrDeBloque = (base, ini, tam) => `${numeroAIp(base.inicio + ini * UNIDAD)}/${mascara(tam)}`;

const textoSegmento = (s) => {
  const p = parseCidr(s.cidr);
  return `${s.nombre}: ${s.cidr}, ${s.estado}${s.estado === 'reservado' ? ' sin confirmar' : ''}, ${fmt(p.tamano)} direcciones`;
};

/** Piezas de una fila: segmentos (botones que ocupan varias columnas) y celdas libres sueltas. */
function filaDeFranja(celdas, desde, hasta, ctx) {
  const fila = el('div', { class: 'franja-fila' });
  let i = desde;
  while (i < hasta) {
    const s = celdas[i].segmento;
    if (!s) {
      const libre = el('span', { class: 'celda-libre', 'data-i': i });
      if (ctx.mayor && i >= ctx.mayor.ini && i < ctx.mayor.ini + ctx.mayor.tam) libre.classList.add('mayor');
      if (ctx.cabe.has(i)) libre.classList.add('cabe');
      fila.append(libre);
      i++;
      continue;
    }
    let fin = i;
    while (fin + 1 < hasta && celdas[fin + 1].segmento === s) fin++;
    const n = fin - i + 1;
    const pieza = el(
      'button',
      { type: 'button', class: `pieza ${s.estado}`, style: `grid-column:span ${n}`, 'aria-label': textoSegmento(s) },
      n >= 4 ? s.nombre : '',
    );
    pieza.addEventListener('mouseenter', () => (ctx.detalle.textContent = textoSegmento(s)));
    pieza.addEventListener('focus', () => (ctx.detalle.textContent = textoSegmento(s)));
    fila.append(pieza);
    i = fin + 1;
  }
  return fila;
}

/** Marca los bloques donde cabría una subred /N y escribe la respuesta en palabras. */
function marcarCabe(vpc, datos, tamMascara) {
  const { celdas } = datos;
  const cabe = new Set();
  let texto = '';
  let no = false;
  if (tamMascara) {
    const tam = 2 ** (24 - tamMascara);
    const lugares = tam <= celdas.length ? huecos(celdas, tam) : [];
    for (const ini of lugares) for (let k = 0; k < tam; k++) cabe.add(ini + k);
    const mayor = mayorLibre(celdas);
    if (lugares.length) texto = `Un /${tamMascara} cabe en ${lugares.length === 1 ? '1 lugar' : `${lugares.length} lugares`}.`;
    else {
      no = true;
      texto = `Un /${tamMascara} no cabe.${mayor ? ` El mayor bloque libre es un /${mascara(mayor.tam)}.` : ' No queda espacio libre.'}`;
    }
  }
  return { cabe, texto, no };
}

function dibujarVpc(vpc, tamMascara) {
  const datos = celdasDe(vpc);
  const { base, celdas } = datos;
  const total = celdas.length;
  const asignadas = celdas.filter((c) => c.segmento?.estado === 'asignado').length;
  const reservadas = celdas.filter((c) => c.segmento?.estado === 'reservado').length;
  const mayor = mayorLibre(celdas);
  const { cabe, texto, no } = marcarCabe(vpc, datos, tamMascara);
  const detalle = el('p', { class: 'franja-detalle', 'aria-live': 'polite' });
  const ctx = { mayor, cabe, detalle };

  const franja = el('div', { class: 'franja', role: 'group', 'aria-label': `Mapa de ${vpc.nombre}` });
  for (let d = 0; d < total; d += COLUMNAS) franja.append(filaDeFranja(celdas, d, Math.min(d + COLUMNAS, total), ctx));

  const dato = mayor
    ? el(
        'p',
        { class: 'vpc-dato' },
        `${pct(asignadas / total)} asignado y ${pct(reservadas / total)} reservado. Mayor bloque libre: un /${mascara(mayor.tam)} (${fmt(direcciones(mayor.tam))} direcciones), `,
        el('span', { class: 'cidr' }, cidrDeBloque(base, mayor.ini, mayor.tam)),
        '.',
      )
    : el('p', { class: 'vpc-dato' }, `${pct(asignadas / total)} asignado y ${pct(reservadas / total)} reservado. No queda espacio libre.`);

  const lista = el('details', {}, el('summary', {}, 'Ver los segmentos como lista'), tablaSegmentos(vpc));
  return el(
    'article',
    { class: 'vpc' },
    el(
      'div',
      { class: 'vpc-cab' },
      el('h3', {}, vpc.nombre),
      el('span', { class: 'amb' }, vpc.ambiente),
      el('p', { class: 'muted' }, `${vpc.hub} · `, el('span', { class: 'cidr' }, vpc.cidr)),
    ),
    dato,
    franja,
    detalle,
    el('p', { class: `vpc-cabe${no ? ' no' : ''}`, 'aria-live': 'polite' }, texto),
    lista,
  );
}

function tablaSegmentos(vpc) {
  const filas = vpc.segmentos.map((s) => el('tr', {}, el('td', {}, s.nombre), el('td', {}, el('span', { class: 'cidr' }, s.cidr)), el('td', {}, s.estado)));
  return el(
    'div',
    { class: 'tablewrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Segmento'), el('th', { scope: 'col' }, 'Rango'), el('th', { scope: 'col' }, 'Estado'))),
      el('tbody', {}, ...filas),
    ),
  );
}

const duracion = (min) => (min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`);

function dibujarReservas() {
  const todas = VPCS.flatMap((v) => v.segmentos.filter((s) => s.estado === 'reservado').map((s) => ({ ...s, vpc: v.nombre }))).sort(
    (a, b) => a.vence_min - b.vence_min,
  );
  const cuerpo = document.querySelector('#reservas tbody');
  cuerpo.replaceChildren(
    ...todas.map((r) =>
      el(
        'tr',
        { class: r.vence_min < 120 ? 'ya' : r.vence_min < 720 ? 'pronto' : '' },
        el('td', { class: 'num' }, duracion(r.vence_min)),
        el('td', {}, el('span', { class: 'cidr' }, r.cidr)),
        el('td', {}, r.vpc),
        el('td', {}, r.ticket),
      ),
    ),
  );
}

function resumenGeneral() {
  const mayores = VPCS.map((v) => ({ nombre: v.nombre, tam: mayorLibre(celdasDe(v).celdas)?.tam ?? 0 }));
  const max = Math.max(...mayores.map((m) => m.tam));
  if (!max) return 'No queda espacio libre en ninguna VPC.';
  const con = mayores.filter((m) => m.tam === max).map((m) => m.nombre);
  const menos = mayores.length - con.length;
  return `El mayor bloque libre en dev es un /${mascara(max)}, en ${con.join(' y ')}.${menos ? ` ${menos === 1 ? 'La otra VPC tiene' : 'Las otras VPC tienen'} menos.` : ''}`;
}

function dibujar() {
  const sel = document.getElementById('tam');
  const m = Number(sel.value) || 0;
  document.getElementById('vpcs').replaceChildren(...VPCS.map((v) => dibujarVpc(v, m)));
}

function iniciar() {
  const sel = document.getElementById('tam');
  for (const m of TAMANOS) sel.append(el('option', { value: m }, `/${m} (${fmt(2 ** (32 - m))} direcciones)`));
  sel.addEventListener('change', dibujar);
  document.getElementById('resumen').textContent = resumenGeneral();
  dibujar();
  dibujarReservas();
}

iniciar();
