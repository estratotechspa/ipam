// Pestaña Tokens: crear, mostrar una sola vez y revocar.
import { $, api, errorApi, fail, fecha, fechaHora, get, h, msg } from './base.js';
import { diasPara } from './reservas.js';
import { confirmar, tabla } from './ui.js';

export async function renderTokens() {
  const raiz = $('tokens');
  try {
    const lista = await get('/api/v1/tokens');
    const estado = h('div', { id: 'tk-msg', 'aria-live': 'polite' });
    const filas = lista.map((t) =>
      h(
        'tr',
        null,
        h('td', null, t.nombre),
        h('td', null, h('code', null, t.prefijo + '…')),
        h('td', null, t.rol),
        h('td', null, fecha(t.expira_en), ' ', t.por_vencer && h('span', { class: 'tag pronto' }, 'vence en ' + diasPara(t.expira_en) + ' d')),
        h('td', null, t.ultimo_uso ? fechaHora(t.ultimo_uso) : 'nunca'),
        h('td', null, h('span', { class: 'tag ' + t.estado }, t.estado)),
        h(
          'td',
          null,
          t.estado === 'activo'
            ? h(
                'button',
                { class: 'btn peligro', type: 'button', 'aria-label': 'Revocar el token ' + t.nombre, onclick: () => revocarToken(t, estado) },
                'Revocar',
              )
            : null,
        ),
      ),
    );
    raiz.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
        h('h2', { id: 'tk-titulo', tabindex: '-1' }, 'Tokens de servicio'),
        h('button', { class: 'btn', type: 'button', id: 'tk-nuevo', onclick: () => dialogoToken(estado) }, 'Crear token'),
      ),
      h(
        'p',
        { class: 'muted' },
        'Credenciales para agentes y sistemas (no para personas). El token se muestra una sola vez al crearlo; aquí solo queda su prefijo. Rotar: crea uno nuevo, actualiza el agente y revoca el anterior.',
      ),
      estado,
      tabla('Tokens de servicio', ['Nombre', 'Prefijo', 'Rol', 'Vence', 'Último uso', 'Estado', 'Acciones'], filas, 'Todavía no hay tokens.'),
    );
  } catch (e) {
    fail('tokens', e);
  }
}

export async function revocarToken(t, zona) {
  const revocar = await confirmar({
    titulo: `¿Revocar el token «${t.nombre}»?`,
    mensaje: 'Los agentes que lo usen dejarán de funcionar de inmediato.',
    confirmar: 'Revocar token',
    peligro: true,
  });
  if (!revocar) return;
  const r = await api('/api/v1/tokens/' + t.id, { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Token «${t.nombre}» revocado.` : errorApi(r), r.ok ? 'ok' : 'error');
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
  const enviar = h('button', { class: 'btn', type: 'submit', id: 'tk-crear' }, 'Crear token');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        enviar.disabled = true;
        const body = { nombre: nombre.value.trim(), rol: rol.value, expira_dias: Number(dias.value) };
        if (cuota.value) body.cuota_reservas = Number(cuota.value);
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
