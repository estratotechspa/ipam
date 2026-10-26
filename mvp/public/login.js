// Pantalla de acceso: marca (nombre, logo, pie), enlace al proveedor conservando a dónde volver y aviso según ?error=.
import { icono } from '/iconos.js';

const $ = (id) => document.getElementById(id);
$('ic-entrar').innerHTML = icono('entrar', 20);

const AVISOS = {
  sesion: 'Tu sesión expiró. Entra de nuevo para continuar.',
  revocada: 'Tu acceso ya no está vigente (se cambió tu rol o se dio de baja tu cuenta). Entra de nuevo o pide acceso a un administrador.',
  denegado: 'El inicio de sesión se canceló o el proveedor lo rechazó. Puedes intentarlo de nuevo.',
  fallo: 'No pudimos completar el inicio de sesión. Inténtalo de nuevo; si se repite, avisa a un administrador.',
  dominio: 'El dominio de tu correo no tiene acceso a este IPAM.',
  sin_rol: 'Tu cuenta no tiene un rol asignado. Pide acceso a un administrador.',
};
const AVISO_GENERICO = 'No se pudo iniciar sesión. Inténtalo de nuevo.';

// Solo rutas internas: evita que un enlace manipulado mande a otro sitio.
const rutaSegura = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

const params = new URLSearchParams(location.search);
const next = rutaSegura(params.get('next'));
if (next !== '/') $('entrar').href = '/auth/login?next=' + encodeURIComponent(next);

const error = params.get('error');
if (error) {
  $('aviso').textContent = AVISOS[error] || AVISO_GENERICO;
  $('aviso').insertAdjacentHTML('afterbegin', icono('alerta') + ' ');
  $('aviso').hidden = false;
}

fetch('/api/config').then((r) => r.json()).then((m) => {
  $('nombre').textContent = m.nombre;
  document.title = `Iniciar sesión · ${m.nombre}`;
  $('subtitulo').textContent = m.subtitulo || '';
  $('pie').textContent = m.pie || '';
  if (m.logo) { $('logo').src = m.logo; $('logo').hidden = false; $('favicon').href = m.logo; $('favicon').removeAttribute('type'); }
}).catch(() => {}); // sin marca, la pantalla funciona con los textos por defecto
