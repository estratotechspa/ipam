// Barras de uso de un pool (umbrales verde/ámbar/rojo).
import { nivelUso } from '../calculos.js';
import { I, h, ico } from './base.js';

// Uso de un pool: lo asignado (definitivo) más lo reservado (apartado). Es la misma cuenta en la tabla, la ficha y la disponibilidad.
export const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + ' %';

export const anchoUso = (x) => (x > 0 ? Math.max(x * 100, 1) : 0);

export const textoUso = (asig, res) => `Asignado ${pct(asig)} · reservado ${pct(res)}`;

/** Barra de uso: verde < 70 %, ámbar 70–90 %, rojo > 90 % (sobre lo asignado + lo reservado), con el porcentaje en número. En uso alto
 *  lleva además un icono: el color no es lo único que informa. */
export const textoNivel = { bajo: 'uso bajo', medio: 'uso medio', alto: 'uso alto' };

export const barraUsoHtml = (asig, res) => {
  const nivel = nivelUso(asig + res);
  const detalle = `${textoUso(asig, res)}, ${textoNivel[nivel]}`;
  return `<span class="uso"><span class="bar" role="img" aria-label="${detalle}" title="${detalle}"><i class="uso-${nivel}" style="width:${anchoUso(asig)}%"></i><i class="res" style="width:${anchoUso(res)}%"></i></span><span class="uso-pct uso-txt-${nivel} num">${nivel === 'alto' ? I('alerta') : ''}${pct(asig + res)}</span></span>`;
};

export const barraUso = (asig, res) => {
  const nivel = nivelUso(asig + res);
  const detalle = `${textoUso(asig, res)}, ${textoNivel[nivel]}`;
  return h(
    'span',
    { class: 'uso' },
    h(
      'span',
      { class: 'bar', role: 'img', 'aria-label': detalle, title: detalle },
      h('i', { class: `uso-${nivel}`, style: `width:${anchoUso(asig)}%` }),
      h('i', { class: 'res', style: `width:${anchoUso(res)}%` }),
    ),
    h('span', { class: `uso-pct uso-txt-${nivel} num` }, nivel === 'alto' ? ico('alerta') : null, pct(asig + res)),
  );
};
