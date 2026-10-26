// Acceso a la API y estado de la sesión. Todas las peticiones llevan X-Requested-With (defensa CSRF del servidor).
export const CABECERA = { 'X-Requested-With': 'ipam' };

export const sesion = { modo: 'none', rol: 'admin', usuario: '', nombre: '' };
const NIVEL = { lector: 0, solicitante: 1, admin: 2 };
export const puede = (minimo) => NIVEL[sesion.rol] >= NIVEL[minimo];

export const irAlAcceso = (error) =>
  { location.href = `/login?${error ? `error=${error}&` : ''}next=${encodeURIComponent(location.pathname)}`; };

// → { ok, status, data, total }  (total = cabecera X-Total-Count de las listas paginadas)
export async function api(url, opciones = {}) {
  const conCuerpo = opciones.body !== undefined;
  const respuesta = await fetch(url, {
    method: opciones.method || (conCuerpo ? 'POST' : 'GET'),
    headers: conCuerpo ? { 'Content-Type': 'application/json', ...CABECERA } : CABECERA,
    body: conCuerpo ? JSON.stringify(opciones.body) : undefined,
  });
  if (respuesta.status === 401 && sesion.modo === 'oidc') { irAlAcceso('sesion'); return { ok: false, status: 401, data: null, total: null }; }
  let data = null;
  try { data = await respuesta.json(); } catch { /* sin cuerpo JSON */ }
  const total = respuesta.headers.get('X-Total-Count');
  return { ok: respuesta.ok, status: respuesta.status, data, total: total === null ? null : Number(total) };
}

// GET que devuelve los datos o lanza un Error con un mensaje legible.
export async function get(url) {
  const r = await api(url);
  if (!r.ok) throw new Error(r.status === 401 ? 'tu sesión terminó' : `error ${r.status}`);
  return r.data;
}

export async function cargarSesion() {
  const r = await fetch('/api/me', { headers: CABECERA });
  if (r.status === 401) { irAlAcceso(); return false; }
  Object.assign(sesion, await r.json());
  return true;
}
