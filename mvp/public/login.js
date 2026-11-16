// Pantalla de acceso: Google SSO + acceso de emergencia local y telemetría de red.
import { icono } from '/iconos.js';

const $ = (id) => document.getElementById(id);

const icEntrar = $('ic-entrar');
if (icEntrar) icEntrar.innerHTML = icono('entrar', 16);

const AVISOS = {
  sesion: 'Tu sesión expiró. Entra de nuevo para continuar.',
  revocada: 'Tu acceso ya no está vigente (se cambió tu rol o se dio de baja tu cuenta). Entra de nuevo o pide acceso a un administrador.',
  denegado: 'El inicio de sesión se canceló o el proveedor lo rechazó. Puedes intentarlo de nuevo.',
  fallo: 'No pudimos completar el inicio de sesión con Google. Inténtalo de nuevo; si persiste, usa el acceso de emergencia.',
  dominio: 'El dominio de tu correo de Google no tiene acceso autorizado a este IPAM.',
  sin_rol: 'Tu cuenta de correo no tiene un rol asignado. Pide acceso a un administrador.',
};
const AVISO_GENERICO = 'No se pudo iniciar sesión. Inténtalo de nuevo.';

// Solo rutas internas: evita que un enlace manipulado mande a otro sitio.
const rutaSegura = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

const params = new URLSearchParams(location.search);
const next = rutaSegura(params.get('next'));
if (next !== '/') {
  const btnEntrar = $('entrar');
  if (btnEntrar) btnEntrar.href = '/auth/login?next=' + encodeURIComponent(next);
}

const error = params.get('error');
if (error) {
  const aviso = $('aviso');
  if (aviso) {
    aviso.textContent = AVISOS[error] || AVISO_GENERICO;
    const ic = document.createElement('span');
    ic.innerHTML = icono('alerta');
    aviso.prepend(ic, ' ');
    aviso.hidden = false;
  }
}

// Manejo del formulario de credenciales de emergencia
const formEmergencia = $('form-emergencia');
if (formEmergencia) {
  formEmergencia.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('local-err');
    if (errBox) errBox.hidden = true;

    const btnSubmit = $('btn-local');
    if (btnSubmit) btnSubmit.disabled = true;

    const usuario = $('local-user')?.value?.trim() || '';
    const clave = $('local-pass')?.value || '';

    try {
      const resp = await fetch('/auth/local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'ipam',
        },
        body: JSON.stringify({ usuario, clave, next }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.mensaje || 'Credenciales incorrectas');
      }

      window.location.href = data.redirect || next || '/';
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Error al autenticar';
        errBox.hidden = false;
      }
    } finally {
      if (btnSubmit) btnSubmit.disabled = false;
    }
  });
}

// Cargar opciones y configuración de la marca
fetch('/api/config')
  .then((r) => r.json())
  .then((m) => {
    if (m.nombre && $('nombre')) {
      $('nombre').textContent = m.nombre;
      document.title = `Iniciar sesión · ${m.nombre}`;
    }
    if (m.subtitulo && $('subtitulo')) $('subtitulo').textContent = m.subtitulo;
    if (m.pie && $('pie')) $('pie').textContent = m.pie;
    if (m.logo && $('logo')) {
      $('logo').src = m.logo;
      $('logo').hidden = false;
      $('favicon').href = m.logo;
      $('favicon').removeAttribute('type');
    }
  })
  .catch(() => {});
