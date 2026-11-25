// Pestaña Tokens: crear, mostrar una sola vez y revocar.
import { $, api, errorApi, fail, fecha, fechaHora, get, h, msg } from './base.js';
import { diasPara } from './reservas.js';
import { confirmar, tabla } from './ui.js';

// Grupos de la API que se pueden dar a un token (los mismos de dominio/alcance.js).
const GRUPOS = [
  ['reservas', 'Reservas', 'reservar, consultar y liberar las propias (confirmar es solo de admin)', true],
  ['consulta', 'Consulta', 'ver pools, disponibilidad y asignaciones (para comprobar solapamientos)', true],
  ['direcciones', 'Direcciones IP', 'consultar y registrar IP fijas', false],
];

let FILTRO_TOKEN = '';

export async function renderTokens() {
  const raiz = $('tokens');
  try {
    const lista = await get('/api/v1/tokens');
    const estado = h('div', { id: 'tk-msg', 'aria-live': 'polite' });
    const inactivos = lista.filter((t) => t.estado !== 'activo');
    const visibles = lista.filter((t) => {
      if (FILTRO_TOKEN === 'activos') return t.estado === 'activo';
      if (FILTRO_TOKEN === 'inactivos') return t.estado !== 'activo';
      return true;
    });

    const filas = visibles.map((t) =>
      h(
        'tr',
        null,
        h('td', null, t.nombre),
        h('td', null, h('code', null, t.prefijo + '…')),
        h('td', null, t.rol),
        h('td', null, t.alcance ? t.alcance.join(', ') : 'todo lo de su rol'),
        h('td', null, fecha(t.expira_en), ' ', t.por_vencer && h('span', { class: 'tag pronto' }, 'vence en ' + diasPara(t.expira_en) + ' d')),
        h('td', null, t.ultimo_uso ? fechaHora(t.ultimo_uso) : 'nunca'),
        h('td', null, h('span', { class: 'tag ' + t.estado }, t.estado)),
        h(
          'td',
          null,
          t.estado === 'activo'
            ? h(
                'button',
                { class: 'btn peligro pequeno', type: 'button', 'aria-label': 'Revocar el token ' + t.nombre, onclick: () => revocarToken(t, estado) },
                'Revocar',
              )
            : h(
                'button',
                {
                  class: 'btn sec peligro pequeno',
                  type: 'button',
                  'aria-label': 'Eliminar definitivamente el token ' + t.nombre,
                  onclick: () => eliminarToken(t, estado),
                },
                'Eliminar',
              ),
        ),
      ),
    );

    const botonesCabecera = [
      h(
        'select',
        {
          id: 'tk-filtro',
          class: 'pequeno',
          onchange: (e) => {
            FILTRO_TOKEN = e.target.value;
            renderTokens();
          },
        },
        h('option', { value: '', selected: FILTRO_TOKEN === '' }, 'Todos los tokens (' + lista.length + ')'),
        h('option', { value: 'activos', selected: FILTRO_TOKEN === 'activos' }, 'Solo activos (' + (lista.length - inactivos.length) + ')'),
        h('option', { value: 'inactivos', selected: FILTRO_TOKEN === 'inactivos' }, 'Solo revocados/vencidos (' + inactivos.length + ')'),
      ),
    ];

    if (inactivos.length > 0) {
      botonesCabecera.push(
        h(
          'button',
          {
            class: 'btn sec peligro',
            type: 'button',
            id: 'tk-purgar',
            onclick: () => purgarTokens(estado),
          },
          'Limpiar revocados (' + inactivos.length + ')',
        ),
      );
    }

    botonesCabecera.push(h('button', { class: 'btn', type: 'button', id: 'tk-nuevo', onclick: () => dialogoToken(estado) }, '+ Crear token'));

    raiz.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
        h('h2', { id: 'tk-titulo', tabindex: '-1' }, 'Tokens de servicio'),
        h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, ...botonesCabecera),
      ),
      h(
        'p',
        { class: 'muted' },
        'Credenciales para agentes y sistemas (no para personas). El token se muestra una sola vez al crearlo; aquí solo queda su prefijo. Los tokens revocados o vencidos se pueden eliminar definitivamente.',
      ),
      estado,
      tabla('Tokens de servicio', ['Nombre', 'Prefijo', 'Rol', 'Alcance', 'Vence', 'Último uso', 'Estado', 'Acciones'], filas, 'Todavía no hay tokens.'),
    );
  } catch (e) {
    fail('tokens', e);
  }
}

