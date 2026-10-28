// Pestaña Usuarios y diálogos de clave (cuentas locales).
import { abrirDialogo, confirmar } from './ui.js';
import { $, YO, api, errorApi, esc, fail, fechaHora, get, h, ico, msg } from './base.js';

/** Muestra UNA vez la clave temporal de una cuenta local (nunca se guarda ni se vuelve a mostrar). */
export function mostrarClaveTemporal(usuario, clave, titulo) {
  abrirDialogo((dlg, cerrar) => {
    const estado = h('div', { id: 'ct-copia', 'aria-live': 'polite' });
    const valor = h('input', { id: 'ct-valor', class: 'token-valor', readonly: true, 'aria-label': 'Clave temporal', onfocus: (e) => e.target.select() });
    valor.value = clave;
    const copiar = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        id: 'ct-copiar',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(valor.value);
            msg(estado, 'Copiada al portapapeles.', 'ok');
          } catch {
            valor.focus();
            valor.select();
            msg(estado, 'No se pudo copiar sola: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
          }
        },
      },
      'Copiar',
    );
    dlg.replaceChildren(
      h(
        'div',
        null,
        h('h3', null, titulo + ': ' + usuario),
        h(
          'div',
          { class: 'aviso', role: 'alert' },
          h('b', null, 'Cópiala ahora. '),
          'No se podrá ver de nuevo. La persona deberá cambiarla al entrar por primera vez.',
        ),
        h('label', { for: 'ct-valor' }, 'Clave temporal'),
        valor,
        estado,
        h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'ct-cerrar', onclick: cerrar }, 'Cerrar')),
      ),
    );
    copiar.focus();
  });
}

