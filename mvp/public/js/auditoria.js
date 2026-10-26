// Pestaña «Auditoría» (solo admin): las últimas 200 acciones registradas.
import { esc, fechaHora, I, cargando, falla } from './util.js';
import { get } from './api.js';

export async function mostrar(panel) {
  cargando(panel);
  try {
    const registros = await get('/api/auditoria');
    panel.removeAttribute('aria-busy');
    panel.innerHTML = `<h2 tabindex="-1">Auditoría</h2>
      <p class="muted">Quién hizo qué y cuándo. Se muestran los últimos ${registros.length} registros; los más antiguos que la retención configurada se purgan.</p>
      <div class="card tablewrap" tabindex="0" role="region" aria-label="Auditoría">
        <table><thead><tr><th scope="col">Fecha</th><th scope="col">Usuario</th><th scope="col">Rol</th><th scope="col">Acción</th><th scope="col">Detalle</th></tr></thead>
        <tbody>${registros.map((x) => `<tr><td class="num">${fechaHora(x.ts)}</td><td>${esc(x.usuario)}</td><td>${esc(x.rol || '—')}</td><td>${esc(x.accion)}</td>
          <td><code>${esc(JSON.stringify(x.detalle))}</code></td></tr>`).join('')
    || `<tr><td colspan="5" class="muted">${I('info')} Aún no hay registros.</td></tr>`}</tbody></table>
      </div>`;
  } catch (e) { falla(panel, e, () => mostrar(panel)); }
}
