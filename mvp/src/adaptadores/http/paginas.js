// Páginas de aviso del servidor (acceso denegado, solicitud expirada, sesión cerrada…) con el estilo de la aplicación.
// Sin scripts: solo HTML y /app.css, que caben en la CSP (script-src 'self'). Todo el texto dinámico se escapa.
const marca = require('./marca');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Iconos (Lucide, licencia ISC) incrustados: la plantilla no depende de ningún script del navegador.
const ICONOS = {
  alerta: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};
const svg = (n) =>
  `<svg class="ic ic-grande" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONOS[n]}</svg>`;

// opciones: titulo, que (qué pasó), hacer (lista de qué hacer), boton {texto, href}, enlace {texto, href}?, icono, tono
function pagina({ titulo, que, hacer = [], boton, enlace, icono = 'alerta', tono = 'aviso' }) {
  const m = marca.config();
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · ${esc(m.nombre)}</title>
<link rel="icon" href="${esc(m.logo || '/favicon.svg')}">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/brand.css">
</head>
<body class="pagina-centrada">
<main class="tarjeta-login tarjeta-${esc(tono)}">
  <p class="marca-pequena">${m.logo ? `<img src="${esc(m.logo)}" alt="" class="logo-pequeno"> ` : ''}${esc(m.nombre)}</p>
  <div class="aviso-icono tono-${esc(tono)}">${svg(icono)}</div>
  <h1>${esc(titulo)}</h1>
  <p>${que}</p>
  ${hacer.length ? `<h2 class="subtitulo">Qué puedes hacer</h2><ul class="pasos">${hacer.map((h) => `<li>${h}</li>`).join('')}</ul>` : ''}
  <p class="acciones-pagina">${boton ? `<a class="btn" href="${esc(boton.href)}">${esc(boton.texto)}</a>` : ''}${enlace ? ` <a class="btn sec" href="${esc(enlace.href)}">${esc(enlace.texto)}</a>` : ''}</p>
</main>
</body>
</html>`;
}

// Casos del inicio de sesión. `que` y `hacer` pueden contener HTML: lo dinámico (correo) se escapa antes de entrar.
const PIDE_ACCESO = 'Pide acceso a un administrador del IPAM indicando tu correo.';
const casos = {
  dominio: ({ email }) => ({
    status: 403,
    titulo: 'Tu correo no tiene acceso',
    que: `Iniciaste sesión como <b>${esc(email)}</b>, pero el dominio de ese correo no está autorizado para usar este IPAM.`,
    hacer: ['Vuelve a entrar con tu cuenta corporativa (otra que la que usaste ahora).', PIDE_ACCESO],
    boton: { texto: 'Entrar con otra cuenta', href: '/login' },
  }),
  sin_rol: ({ email }) => ({
    status: 403,
    titulo: 'Tu cuenta aún no tiene un rol',
    que: `La cuenta <b>${esc(email)}</b> es válida, pero no tiene un rol asignado en el IPAM, así que no puede ver ni pedir nada.`,
    hacer: [PIDE_ACCESO, 'Cuando te lo confirmen, vuelve a entrar.'],
    boton: { texto: 'Volver a intentar', href: '/login' },
  }),
  correo_no_verificado: () => ({
    status: 403,
    titulo: 'Correo sin verificar',
    que: 'Tu proveedor de identidad no entregó un correo verificado, y el IPAM necesita saber quién eres.',
    hacer: ['Verifica el correo de tu cuenta en el proveedor (Google, Microsoft…) y vuelve a entrar.', 'Si ya está verificado, pide ayuda a un administrador.'],
    boton: { texto: 'Volver a intentar', href: '/login' },
  }),
  expirada: () => ({
    status: 400,
    titulo: 'La solicitud de inicio de sesión expiró',
    que: 'Tardaste más de 10 minutos en completar el inicio de sesión, o abriste el enlace de una sesión anterior.',
    hacer: ['Empieza de nuevo desde la pantalla de acceso.'],
    boton: { texto: 'Volver a entrar', href: '/login' },
  }),
  sesion_cerrada: () => ({
    status: 200,
    titulo: 'Sesión cerrada',
    icono: 'ok',
    tono: 'ok',
    que: 'Cerraste la sesión en este navegador. Si estás en un equipo compartido, cierra también la sesión de tu cuenta en el proveedor (Google, Microsoft…).',
    hacer: [],
    boton: { texto: 'Volver a entrar', href: '/login' },
  }),
  demasiados: ({ segundos }) => ({
    status: 429,
    titulo: 'Demasiados intentos',
    icono: 'info',
    que: `Hubo demasiados intentos de inicio de sesión desde tu conexión${segundos ? `. Podrás reintentar en unos <b>${esc(Math.ceil(segundos / 60))} min</b>` : ''}.`,
    hacer: ['Espera un momento y vuelve a intentarlo.', 'Si no eres tú quien insistió, avisa a un administrador.'],
    boton: { texto: 'Ir al acceso', href: '/login' },
  }),
};

// Envía la página de un caso con su código HTTP.
function enviar(res, caso, datos = {}) {
  const { status, ...opciones } = casos[caso](datos);
  res.status(status).type('html').set('Cache-Control', 'no-store').send(pagina(opciones));
}

module.exports = { pagina, enviar, esc };