/** Cambio de la contraseña propia (cuentas locales). Si es obligatorio (clave temporal), el diálogo no se puede cerrar. */
export function dialogoCambioClave({ obligatorio = false } = {}) {
  abrirDialogo(
    (dlg, cerrar) => {
      const estado = h('div', { id: 'cc-msg', 'aria-live': 'polite' });
      const actual = h('input', { id: 'cc-actual', type: 'password', required: true, autocomplete: 'current-password' });
      const nueva = h('input', { id: 'cc-nueva', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const repite = h('input', { id: 'cc-repite', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const boton = h('button', { class: 'btn', type: 'submit', id: 'cc-go' }, 'Cambiar contraseña');
      const enviar = async (e) => {
        e.preventDefault();
        if (nueva.value !== repite.value) return msg(estado, 'La contraseña nueva y su repetición no coinciden.', 'error');
        boton.disabled = true;
        const r = await api('/api/v1/yo/clave', { body: { actual: actual.value, nueva: nueva.value } });
        boton.disabled = false;
        if (!r.ok) return msg(estado, errorApi(r), 'error');
        msg(estado, 'Contraseña cambiada. El navegador te pedirá entrar de nuevo con la nueva.', 'ok');
        setTimeout(() => location.reload(), 1200);
      };
      dlg.replaceChildren(
        h(
          'form',
          { onsubmit: enviar, 'aria-label': 'Cambiar contraseña' },
          h('h3', null, obligatorio ? 'Debes cambiar tu contraseña' : 'Cambiar mi contraseña'),
          obligatorio ? h('p', { class: 'muted' }, 'Entraste con una clave temporal. Elige una propia de al menos 12 caracteres para seguir.') : null,
          h('label', { for: 'cc-actual' }, 'Contraseña actual'),
          actual,
          h('label', { for: 'cc-nueva' }, 'Contraseña nueva (mínimo 12 caracteres)'),
          nueva,
          h('label', { for: 'cc-repite' }, 'Repite la contraseña nueva'),
          repite,
          estado,
          h('div', { class: 'fila-botones' }, boton, obligatorio ? null : h('button', { class: 'btn sec', type: 'button', onclick: cerrar }, 'Cancelar')),
        ),
      );
      actual.focus();
    },
    { cerrable: !obligatorio },
  );
}

// ---- Pestaña Usuarios (admin). SSO: pre-registro por correo y baja. Cuentas locales (AUTH_LOCAL): clave temporal de un solo uso. ----
/** Panel de la pestaña Usuarios cuando el modo de acceso no permite crear cuentas (Basic sin AUTH_LOCAL, o acceso abierto). */
export function usuariosSinCuentas(raiz) {
  const quien =
    YO.modo === 'none'
      ? 'El acceso está <b>abierto</b>: cualquiera que llegue al servicio entra como administrador.'
      : `Hoy se entra con el usuario y la clave únicos del administrador de emergencia (<b>${esc(YO.usuario)}</b>). Su clave no se cambia desde esta pantalla: vive en la configuración (<code>APP_PASS</code>, mejor como hash <code>scrypt$…</code>).`;
  raiz.innerHTML = `<h2>Usuarios</h2><div class="card" style="max-width:820px">
    <p><b>Las cuentas de usuario no están habilitadas en este modo de acceso.</b></p><p>${quien}</p>
    <p>Para tener varias personas con su rol (lector, solicitante o admin) hay dos caminos:</p>
    <ul>
      <li><b>Cuentas locales</b> (pruebas y POC): activa <code>AUTH_LOCAL=true</code> (Helm: <code>auth.local=true</code>) con Basic (<code>APP_USER</code> y <code>APP_PASS</code>) y reinicia.
        Aquí podrás crear cuentas con una clave temporal, desactivarlas, eliminarlas y restablecer su clave; cada persona cambia la suya al entrar y tiene su botón «Mi contraseña».</li>
      <li><b>SSO</b> (recomendado para uso real): configura OpenID Connect (Google Workspace, Entra, Okta…) y pre-registra aquí a las personas por correo.</li>
    </ul><p class="muted">Se cambia en la configuración del servicio (variables de entorno o los values de Helm), no desde la interfaz.</p></div>`;
}

export async function renderUsuarios() {
  const raiz = $('usuarios');
  if (YO.modo !== 'oidc' && !YO.cuentas_locales) return usuariosSinCuentas(raiz);
  try {
    const usuarios = await get('/api/v1/usuarios');
    const local = YO.modo !== 'oidc'; // en modo SSO se pre-registra; en modo Basic con AUTH_LOCAL se crean cuentas locales
    const estado = h('div', { id: 'us-msg', 'aria-live': 'polite' });
    const recargar = () => renderUsuarios();

    const email = h('input', {
      id: 'us-email',
      required: true,
      maxlength: 120,
      placeholder: local ? 'nombre de usuario' : 'correo@empresa.cl',
      autocomplete: 'off',
    });
    const nombre = h('input', { id: 'us-nombre', maxlength: 120, placeholder: 'opcional' });
    const rol = h(
      'select',
      { id: 'us-rol' },
      ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r }, r)),
    );
    const boton = h('button', { class: 'btn', type: 'submit', id: 'us-crear' }, local ? 'Crear cuenta local' : 'Pre-registrar');
    const crear = async (e) => {
      e.preventDefault();
      boton.disabled = true;
      const r = await api('/api/v1/usuarios', { body: { email: email.value.trim(), nombre: nombre.value.trim(), rol: rol.value, local } });
      boton.disabled = false;
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (r.data.clave_temporal) mostrarClaveTemporal(r.data.email, r.data.clave_temporal, 'Cuenta creada');
      else RES_USUARIOS.aviso = `Pre-registrado ${r.data.email} como ${r.data.rol}: entrará con su proveedor de identidad con ese rol.`;
      recargar();
    };

    const accion = async (ruta, metodo, confirmacion, alTerminar) => {
      if (confirmacion && !(await confirmar({ titulo: 'Confirma la acción', mensaje: confirmacion, peligro: true }))) return;
      const r = await api(ruta, { method: metodo, body: {} });
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (alTerminar) alTerminar(r.data);
      recargar();
    };
    const boton2 = (texto, onclick, extra = {}) => h('button', { class: 'btn sec', type: 'button', onclick, ...extra }, texto);
    const ruta = (u) => '/api/v1/usuarios/' + encodeURIComponent(u.email);
    const filas = usuarios.map((u) => {
      const yoMismo = u.email === YO.usuario;
      return h(
        'tr',
        { class: u.activo ? '' : 'inactivo' },
        h('td', null, u.email),
        h('td', null, u.nombre || '—'),
        h('td', null, u.local ? 'Local' : 'SSO'),
        h(
          'td',
          null,
          h(
            'select',
            {
              'aria-label': 'Rol de ' + u.email,
              onchange: async (e) => {
                const r = await api(ruta(u), { method: 'PUT', body: { rol: e.target.value || null } });
                if (!r.ok) msg(estado, errorApi(r), 'error');
                recargar();
              },
            },
            u.local ? null : h('option', { value: '' }, 'Heredar'),
            ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r, selected: u.rol === r }, r)),
          ),
        ),
        h('td', null, u.activo ? 'Activo' : 'Desactivado', u.debe_cambiar_clave ? ' · clave temporal' : ''),
        h('td', null, fechaHora(u.ultimo_acceso)),
        h(
          'td',
          { class: 'acciones' },
          u.activo
            ? boton2(
                'Desactivar',
                () => accion(ruta(u) + '/desactivar', 'POST', `¿Desactivar a ${u.email}? No podrá entrar hasta que lo reactives (su historial se conserva).`),
                { disabled: yoMismo },
              )
            : boton2('Activar', () => accion(ruta(u) + '/activar', 'POST')),
          u.local
            ? boton2('Restablecer clave', () =>
                accion(ruta(u) + '/restablecer-clave', 'POST', `¿Restablecer la clave de ${u.email}? Se generará una clave temporal nueva.`, (d) =>
                  mostrarClaveTemporal(d.email, d.clave_temporal, 'Clave restablecida'),
                ),
              )
            : null,
          boton2('Eliminar', () => accion(ruta(u), 'DELETE', `¿Eliminar a ${u.email}? Para conservar su historial prefiere Desactivar.`), {
            disabled: yoMismo,
            class: 'btn peligro',
          }),
        ),
      );
    });
    if (RES_USUARIOS.aviso) {
      msg(estado, RES_USUARIOS.aviso, 'ok');
      RES_USUARIOS.aviso = null;
    }
    raiz.replaceChildren(
      h('h2', null, 'Usuarios'),
      h(
        'p',
        { class: 'muted' },
        local
          ? 'Cuentas locales con contraseña (modo de pruebas). La clave temporal se muestra una sola vez y la persona debe cambiarla al entrar. El administrador de emergencia (variables APP_USER y APP_PASS) siempre puede entrar. Para uso real, configura SSO.'
          : 'Las personas entran con tu proveedor de identidad (SSO). Aquí puedes pre-registrarlas con su rol antes de que entren, cambiarlo o darlas de baja; el cambio rige desde su próximo inicio de sesión. «Heredar» usa los grupos del proveedor.',
      ),
      h(
        'details',
        { class: 'card', style: 'margin:0 0 14px' },
        h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), local ? 'Nueva cuenta local' : 'Pre-registrar a una persona'),
        h(
          'form',
          { class: 'filtros', style: 'margin-top:12px', onsubmit: crear, 'aria-label': 'Nuevo usuario' },
          h('label', null, local ? 'Usuario' : 'Correo', email),
          h('label', null, 'Nombre', nombre),
          h('label', null, 'Rol', rol),
          boton,
        ),
      ),
      estado,
      h(
        'div',
        { class: 'card tablewrap' },
        h(
          'table',
          null,
          h(
            'tr',
            null,
            ['Usuario', 'Nombre', 'Tipo', 'Rol', 'Estado', 'Último acceso', ''].map((t) => h('th', null, t)),
          ),
          filas.length ? filas : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'Todavía no hay usuarios.')),
        ),
      ),
    );
  } catch (e) {
    fail('usuarios', e);
  }
}

export const RES_USUARIOS = { aviso: null };