export async function revocarToken(t, zona) {
  const revocar = await confirmar({
    titulo: `¿Revocar el token «${t.nombre}»?`,
    mensaje: 'Los agentes que lo usen dejarán de funcionar de inmediato. Luego podrás eliminarlo definitivamente.',
    confirmar: 'Revocar token',
    peligro: true,
  });
  if (!revocar) return;
  const r = await api('/api/v1/tokens/' + t.id, { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Token «${t.nombre}» revocado.` : errorApi(r), r.ok ? 'ok' : 'error');
}

export async function eliminarToken(t, zona) {
  const eliminar = await confirmar({
    titulo: `¿Eliminar definitivamente «${t.nombre}»?`,
    mensaje: 'El token se borrará de forma permanente de la base de datos.',
    confirmar: 'Eliminar permanentemente',
    peligro: true,
  });
  if (!eliminar) return;
  const r = await api('/api/v1/tokens/' + t.id + '?purgar=true', { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Token «${t.nombre}» eliminado del sistema.` : errorApi(r), r.ok ? 'ok' : 'error');
}

export async function purgarTokens(zona) {
  const limpiar = await confirmar({
    titulo: '¿Eliminar todos los tokens inactivos?',
    mensaje: 'Se borrarán de forma definitiva todos los tokens revocados y vencidos.',
    confirmar: 'Limpiar todos',
    peligro: true,
  });
  if (!limpiar) return;
  const r = await api('/api/v1/tokens?purgar=revocados', { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Se eliminaron ${r.data.eliminados} tokens revocados/vencidos.` : errorApi(r), r.ok ? 'ok' : 'error');
}

export function dialogoToken(zona) {
  const dlg = h('dialog', { id: 'tk-dlg', 'aria-labelledby': 'tk-dlg-t' });
  const cierre = () => {
    const v = dlg.querySelector('#tk-valor');
    if (v) v.value = '';
    dlg.close();
  };
  dlg.addEventListener('close', async () => {
    dlg.remove();
    await renderTokens();
    const b = $('tk-nuevo');
    if (b) b.focus();
  });
  const error = h('div', { id: 'tk-err', 'aria-live': 'assertive' });
  const nombre = h('input', {
    id: 'tk-nombre',
    name: 'nombre',
    required: true,
    pattern: '[a-z0-9][a-z0-9\\-]{1,40}',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'tk-nombre-ayuda',
  });
  const rol = h(
    'select',
    { id: 'tk-rol', name: 'rol' },
    h('option', { value: 'agente', selected: true }, 'agente (reserva, confirma y libera las suyas)'),
    h('option', { value: 'lector' }, 'lector (solo consulta)'),
  );
  const dias = h('input', { id: 'tk-dias', name: 'expira_dias', type: 'number', min: '1', max: '365', value: '90', required: true });
  const cuota = h('input', { id: 'tk-cuota', name: 'cuota_reservas', type: 'number', min: '1', placeholder: '(la general)' });
  const alcance = GRUPOS.map(([clave, titulo, ayuda, marcado]) =>
    h(
      'label',
      { class: 'casilla', style: 'display:flex;gap:8px;align-items:baseline' },
      h('input', { type: 'checkbox', name: 'alcance', value: clave, checked: marcado, style: 'width:auto' }),
      h('span', null, h('b', null, titulo), ' · ', ayuda),
    ),
  );
  const enviar = h('button', { class: 'btn', type: 'submit', id: 'tk-crear' }, 'Crear token');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        enviar.disabled = true;
        const body = { nombre: nombre.value.trim(), rol: rol.value, expira_dias: Number(dias.value) };
        if (cuota.value) body.cuota_reservas = Number(cuota.value);
        body.alcance = alcance
          .map((l) => l.querySelector('input'))
          .filter((c) => c.checked)
          .map((c) => c.value);
        if (!body.alcance.length) {
          enviar.disabled = false;
          msg(error, 'Elige al menos un grupo de la API para el token.', 'error');
          return;
        }
        const r = await api('/api/v1/tokens', { body });
        enviar.disabled = false;
        if (!r.ok) {
          msg(error, errorApi(r), 'error');
          return;
        }
        mostrarToken(dlg, r.data, cierre);
      },
    },
    h('h3', { id: 'tk-dlg-t' }, 'Crear token de servicio'),
    h('label', { for: 'tk-nombre' }, 'Nombre'),
    nombre,
    h('p', { class: 'ayuda', id: 'tk-nombre-ayuda' }, 'Minúsculas, números y guiones (p. ej. agente-redes). Debe ser único.'),
    h('label', { for: 'tk-rol' }, 'Rol'),
    rol,
    h('label', { for: 'tk-dias' }, 'Vigencia (días, 1 a 365)'),
    dias,
    h('label', { for: 'tk-cuota' }, 'Cuota de reservas vigentes (opcional)'),
    cuota,
    h('fieldset', null, h('legend', null, 'Qué puede usar este token'), ...alcance),
    error,
    h('div', { class: 'fila-botones' }, h('button', { class: 'btn sec', type: 'button', onclick: cierre }, 'Cancelar'), enviar),
  );
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  nombre.focus();
}

export function mostrarToken(dlg, t, cierre) {
  const estado = h('div', { id: 'tk-copia', 'aria-live': 'polite' });
  const valor = h('input', { id: 'tk-valor', class: 'token-valor', readonly: true, 'aria-label': 'Token de servicio', onfocus: (e) => e.target.select() });
  valor.value = t.token;
  const copiar = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      id: 'tk-copiar',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(valor.value);
          msg(estado, 'Copiado al portapapeles.', 'ok');
        } catch {
          valor.focus();
          valor.select();
          msg(estado, 'No se pudo copiar solo: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
        }
      },
    },
    'Copiar',
  );
  dlg.replaceChildren(
    h(
      'div',
      null,
      h('h3', { id: 'tk-dlg-t' }, 'Token creado: ' + t.nombre),
      h(
        'div',
        { class: 'aviso', role: 'alert' },
        h('b', null, 'Cópialo ahora. '),
        'No se podrá ver de nuevo: si lo pierdes, tendrás que crear otro y revocar este.',
      ),
      h('label', { for: 'tk-valor' }, 'Token'),
      valor,
      estado,
      h('p', { class: 'ayuda' }, `Rol ${t.rol} · vence ${fecha(t.expira_en)}. Úsalo así:  Authorization: Bearer <token>`),
      h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'tk-cerrar', onclick: cierre }, 'Cerrar')),
    ),
  );
  copiar.focus();
}
