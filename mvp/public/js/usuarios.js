// Pestaña «Usuarios» (solo admin con OIDC): asignación de roles.
import { esc, fechaHora, I, cargando, falla } from './util.js';
import { api, get } from './api.js';
import { toast } from './ui.js';

const ROLES = ['lector', 'solicitante', 'admin'];

export async function mostrar(panel) {
  cargando(panel);
  try {
    const usuarios = await get('/api/usuarios');
    panel.removeAttribute('aria-busy');
    panel.innerHTML = `<h2 tabindex="-1">Usuarios</h2>
      <p class="muted">El rol asignado aquí rige en pocos minutos (se revalida cada 5 min), sin que la persona tenga que volver a entrar.
        «Heredar» usa los grupos y la configuración del proveedor.</p>
      <div class="card tablewrap" tabindex="0" role="region" aria-label="Usuarios">
        <table><thead><tr><th scope="col">Correo</th><th scope="col">Nombre</th><th scope="col">Último acceso</th><th scope="col">Rol asignado</th></tr></thead>
        <tbody>${usuarios.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.nombre)}</td><td>${u.ultimo_acceso ? fechaHora(u.ultimo_acceso) : '—'}</td>
          <td><select data-u="${esc(u.email)}" aria-label="Rol de ${esc(u.email)}"><option value="">Heredar</option>
            ${ROLES.map((r) => `<option ${u.rol === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td></tr>`).join('')
    || `<tr><td colspan="4" class="muted">${I('info')} Nadie ha iniciado sesión todavía.</td></tr>`}</tbody></table>
      </div>`;
    panel.querySelectorAll('select[data-u]').forEach((s) => {
      s.onchange = async () => {
        const r = await api(`/api/usuarios/${encodeURIComponent(s.dataset.u)}`, { method: 'PUT', body: { rol: s.value || null } });
        if (r.ok) toast(`Rol de ${s.dataset.u}: ${s.value || 'heredado'}.`);
        else toast((r.data && r.data.error) || 'No se pudo guardar el rol.', 'error');
        mostrar(panel);
      };
    });
  } catch (e) { falla(panel, e, () => mostrar(panel)); }
}
