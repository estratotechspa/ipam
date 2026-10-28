// Punto de entrada: arranque de la interfaz.
import { $, CAB, I, YO, api, esc, h, ico, puede } from './modulos/base.js';
import { show } from './modulos/navegacion.js';
import { dialogoCambioClave } from './modulos/usuarios.js';

$('nav').onclick = (e) => {
  const b = e.target.closest('[data-t]');
  if (b) show(b.dataset.t);
};

document.querySelectorAll('#nav [data-ic]').forEach((b) => b.prepend(ico(b.dataset.ic)));

async function marca() {
  try {
    const m = await (await fetch('/api/config')).json();
    document.title = m.nombre + ' · Gestión de segmentos';
    $('nombre').textContent = m.nombre + ' · Gestión de segmentos';
    $('subtitulo').textContent = m.subtitulo || '';
    if (m.logo) {
      $('logo').src = m.logo;
      $('logo').hidden = false;
      $('favicon').href = m.logo; // el logo de la marca también es el icono de la pestaña
      $('favicon').removeAttribute('type');
    }
    $('pie').textContent = m.pie || '';
  } catch (e) {}
}

/** Llama a /auth/salir con credenciales falsas: el 401 hace que el navegador reemplace las que tenía guardadas. */
function olvidarCredencialesBasic() {
  return new Promise((listo) => {
    const x = new XMLHttpRequest();
    x.open('GET', '/auth/salir', true, 'salir', 'salir');
    x.onloadend = () => listo();
    x.send();
  });
}

async function iniciar() {
  marca();
  const r = await fetch('/api/me', { headers: CAB });
  if (r.status === 401) {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
    return;
  }
  Object.assign(YO, await r.json());
  const nav = $('nav');
  nav.querySelector('[data-t="tokens"]').hidden = !puede('admin');
  nav.querySelector('[data-t="usuarios"]').hidden = !puede('admin'); // sin cuentas habilitadas explica cómo habilitarlas
  $('yo').innerHTML =
    YO.modo === 'oidc'
      ? `${esc(YO.nombre)} · <b>${esc(YO.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`
      : YO.modo === 'none'
        ? `<span class="tag qa">${I('alerta')} Sin autenticación (demo)</span>`
        : `${esc(YO.usuario)} · <b>${esc(YO.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`;
  if (YO.local) {
    $('yo').append(' ', h('button', { id: 'mi-clave', type: 'button', onclick: () => dialogoCambioClave() }, ico('llave'), 'Mi contraseña'));
  }
  const salir = $('salir');
  if (salir)
    salir.onclick = async () => {
      if (YO.modo === 'basic') {
        // Basic Auth no tiene sesión: se le pide al navegador que olvide las credenciales (ver src/adaptadores/auth/basic.js).
        await olvidarCredencialesBasic();
        location.href = '/auth/sesion-cerrada';
        return;
      }
      const x = await api('/auth/logout', { body: {} });
      location.href = (x.data && x.data.redirect) || '/';
    };
  show('pools');
  if (YO.debe_cambiar_clave) dialogoCambioClave({ obligatorio: true }); // clave temporal: no se puede seguir sin cambiarla
}

iniciar();
