// Punto de entrada: marca, sesión, navegación por pestañas (con #hash, así funcionan «atrás» y los enlaces directos) y
// montaje de cada vista. Las vistas viven en módulos propios: pools, asignaciones, solicitar, jira, usuarios, auditoria.
import { $, esc, I } from './util.js';
import { api, cargarSesion, puede, sesion } from './api.js';
import * as pools from './pools.js';
import * as asignaciones from './asignaciones.js';
import * as solicitar from './solicitar.js';
import * as jira from './jira.js';
import * as usuarios from './usuarios.js';
import * as auditoria from './auditoria.js';

const VISTAS = { pools, asig: asignaciones, sol: solicitar, jira, usuarios, audit: auditoria };
const botones = () => [...document.querySelectorAll('#nav button[data-t]')];

async function marca() {
  try {
    const m = await (await fetch('/api/config')).json();
    document.title = `${m.nombre} · Gestión de segmentos`;
    $('nombre').textContent = `${m.nombre} · Gestión de segmentos`;
    $('subtitulo').textContent = m.subtitulo || '';
    $('pie').textContent = m.pie || '';
    if (m.logo) {
      $('logo').src = m.logo; $('logo').hidden = false;
      $('favicon').href = m.logo; $('favicon').removeAttribute('type');
    }
  } catch { /* sin marca, la interfaz usa los textos por defecto */ }
}

// «#pools», «#pools/<id>», «#sol/<id>», «#asig»…
function ruta() {
  const [t, ...resto] = location.hash.replace(/^#/, '').split('/');
  const param = resto.length ? decodeURIComponent(resto.join('/')) : null;
  const boton = botones().find((b) => b.dataset.t === t);
  return boton && !boton.hidden ? { tab: t, param } : { tab: 'pools', param: null };
}

let primera = true;
async function enrutar() {
  const { tab, param } = ruta();
  document.querySelectorAll('main .wrap').forEach((w) => w.classList.toggle('hide', w.id !== tab));
  for (const b of botones()) {
    const activo = b.dataset.t === tab;
    b.classList.toggle('on', activo);
    if (activo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const panel = $(tab);
  await VISTAS[tab].mostrar(panel, param);
  // Al cambiar de vista (no en la carga inicial) el foco pasa al título: quien navega con teclado o lector de pantalla lo anuncia.
  if (!primera) { const h = panel.querySelector('h2'); if (h) h.focus({ preventScroll: true }); }
  primera = false;
}

function irA(tab) {
  const h = `#${tab}`;
  if (location.hash === h) enrutar(); else location.hash = h;
}

async function iniciar() {
  marca();
  if (!(await cargarSesion())) return;
  const nav = $('nav');
  nav.querySelector('[data-t="sol"]').hidden = !puede('solicitante');
  nav.querySelector('[data-t="usuarios"]').hidden = !(puede('admin') && sesion.modo === 'oidc');
  nav.querySelector('[data-t="audit"]').hidden = !puede('admin');
  for (const b of botones()) b.insertAdjacentHTML('afterbegin', I(b.dataset.ic));
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (b) irA(b.dataset.t); });
  window.addEventListener('hashchange', enrutar);

  $('yo').innerHTML = sesion.modo === 'oidc'
    ? `${esc(sesion.nombre)} · <b>${esc(sesion.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`
    : sesion.modo === 'none' ? `<span class="tag qa">${I('alerta')} Sin autenticación (demo)</span>` : esc(sesion.usuario);
  const salir = $('salir');
  if (salir) salir.onclick = async () => { const x = await api('/auth/logout', { body: {} }); location.href = (x.data && x.data.redirect) || '/'; };
  await enrutar();
}
iniciar();
