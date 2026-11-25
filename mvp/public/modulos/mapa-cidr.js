// @ts-check
// Matriz interactiva de fragmentación CIDR (Heatmap / TreeMap) para pools IPv4.
import { h, ico, size } from './base.js';
import { parseCidr } from '../calculos.js';
import { show } from './navegacion.js';

/**
 * Genera la matriz visual de 256 bloques /24 de un pool /16 (o partición proporcional).
 * @param {{id: string, cidr: string, tipo: string, ambiente: string, proveedor: string}} pool
 * @param {Array<{cidr: string, proyecto?: string, vpc?: string, subred?: string, tipo?: string}>} asignaciones
 * @param {Array<{cidr: string, solicitante?: string, ticket?: string}>} reservas
 */
export function componenteMapaCidr(pool, asignaciones = [], reservas = []) {
  const panel = h('details', { class: 'cidr-panel', open: true });
  const sum = h(
    'summary',
    { style: 'cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:space-between;list-style:none' },
    h(
      'span',
      { style: 'display:flex;align-items:center;gap:8px' },
      ico('flujo', 16),
      `Mapa Visual de Fragmentación CIDR · Pool ${pool.id} (`,
      h('code', null, pool.cidr),
      ')',
    ),
    h('span', { class: 'muted', style: 'font-size:11px' }, '256 particiones /24 interactivas'),
  );

  const cabecera = h(
    'div',
    { class: 'cidr-cabecera', style: 'margin-top:12px' },
    h(
      'div',
      { class: 'cidr-leyenda' },
      h('span', { class: 'cidr-ley-item' }, h('span', { class: 'cidr-dot libre' }), 'Libre'),
      h('span', { class: 'cidr-ley-item' }, h('span', { class: 'cidr-dot asignado' }), 'Asignado'),
      h('span', { class: 'cidr-ley-item' }, h('span', { class: 'cidr-dot reservado' }), 'Reservado'),
    ),
  );

  const basePartes = pool.cidr.split('/')[0].split('.');
  const prefijoBase = `${basePartes[0]}.${basePartes[1]}.`;

  // Mapear bloques ocupados
  const mapaEstado = new Map();
  for (const a of asignaciones) {
    const parsed = parseCidr(a.cidr);
    if (!parsed) continue;
    const ipPartes = a.cidr.split('/')[0].split('.');
    const tercerOctetoInicio = Number(ipPartes[2]);
    const cant24 = Math.max(1, Math.floor(size(a.cidr) / 256));
    for (let k = 0; k < cant24; k++) {
      const idx = tercerOctetoInicio + k;
      if (idx < 256) {
        mapaEstado.set(idx, {
          estado: 'asignado',
          titulo: `Asignado: ${a.cidr}`,
          sub: `Proyecto: ${a.proyecto || '—'} · VPC: ${a.vpc || '—'} · Subred: ${a.subred || '—'}`,
        });
      }
    }
  }

  for (const r of reservas) {
    const ipPartes = r.cidr.split('/')[0].split('.');
    const tercerOctetoInicio = Number(ipPartes[2]);
    const cant24 = Math.max(1, Math.floor(size(r.cidr) / 256));
    for (let k = 0; k < cant24; k++) {
      const idx = tercerOctetoInicio + k;
      if (idx < 256 && !mapaEstado.has(idx)) {
        mapaEstado.set(idx, {
          estado: 'reservado',
          titulo: `Reservado: ${r.cidr}`,
          sub: `Solicitó: ${r.solicitante || '—'} · Ticket: ${r.ticket || '—'}`,
        });
      }
    }
  }

  const matrizCaja = h('div', { class: 'cidr-matriz-caja' });
  const matriz = h('div', { class: 'cidr-matriz', role: 'grid', 'aria-label': 'Matriz de bloques /24' });

  const infoTexto = h('span', null, 'Pasa el cursor sobre cualquier bloque /24 para inspeccionar su disponibilidad.');
  const btnReservar = h(
    'button',
    {
      class: 'btn pequeno',
      type: 'button',
      style: 'display:none',
      onclick: () => {
        show('segmentos');
      },
    },
    '+ Reservar en Segmentos',
  );

  const detalleBloque = h(
    'div',
    { class: 'cidr-detalle-bloque' },
    h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('code', { id: 'mc-cidr-sel', style: 'display:none' }), infoTexto),
    btnReservar,
  );

  for (let i = 0; i < 256; i++) {
    const info = mapaEstado.get(i) || {
      estado: 'libre',
      titulo: 'Libre para asignar',
      sub: 'Capacidad disponible: 256 direcciones IP (/24)',
    };

    const cidrBloque = `${prefijoBase}${i}.0/24`;
    const celda = h('div', {
      class: `cidr-celda ${info.estado}`,
      role: 'gridcell',
      'aria-label': `${cidrBloque}: ${info.titulo}`,
      title: `${cidrBloque} - ${info.titulo}`,
    });

    celda.onmouseenter = () => {
      const elCidr = detalleBloque.querySelector('#mc-cidr-sel');
      if (elCidr) {
        elCidr.textContent = cidrBloque;
        elCidr.style.display = 'inline-block';
      }
      infoTexto.textContent = `${info.titulo} · ${info.sub}`;
      if (info.estado === 'libre') {
        btnReservar.style.display = 'inline-block';
      } else {
        btnReservar.style.display = 'none';
      }
    };

    matriz.appendChild(celda);
  }

  matrizCaja.appendChild(matriz);
  panel.append(sum, cabecera, matrizCaja, detalleBloque);
  return panel;
}
