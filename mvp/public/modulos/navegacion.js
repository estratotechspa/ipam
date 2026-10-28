// Navegación entre pestañas y despacho de cada vista.
import { $, ESTADO, puede } from './base.js';
import { RES } from './reservas.js';
import { renderPools } from './pools.js';
import { renderSegmentos } from './segmentos.js';
import { renderJira } from './jira.js';
import { renderTokens } from './tokens.js';
import { renderUsuarios } from './usuarios.js';
import { renderImportar } from './importar.js';
import { renderIps } from './ips.js';

// Vistas sin botón propio en la barra: se abren desde su pestaña (Importar, desde Pools) y solo las ve un admin.
export const SUBVISTAS = { importar: 'pools' };

export function show(t) {
  const boton = $('nav').querySelector('[data-t="' + t + '"]');
  if (!$(t) || (SUBVISTAS[t] ? !puede('admin') : !boton || boton.hidden)) t = 'pools';
  ESTADO.vista = t;
  const marcada = SUBVISTAS[t] || t;
  clearInterval(RES.timer);
  document.querySelectorAll('.wrap').forEach((w) => w.classList.toggle('hide', w.id !== t));
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === marcada);
    if (b.dataset.t === marcada) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  render(t);
}

export function render(t) {
  ({
    pools: renderPools,
    segmentos: renderSegmentos,
    jira: renderJira,
    tokens: renderTokens,
    usuarios: renderUsuarios,
    importar: renderImportar,
    ips: renderIps,
  })[t]();
}
